import { describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../../src/settings/manager.js";
import type { InteractionManager } from "../../src/interaction/manager.js";
import type { FeishuMessageReceiveEvent } from "../../src/feishu/event-router.js";
import type { OpenCodeSessionClient } from "../../src/feishu/handlers/session-resolution.js";
import {
  isOpenCodeSessionBusy,
  PromptIngressHandler,
  type OpenCodePromptAsyncClient,
  type OpenCodeSessionStatusClient,
} from "../../src/feishu/handlers/prompt.js";

function createMockSettings(overrides?: Partial<SettingsManager>): SettingsManager {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(undefined),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
    clearStatusMessageId: vi.fn(),
    getCurrentModel: vi.fn().mockReturnValue(undefined),
    getCurrentAgent: vi.fn().mockReturnValue(undefined),
    __resetSettingsForTests: vi.fn(),
    ...overrides,
  } as unknown as SettingsManager;
}

function createMockInteractionManager(overrides?: Partial<InteractionManager>): InteractionManager {
  return {
    resolveGuardDecision: vi.fn().mockReturnValue({ allow: true, inputType: "text", state: null }),
    startBusy: vi.fn(),
    clearBusy: vi.fn(),
    get: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
    isBusy: vi.fn().mockReturnValue(false),
    getBusyState: vi.fn().mockReturnValue(null),
    start: vi.fn(),
    transition: vi.fn(),
    clear: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue(null),
    isExpired: vi.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as InteractionManager;
}

function makeDmTextEvent(text: string): FeishuMessageReceiveEvent {
  return {
    header: { event_id: "evt-1", event_type: "im.message.receive_v1" },
    event: {
      message: {
        message_id: "msg-1",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
      sender: {
        sender_id: { open_id: "user-1" },
      },
    },
  };
}

describe("isOpenCodeSessionBusy", () => {
  it("returns true when any session has type busy", async () => {
    const client: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "busy" } },
        error: undefined,
      }),
    };

    expect(await isOpenCodeSessionBusy(client, "/workspace")).toBe(true);
  });

  it("returns true when any session has type retry", async () => {
    const client: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "retry", attempt: 3, message: "waiting", next: 5000 } },
        error: undefined,
      }),
    };

    expect(await isOpenCodeSessionBusy(client, "/workspace")).toBe(true);
  });

  it("returns false when all sessions are idle", async () => {
    const client: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" }, "sess-2": { type: "idle" } },
        error: undefined,
      }),
    };

    expect(await isOpenCodeSessionBusy(client, "/workspace")).toBe(false);
  });

  it("returns false (fail-open) when status API returns an error", async () => {
    const client: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: undefined,
        error: new Error("502 Bad Gateway"),
      }),
    };

    expect(await isOpenCodeSessionBusy(client, "/workspace")).toBe(false);
  });

  it("returns false (fail-open) when status API throws", async () => {
    const client: OpenCodeSessionStatusClient = {
      status: vi.fn().mockRejectedValue(new Error("network reset")),
    };

    expect(await isOpenCodeSessionBusy(client, "/workspace")).toBe(false);
  });
});

describe("PromptIngressHandler busy paths", () => {
  it("blocks when interaction guard says no", async () => {
    const settings = createMockSettings();
    const interactionManager = createMockInteractionManager({
      resolveGuardDecision: vi.fn().mockReturnValue({
        allow: false,
        inputType: "text",
        state: null,
        reason: "expected_text",
        busy: true,
      }),
    });
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = { status: vi.fn() };
    const openCodePromptAsync: OpenCodePromptAsyncClient = { promptAsync: vi.fn() };

    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
    });

    const result = await handler.handleMessageEvent(makeDmTextEvent("blocked by guard"));

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") {
      throw new Error("unexpected result kind");
    }
    expect(result.reason).toBe("expected_text");
    expect(result.guardDecision?.busy).toBe(true);
    expect(openCodePromptAsync.promptAsync).not.toHaveBeenCalled();
  });

  it("blocks when OpenCode session status is busy", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getCurrentSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "S",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "busy" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = { promptAsync: vi.fn() };

    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
    });

    const result = await handler.handleMessageEvent(makeDmTextEvent("while busy"));

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") {
      throw new Error("unexpected result kind");
    }
    expect(result.reason).toBe("session_busy");
    expect(interactionManager.startBusy).not.toHaveBeenCalled();
    expect(openCodePromptAsync.promptAsync).not.toHaveBeenCalled();
  });

  it("does not block when session.status() API fails (fail-open)", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getCurrentSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "S",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: undefined,
        error: new Error("connection refused"),
      }),
    };
    const promptAsyncCalls: Array<unknown[]> = [];
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockImplementation(async (params) => {
        promptAsyncCalls.push(params);
      }),
    };

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    const result = await handler.handleMessageEvent(makeDmTextEvent("fail-open"));

    expect(result.kind).toBe("dispatched");
    for (const task of scheduledTasks) {
      await task();
    }
    expect(promptAsyncCalls).toHaveLength(1);
  });

  it("blocks when session creation fails", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn().mockResolvedValue({
        data: undefined,
        error: new Error("server error"),
      }),
    };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = { status: vi.fn() };
    const openCodePromptAsync: OpenCodePromptAsyncClient = { promptAsync: vi.fn() };

    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
    });

    const result = await handler.handleMessageEvent(makeDmTextEvent("create fails"));

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") {
      throw new Error("unexpected result kind");
    }
    expect(result.reason).toBe("session_creation_failed");
    expect(openCodePromptAsync.promptAsync).not.toHaveBeenCalled();
  });
});
