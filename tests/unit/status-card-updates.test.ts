import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponsePipelineController } from "../../src/feishu/response-pipeline.js";
import type { ImageResolverLike } from "../../src/feishu/image-resolver.js";
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

function createHarness(options?: {
  imageResolver?: ImageResolverLike;
  recreateInterval?: number;
  recentUpdatesCount?: number;
}) {
  const statusStore = new StatusStore();
  let callbacks: SummaryCallbacks | undefined;

  const renderStatusCard = vi
    .fn<Renderer["renderStatusCard"]>()
    .mockResolvedValue("status-card-1");
  const updateStatusCard = vi
    .fn<Renderer["updateStatusCard"]>()
    .mockResolvedValue(undefined);
  const deleteMessage = vi
    .fn<Renderer["deleteMessage"]>()
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
    deleteMessage,
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
    imageResolver: options?.imageResolver,
    settingsManager,
    interactionManager,
    statusStore,
    logger,
    scheduleAsync: (task): void => task(),
    setTimeoutFn,
    clearTimeoutFn,
    config: {
      throttle: {
        statusCardUpdateIntervalMs: 1_000,
        statusCardPatchRetryDelayMs: 25,
        statusCardPatchMaxAttempts: 3,
      },
      statusCard: {
        recreateInterval: options?.recreateInterval ?? 5,
        recentUpdatesCount: options?.recentUpdatesCount ?? 5,
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

describe("ResponsePipelineController status card throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches multiple partial events into one throttled status card update", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(context.sessionId, "assistant-msg-1", "Hel");
    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Hello",
    );
    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Hello world",
    );

    expect(harness.renderer.updateStatusCard).not.toHaveBeenCalled();
    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.renderer.updateStatusCard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.updateStatusCard).toHaveBeenCalledWith(
      "status-card-1",
      "OpenCode is working",
      expect.stringContaining("Hello world"),
      false,
      "blue",
    );
  });

  it("schedules only one timer at a time while partials keep arriving", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(context.sessionId, "assistant-msg-1", "A");
    harness.callbacks.onPartial?.(context.sessionId, "assistant-msg-1", "AB");
    harness.callbacks.onPartial?.(context.sessionId, "assistant-msg-1", "ABC");

    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(1);

    harness.callbacks.onPartial?.(context.sessionId, "assistant-msg-1", "ABCD");

    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(2);
  });

  it("skips duplicate PATCH calls when the latest content is already patched", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Latest partial",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await drainSession(harness.controller, context.sessionId);

    const state = harness.statusStore.get(context.sessionId);
    expect(state?.lastPatchedText).toContain("Latest partial");
    expect(state?.lastPatchedSignature).toBeDefined();

    harness.renderer.updateStatusCard.mockClear();

    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Latest partial",
    );
    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.updateStatusCard).not.toHaveBeenCalled();
    expect(harness.renderer.updateCompleteCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
  });

  it("flushes a pending status timer before finalizing the status card", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Queued partial",
    );
    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Final reply",
    );
    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.clearTimeoutFn).toHaveBeenCalledTimes(1);
    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(1);
    expect(
      harness.renderer.updateStatusCard.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.renderer.updateCompleteCard.mock.invocationCallOrder[0],
    );
    expect(harness.renderer.updateCompleteCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(1);
  });

  it("resolves images during streaming status updates", async () => {
    const mockImageResolver = {
      resolveImages: vi.fn((text: string) =>
        text.replace("![img](http://pending)", "![img](img_resolved)"),
      ),
      resolveImagesAwait: vi.fn((text: string) =>
        Promise.resolve(
          text.replace("![img](http://pending)", "![img](img_resolved)"),
        ),
      ),
    };
    const harness = createHarness({ imageResolver: mockImageResolver });
    const context = makeTurnContext();

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Hello ![img](http://pending)",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await drainSession(harness.controller, context.sessionId);

    expect(mockImageResolver.resolveImages).toHaveBeenCalled();
    expect(harness.renderer.updateStatusCard).toHaveBeenCalledWith(
      "status-card-1",
      "OpenCode is working",
      expect.stringContaining("Hello ![img](img_resolved)"),
      false,
      "blue",
    );
  });

  it("recreates the status card after the configured update interval", async () => {
    const harness = createHarness({ recreateInterval: 2 });
    const context = makeTurnContext();

    harness.renderer.renderStatusCard
      .mockResolvedValueOnce("status-card-1")
      .mockResolvedValueOnce("status-card-2");

    await createLiveStatusCard(harness, context);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "First",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.updateStatusCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.deleteMessage).not.toHaveBeenCalled();

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Second",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.renderStatusCard).toHaveBeenCalledTimes(2);
    expect(harness.renderer.renderStatusCard).toHaveBeenLastCalledWith(
      context.receiveId,
      "OpenCode is working",
      expect.stringContaining("Second"),
      false,
      "blue",
    );
    expect(harness.renderer.deleteMessage).toHaveBeenCalledWith(
      "status-card-1",
    );
    expect(
      harness.settingsManager.setChatStatusMessageId,
    ).toHaveBeenLastCalledWith(context.receiveId, "status-card-2");
    expect(
      harness.statusStore.get(context.sessionId)?.statusCardMessageId,
    ).toBe("status-card-2");
  });
});
