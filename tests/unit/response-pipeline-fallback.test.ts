import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResponsePipelineController,
  isRetryableStatusCardUpdateError,
} from "../../src/feishu/response-pipeline.js";
import {
  StatusStore,
  type ResponsePipelineTurnContext,
} from "../../src/feishu/status-store.js";
import type { SummaryCallbacks } from "../../src/summary/types.js";

vi.mock("../../src/opencode/events.js", () => ({
  openCodeEventSubscriber: {
    subscribeToEvents: vi.fn(),
  },
}));

type ControllerOptions = ConstructorParameters<
  typeof ResponsePipelineController
>[0];
type EventSubscriber = NonNullable<ControllerOptions["eventSubscriber"]>;
type SummaryAggregator = NonNullable<ControllerOptions["summaryAggregator"]>;
type Renderer = ControllerOptions["renderer"];
type SettingsManager = ControllerOptions["settingsManager"];
type InteractionManager = ControllerOptions["interactionManager"];
type Logger = NonNullable<ControllerOptions["logger"]>;

function makeTurnContext(
  sessionId: string = "session-1",
): ResponsePipelineTurnContext {
  return {
    sessionId,
    directory: `/workspace/${sessionId}`,
    receiveId: `chat-${sessionId}`,
    sourceMessageId: `source-${sessionId}`,
  };
}

function createHarness() {
  const statusStore = new StatusStore();
  let callbacks: SummaryCallbacks | undefined;

  const renderStatusCard = vi
    .fn<Renderer["renderStatusCard"]>()
    .mockResolvedValue("status-card-1");
  const updateStatusCard = vi
    .fn<Renderer["updateStatusCard"]>()
    .mockResolvedValue(undefined);
  const renderCompleteCard = vi
    .fn<Renderer["renderCompleteCard"]>()
    .mockResolvedValue("complete-card-1");
  const updateCompleteCard = vi
    .fn<Renderer["updateCompleteCard"]>()
    .mockResolvedValue(undefined);
  const replyPost = vi
    .fn<Renderer["replyPost"]>()
    .mockResolvedValue("reply-msg-1");
  const sendPost = vi
    .fn<Renderer["sendPost"]>()
    .mockResolvedValue("send-msg-1");

  const renderer = {
    renderStatusCard,
    updateStatusCard,
    renderCompleteCard,
    updateCompleteCard,
    replyPost,
    sendPost,
  } satisfies Renderer;

  const summaryAggregator = {
    setCallbacks: vi.fn((nextCallbacks: SummaryCallbacks): void => {
      callbacks = nextCallbacks;
    }),
    setSession: vi.fn((sessionId: string): void => {
      void sessionId;
    }),
    processEvent: vi.fn((): void => undefined),
  } satisfies SummaryAggregator;

  const eventSubscriber = {
    subscribeToEvents: vi
      .fn<EventSubscriber["subscribeToEvents"]>()
      .mockImplementation(() => new Promise<void>(() => undefined)),
  } satisfies EventSubscriber;

  const settingsManager = {
    setChatStatusMessageId: vi.fn((chatId: string, messageId: string): void => {
      void chatId;
      void messageId;
    }),
    clearChatStatusMessageId: vi.fn((chatId: string): void => {
      void chatId;
    }),
  } satisfies SettingsManager;

  const interactionManager = {
    clearBusy: vi.fn((chatId: string): void => {
      void chatId;
    }),
  } satisfies InteractionManager;

  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const logger = {
    info: (...args: unknown[]): void => void info(...args),
    warn: (...args: unknown[]): void => void warn(...args),
    error: (...args: unknown[]): void => void error(...args),
    debug: (...args: unknown[]): void => void debug(...args),
  } satisfies Logger;

  const setTimeoutSpy = vi.fn(
    (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> =>
      setTimeout(...args),
  );
  const setTimeoutFn = Object.assign(
    ((...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> =>
      setTimeoutSpy(...args)) as typeof setTimeout,
    {
      __promisify__: setTimeout.__promisify__,
    },
  );
  const clearTimeoutFn = vi.fn(
    (
      ...args: Parameters<typeof clearTimeout>
    ): ReturnType<typeof clearTimeout> => clearTimeout(...args),
  );

  const controller = new ResponsePipelineController({
    eventSubscriber,
    summaryAggregator,
    renderer,
    settingsManager,
    interactionManager,
    statusStore,
    logger,
    scheduleAsync: (task): void => task(),
    setTimeoutFn,
    clearTimeoutFn,
    config: {
      throttle: {
        statusCardUpdateIntervalMs: 50,
        statusCardPatchRetryDelayMs: 10,
        statusCardPatchMaxAttempts: 3,
      },
    },
  });

  if (!callbacks) {
    throw new Error("summary callbacks were not captured");
  }

  return {
    controller,
    callbacks,
    statusStore,
    renderer,
    settingsManager,
    interactionManager,
    logger,
    setTimeoutFn: setTimeoutSpy,
    clearTimeoutFn,
  };
}

async function drainSession(
  controller: ResponsePipelineController,
  sessionId: string,
): Promise<void> {
  await controller.enqueueSessionTask(sessionId, async () => undefined);
}

async function createLiveStatusCard(
  harness: ReturnType<typeof createHarness>,
  context: ResponsePipelineTurnContext,
): Promise<void> {
  harness.controller.startTurn(context);
  harness.callbacks.onTypingStart?.(context.sessionId);
  await drainSession(harness.controller, context.sessionId);
}

describe("ResponsePipelineController fallback behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects retryable status card update errors by status code and message", () => {
    expect(isRetryableStatusCardUpdateError({ status: 429 })).toBe(true);
    expect(
      isRetryableStatusCardUpdateError(
        new Error("rate limit exceeded, retry later"),
      ),
    ).toBe(true);
    expect(isRetryableStatusCardUpdateError(new Error("bad request"))).toBe(
      false,
    );
  });

  it("marks card updates broken when status card creation fails, but still sends a standalone complete card", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.renderer.renderStatusCard.mockRejectedValueOnce(
      new Error("card create failed"),
    );

    harness.controller.startTurn(context);
    harness.callbacks.onTypingStart?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.statusStore.get(context.sessionId)?.cardUpdatesBroken).toBe(
      true,
    );
    expect(
      harness.statusStore.get(context.sessionId)?.statusCardMessageId,
    ).toBeUndefined();

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "ignored partial",
    );
    expect(harness.setTimeoutFn).not.toHaveBeenCalled();

    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Final reply",
    );
    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.renderCompleteCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
    expect(harness.renderer.sendPost).not.toHaveBeenCalled();
    expect(
      harness.settingsManager.clearChatStatusMessageId,
    ).toHaveBeenCalledWith(context.receiveId);
    expect(harness.interactionManager.clearBusy).toHaveBeenCalledWith(
      context.receiveId,
    );
  });

  it("breaks card updates on non-retryable patch failures and sends a standalone complete card", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.renderer.updateStatusCard.mockRejectedValueOnce(
      new Error("bad request"),
    );

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Partial update",
    );
    await vi.advanceTimersByTimeAsync(50);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(1);
    expect(harness.statusStore.get(context.sessionId)?.cardUpdatesBroken).toBe(
      true,
    );

    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Final reply",
    );
    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.renderCompleteCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
    expect(harness.renderer.sendPost).not.toHaveBeenCalled();
  });

  it("retries retryable patch failures up to the configured max attempts, then falls back to a standalone complete card", async () => {
    const harness = createHarness();
    const context = makeTurnContext();
    const retryableError = { status: 429, message: "rate limit" };

    harness.renderer.updateStatusCard.mockRejectedValue(retryableError);

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Retry me",
    );
    await vi.advanceTimersByTimeAsync(80);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(3);
    expect(harness.statusStore.get(context.sessionId)?.cardUpdatesBroken).toBe(
      true,
    );

    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Final reply",
    );
    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.renderCompleteCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
    expect(harness.renderer.sendPost).not.toHaveBeenCalled();
  });

  it("falls back to post delivery when complete card delivery fails", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.renderer.renderCompleteCard.mockRejectedValueOnce(
      new Error("complete card failed"),
    );
    harness.renderer.replyPost.mockRejectedValueOnce(
      new Error("thread reply failed"),
    );

    harness.controller.startTurn(context);
    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Fallback reply",
    );
    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.replyPost).toHaveBeenCalledTimes(1);
    expect(harness.renderer.sendPost).toHaveBeenCalledTimes(1);
    expect(harness.renderer.sendPost).toHaveBeenCalledWith(
      context.receiveId,
      "OpenCode reply",
      [["Fallback reply"]],
    );
    expect(
      harness.settingsManager.clearChatStatusMessageId,
    ).toHaveBeenCalledWith(context.receiveId);
    expect(harness.interactionManager.clearBusy).toHaveBeenCalledWith(
      context.receiveId,
    );
  });
});
