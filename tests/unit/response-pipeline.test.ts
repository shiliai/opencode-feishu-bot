import type { Event } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SessionMessageFetcher,
  ResponsePipelineController,
} from "../../src/feishu/response-pipeline.js";
import {
  StatusStore,
  type ResponsePipelineTurnContext,
} from "../../src/feishu/status-store.js";
import type {
  SummaryCallbacks,
  SummarySessionDiffEvent,
  SummaryTokenEvent,
  SummaryToolEvent,
} from "../../src/summary/types.js";

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

  const setCallbacks = vi.fn((nextCallbacks: SummaryCallbacks): void => {
    callbacks = nextCallbacks;
  });
  const setSession = vi.fn((sessionId: string): void => {
    void sessionId;
  });
  const processEvent = vi.fn((event: Event): void => {
    void event;
  });

  const summaryAggregator = {
    setCallbacks,
    setSession,
    processEvent,
  } satisfies SummaryAggregator;

  const subscribeToEvents = vi
    .fn<EventSubscriber["subscribeToEvents"]>()
    .mockImplementation(() => new Promise<void>(() => undefined));

  const eventSubscriber = {
    subscribeToEvents,
  } satisfies EventSubscriber;

  const settingsManager = {
    setStatusMessageId: vi.fn((messageId: string): void => {
      void messageId;
    }),
    clearStatusMessageId: vi.fn((): void => undefined),
  } satisfies SettingsManager;

  const interactionManager = {
    clearBusy: vi.fn((): void => undefined),
  } satisfies InteractionManager;

  const fetchLastAssistantMessage = vi
    .fn<SessionMessageFetcher["fetchLastAssistantMessage"]>()
    .mockResolvedValue(undefined);

  const sessionMessageFetcher = {
    fetchLastAssistantMessage,
  } satisfies SessionMessageFetcher;

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
    sessionMessageFetcher,
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
        statusCardUpdateIntervalMs: 1_000,
        statusCardPatchRetryDelayMs: 25,
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
    summaryAggregator,
    eventSubscriber,
    settingsManager,
    interactionManager,
    sessionMessageFetcher,
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

describe("ResponsePipelineController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startTurn stores state, sets the active session, and begins the event subscription", () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.controller.startTurn(context);

    const state = harness.statusStore.get(context.sessionId);
    expect(state).toMatchObject({
      ...context,
      pendingCompletion: false,
      cardUpdatesBroken: false,
      finalReplySent: false,
      toolEvents: [],
      diffs: [],
    });
    expect(state?.subscriptionAbortController).toBeInstanceOf(AbortController);
    expect(harness.summaryAggregator.setSession).toHaveBeenCalledWith(
      context.sessionId,
    );
    expect(harness.eventSubscriber.subscribeToEvents).toHaveBeenCalledWith(
      context.directory,
      expect.any(Function),
      { signal: state?.subscriptionAbortController?.signal },
    );
    expect(
      harness.summaryAggregator.setSession.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.eventSubscriber.subscribeToEvents.mock.invocationCallOrder[0],
    );

    const eventCallback =
      harness.eventSubscriber.subscribeToEvents.mock.calls[0]?.[1];
    const event = { type: "message.updated", properties: {} } as Event;
    eventCallback?.(event);

    expect(harness.summaryAggregator.processEvent).toHaveBeenCalledWith(event);
  });

  it("handleTypingStart renders a status card and persists its message id", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.controller.startTurn(context);
    harness.callbacks.onTypingStart?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    const state = harness.statusStore.get(context.sessionId);
    expect(harness.renderer.renderStatusCard).toHaveBeenCalledWith(
      context.receiveId,
      "OpenCode is working",
      "Thinking…",
      false,
      "blue",
    );
    expect(state?.statusCardMessageId).toBe("status-card-1");
    expect(state?.lastPatchedText).toBe("Thinking…");
    expect(state?.lastPatchedSignature).toBeDefined();
    expect(harness.settingsManager.setStatusMessageId).toHaveBeenCalledWith(
      "status-card-1",
    );
  });

  it("session idle finalizes the existing status card and clears turn resources", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.controller.startTurn(context);
    const startedState = harness.statusStore.get(context.sessionId);
    harness.callbacks.onTypingStart?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Working draft",
    );
    expect(harness.renderer.updateStatusCard).not.toHaveBeenCalled();

    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "Final answer\nSecond line",
    );
    await drainSession(harness.controller, context.sessionId);
    expect(harness.renderer.updateCompleteCard).not.toHaveBeenCalled();

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
    expect(harness.renderer.updateCompleteCard).toHaveBeenCalledWith(
      "status-card-1",
      "OpenCode reply",
      "Final answer\nSecond line",
      expect.objectContaining({
        template: "green",
      }),
    );
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
    expect(harness.renderer.sendPost).not.toHaveBeenCalled();
    expect(harness.settingsManager.clearStatusMessageId).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.interactionManager.clearBusy).toHaveBeenCalledTimes(1);
    expect(harness.statusStore.get(context.sessionId)).toBeUndefined();
    expect(startedState?.subscriptionAbortController?.signal.aborted).toBe(
      true,
    );
  });

  it("uses the latest completed assistant message when the session goes idle", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.controller.startTurn(context);

    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-1",
      "First reply",
    );
    harness.callbacks.onComplete?.(
      context.sessionId,
      "assistant-msg-2",
      "Second reply",
    );
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.renderCompleteCard).not.toHaveBeenCalled();

    harness.callbacks.onSessionIdle?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    expect(harness.renderer.renderCompleteCard).toHaveBeenCalledTimes(1);
    expect(harness.renderer.renderCompleteCard).toHaveBeenCalledWith(
      context.receiveId,
      "OpenCode reply",
      "Second reply",
      expect.objectContaining({
        template: "green",
      }),
    );
  });

  it("handleSessionError falls back to a standalone error card when status updates are broken", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.controller.startTurn(context);
    harness.callbacks.onTypingStart?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Still thinking",
    );
    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(1);

    harness.callbacks.onSessionError?.(context.sessionId, "pipeline failed");
    await drainSession(harness.controller, context.sessionId);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.renderer.renderCompleteCard).toHaveBeenCalledWith(
      context.receiveId,
      "OpenCode error",
      "pipeline failed",
      expect.objectContaining({
        template: "red",
      }),
    );
    expect(harness.renderer.updateCompleteCard).not.toHaveBeenCalled();
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
    expect(harness.renderer.updateStatusCard).not.toHaveBeenCalled();
    expect(harness.clearTimeoutFn).toHaveBeenCalledTimes(1);
    expect(harness.settingsManager.clearStatusMessageId).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.interactionManager.clearBusy).toHaveBeenCalledTimes(1);
    expect(harness.statusStore.get(context.sessionId)).toBeUndefined();
  });

  it("handlePartial deduplicates identical partial text and only schedules on signature changes", async () => {
    const harness = createHarness();
    const context = makeTurnContext();

    harness.controller.startTurn(context);
    harness.callbacks.onTypingStart?.(context.sessionId);
    await drainSession(harness.controller, context.sessionId);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Hello",
    );
    const state = harness.statusStore.get(context.sessionId);
    const firstSignature = state?.lastPartialSignature;

    expect(state?.lastPartialText).toBe("Hello");
    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(1);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Hello",
    );
    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(
      harness.statusStore.get(context.sessionId)?.lastPartialSignature,
    ).toBe(firstSignature);

    harness.callbacks.onPartial?.(
      context.sessionId,
      "assistant-msg-1",
      "Hello there",
    );
    expect(harness.setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(harness.statusStore.get(context.sessionId)?.lastPartialText).toBe(
      "Hello there",
    );
    expect(
      harness.statusStore.get(context.sessionId)?.lastPartialSignature,
    ).not.toBe(firstSignature);
  });

  it("stores tool events, session diffs, and token updates in the turn state", () => {
    const harness = createHarness();
    const context = makeTurnContext();
    const toolEventOne: SummaryToolEvent = {
      sessionId: context.sessionId,
      messageId: "assistant-msg-1",
      callId: "call-1",
      tool: "apply_patch",
      status: "completed",
    };
    const toolEventTwo: SummaryToolEvent = {
      sessionId: context.sessionId,
      messageId: "assistant-msg-2",
      callId: "call-2",
      tool: "write",
      status: "completed",
    };
    const diffEvent: SummarySessionDiffEvent = {
      sessionId: context.sessionId,
      diffs: [{ file: "src/updated.ts", additions: 3, deletions: 1 }],
    };
    const tokenEvent: SummaryTokenEvent = {
      sessionId: context.sessionId,
      messageId: "assistant-msg-2",
      tokens: {
        input: 10,
        output: 20,
        reasoning: 5,
        cacheRead: 2,
        cacheWrite: 1,
      },
      isCompleted: true,
    };

    harness.controller.startTurn(context);
    harness.callbacks.onTool?.(toolEventOne);
    harness.callbacks.onTool?.(toolEventTwo);
    harness.callbacks.onSessionDiff?.(diffEvent);
    harness.callbacks.onTokenUpdate?.(tokenEvent);

    expect(harness.statusStore.get(context.sessionId)).toMatchObject({
      toolEvents: [toolEventOne, toolEventTwo],
      diffs: diffEvent.diffs,
      latestTokens: tokenEvent.tokens,
    });
  });

  it("handleAggregatorCleared clears all turn state and disposes turn resources", async () => {
    const harness = createHarness();
    const firstContext = makeTurnContext("session-1");
    const secondContext = makeTurnContext("session-2");

    harness.controller.startTurn(firstContext);
    harness.controller.startTurn(secondContext);
    harness.callbacks.onTypingStart?.(firstContext.sessionId);
    await drainSession(harness.controller, firstContext.sessionId);
    harness.callbacks.onPartial?.(
      firstContext.sessionId,
      "assistant-msg-1",
      "Queued update",
    );

    const firstState = harness.statusStore.get(firstContext.sessionId);
    const secondState = harness.statusStore.get(secondContext.sessionId);

    harness.callbacks.onCleared?.();

    expect(harness.controller.getSnapshot().activeSessions).toEqual([]);
    expect(harness.statusStore.get(firstContext.sessionId)).toBeUndefined();
    expect(harness.statusStore.get(secondContext.sessionId)).toBeUndefined();
    expect(firstState?.subscriptionAbortController?.signal.aborted).toBe(true);
    expect(secondState?.subscriptionAbortController?.signal.aborted).toBe(true);
    expect(harness.clearTimeoutFn).toHaveBeenCalledTimes(1);
  });

  describe("session idle API message fetch", () => {
    it("prefers API-fetched message text over event-based text when session goes idle", async () => {
      const harness = createHarness();
      const context = makeTurnContext();

      harness.sessionMessageFetcher.fetchLastAssistantMessage.mockResolvedValue(
        {
          info: {
            id: "api-msg-2",
            sessionID: context.sessionId,
            role: "assistant",
          },
          parts: [
            { type: "text", text: "API fetched final summary" },
            { type: "tool" },
            { type: "text", text: " with more content" },
          ],
        },
      );

      harness.controller.startTurn(context);
      harness.callbacks.onTypingStart?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      harness.callbacks.onComplete?.(
        context.sessionId,
        "assistant-msg-1",
        "Event-based stale text",
      );
      await drainSession(harness.controller, context.sessionId);

      harness.callbacks.onSessionIdle?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      expect(
        harness.sessionMessageFetcher.fetchLastAssistantMessage,
      ).toHaveBeenCalledWith(context.sessionId, context.directory);

      expect(harness.renderer.updateCompleteCard).toHaveBeenCalledWith(
        "status-card-1",
        "OpenCode reply",
        "API fetched final summary with more content",
        expect.objectContaining({ template: "green" }),
      );
    });

    it("falls back to event-based text when API returns undefined", async () => {
      const harness = createHarness();
      const context = makeTurnContext();

      harness.sessionMessageFetcher.fetchLastAssistantMessage.mockResolvedValue(
        undefined,
      );

      harness.controller.startTurn(context);

      harness.callbacks.onComplete?.(
        context.sessionId,
        "assistant-msg-1",
        "Event fallback text",
      );
      await drainSession(harness.controller, context.sessionId);

      harness.callbacks.onSessionIdle?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      expect(harness.renderer.renderCompleteCard).toHaveBeenCalledWith(
        context.receiveId,
        "OpenCode reply",
        "Event fallback text",
        expect.objectContaining({ template: "green" }),
      );
    });

    it("falls back to event-based text when API returns empty text", async () => {
      const harness = createHarness();
      const context = makeTurnContext();

      harness.sessionMessageFetcher.fetchLastAssistantMessage.mockResolvedValue(
        {
          info: {
            id: "api-msg-1",
            sessionID: context.sessionId,
            role: "assistant",
          },
          parts: [{ type: "tool" }],
        },
      );

      harness.controller.startTurn(context);

      harness.callbacks.onComplete?.(
        context.sessionId,
        "assistant-msg-1",
        "Event text wins",
      );
      await drainSession(harness.controller, context.sessionId);

      harness.callbacks.onSessionIdle?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      expect(harness.renderer.renderCompleteCard).toHaveBeenCalledWith(
        context.receiveId,
        "OpenCode reply",
        "Event text wins",
        expect.objectContaining({ template: "green" }),
      );
    });

    it("falls back to event-based text when API call throws", async () => {
      const harness = createHarness();
      const context = makeTurnContext();

      harness.sessionMessageFetcher.fetchLastAssistantMessage.mockRejectedValue(
        new Error("API timeout"),
      );

      harness.controller.startTurn(context);

      harness.callbacks.onComplete?.(
        context.sessionId,
        "assistant-msg-1",
        "Resilient event text",
      );
      await drainSession(harness.controller, context.sessionId);

      harness.callbacks.onSessionIdle?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      expect(harness.renderer.renderCompleteCard).toHaveBeenCalledWith(
        context.receiveId,
        "OpenCode reply",
        "Resilient event text",
        expect.objectContaining({ template: "green" }),
      );
    });

    it("falls back to partial text when neither API nor onComplete provides content", async () => {
      const harness = createHarness();
      const context = makeTurnContext();

      harness.sessionMessageFetcher.fetchLastAssistantMessage.mockResolvedValue(
        undefined,
      );

      harness.controller.startTurn(context);
      harness.callbacks.onTypingStart?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      harness.callbacks.onPartial?.(
        context.sessionId,
        "assistant-msg-1",
        "Partial draft text",
      );

      harness.callbacks.onSessionIdle?.(context.sessionId);
      await drainSession(harness.controller, context.sessionId);

      expect(
        harness.sessionMessageFetcher.fetchLastAssistantMessage,
      ).toHaveBeenCalledWith(context.sessionId, context.directory);

      expect(harness.renderer.updateCompleteCard).toHaveBeenCalledWith(
        "status-card-1",
        "OpenCode reply",
        "Partial draft text",
        expect.objectContaining({ template: "green" }),
      );
    });
  });
});
