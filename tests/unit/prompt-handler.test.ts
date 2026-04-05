import { describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../../src/settings/manager.js";
import type { InteractionManager } from "../../src/interaction/manager.js";
import type { FeishuMessageReceiveEvent } from "../../src/feishu/event-router.js";
import type { OpenCodeSessionClient } from "../../src/feishu/handlers/session-resolution.js";
import {
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

function createMockInteractionManager(): InteractionManager {
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

function makeGroupMentionEvent(text: string, botOpenId: string): FeishuMessageReceiveEvent {
  return {
    header: { event_id: "evt-2", event_type: "im.message.receive_v1" },
    event: {
      message: {
        message_id: "msg-2",
        chat_id: "chat-2",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: `@_user_1 ${text}` }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: botOpenId, union_id: undefined, user_id: undefined },
            name: "OpenCodeBot",
            tenant_key: "tenant-1",
          },
        ],
      },
      sender: {
        sender_id: { open_id: "user-2" },
      },
    },
  };
}

describe("PromptIngressHandler", () => {
  it("dispatches a DM text prompt and returns immediately without awaiting promptAsync", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn().mockResolvedValue({
        data: { id: "sess-1", title: "Session", directory: "/workspace/project" },
        error: undefined,
      }),
    };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({ data: { "sess-1": { type: "idle" } }, error: undefined }),
    };

    let promptAsyncCalled = false;
    let promptAsyncResolved = false;
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockImplementation(async () => {
        promptAsyncCalled = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        promptAsyncResolved = true;
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

    const result = await handler.handleMessageEvent(makeDmTextEvent("Hello, fix the bug"));

    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") {
      throw new Error("unexpected result kind");
    }
    expect(result.sessionId).toBe("sess-1");
    expect(result.directory).toBe("/workspace/project");
    expect(result.text).toBe("Hello, fix the bug");
    expect(promptAsyncCalled).toBe(false);

    for (const task of scheduledTasks) {
      await task();
    }

    expect(promptAsyncCalled).toBe(true);
    expect(promptAsyncResolved).toBe(true);
    expect(interactionManager.startBusy).toHaveBeenCalledWith({ messageId: "msg-1" });
  });

  it("dispatches a group-mention text prompt and strips @_user_N placeholders", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getCurrentSession: vi.fn().mockReturnValue({
        id: "sess-existing",
        title: "Existing",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn(),
    };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({ data: { "sess-existing": { type: "idle" } }, error: undefined }),
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
      botOpenId: "bot-open-id",
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    const result = await handler.handleMessageEvent(
      makeGroupMentionEvent("fix the types", "bot-open-id"),
    );

    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") {
      throw new Error("unexpected result kind");
    }
    expect(result.text).toBe("fix the types");

    for (const task of scheduledTasks) {
      await task();
    }

    expect(promptAsyncCalls).toHaveLength(1);
    const callParams = promptAsyncCalls[0] as Record<string, unknown>;
    expect(callParams.sessionID).toBe("sess-existing");
    expect((callParams.parts as Array<{ type: string; text: string }>).map((p) => p.text)).toEqual([
      "fix the types",
    ]);
  });

  it("threads current model and agent into promptAsync when available", async () => {
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
      getCurrentModel: vi.fn().mockReturnValue({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "beta",
      }),
      getCurrentAgent: vi.fn().mockReturnValue("build"),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({ data: { "sess-1": { type: "idle" } }, error: undefined }),
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

    const result = await handler.handleMessageEvent(makeDmTextEvent("test model threading"));

    expect(result.kind).toBe("dispatched");
    for (const task of scheduledTasks) {
      await task();
    }

    expect(promptAsyncCalls).toHaveLength(1);
    const callParams = promptAsyncCalls[0] as Record<string, unknown>;
    expect(callParams.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-20250514" });
    expect(callParams.agent).toBe("build");
    expect(callParams.variant).toBe("beta");
  });

  it("clears busy state on async prompt error", async () => {
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
      status: vi.fn().mockResolvedValue({ data: { "sess-1": { type: "idle" } }, error: undefined }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockRejectedValue(new Error("network failure")),
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

    const result = await handler.handleMessageEvent(makeDmTextEvent("trigger error"));

    expect(result.kind).toBe("dispatched");

    for (const task of scheduledTasks) {
      await task();
    }

    expect(interactionManager.clearBusy).toHaveBeenCalledTimes(1);
  });

  it("returns no-project when no current project is configured", async () => {
    const settings = createMockSettings();
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn(),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn(),
    };

    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
    });

    const result = await handler.handleMessageEvent(makeDmTextEvent("no project"));

    expect(result).toEqual({ kind: "no-project" });
  });

  it("returns session-reset when directory mismatches and does not dispatch", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-new",
        worktree: "/workspace/new",
      }),
      getCurrentSession: vi.fn().mockReturnValue({
        id: "sess-old",
        title: "Old",
        directory: "/workspace/old",
      }),
    });
    const interactionManager = createMockInteractionManager();
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

    const result = await handler.handleMessageEvent(makeDmTextEvent("mismatch"));

    expect(result).toEqual({
      kind: "session-reset",
      previousDirectory: "/workspace/old",
      currentDirectory: "/workspace/new",
    });
    expect(openCodePromptAsync.promptAsync).not.toHaveBeenCalled();
  });

  it("returns ignored-no-mention for group messages without bot mention", async () => {
    const settings = createMockSettings();
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = { status: vi.fn() };
    const openCodePromptAsync: OpenCodePromptAsyncClient = { promptAsync: vi.fn() };

    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      botOpenId: "bot-123",
    });

    const groupNoMention: FeishuMessageReceiveEvent = {
      header: { event_id: "evt-g", event_type: "im.message.receive_v1" },
      event: {
        message: {
          message_id: "msg-g",
          chat_id: "chat-g",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "just talking" }),
        },
        sender: {
          sender_id: { open_id: "user-1" },
        },
      },
    };

    const result = await handler.handleMessageEvent(groupNoMention);

    expect(result).toEqual({ kind: "ignored-no-mention" });
  });
});
