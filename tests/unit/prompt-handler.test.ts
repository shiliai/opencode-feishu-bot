import { describe, expect, it, vi } from "vitest";
import type { FeishuMessageReceiveEvent } from "../../src/feishu/event-router.js";
import {
  type OpenCodePromptAsyncClient,
  type OpenCodeSessionMessagesClient,
  type OpenCodeSessionStatusClient,
  PromptIngressHandler,
} from "../../src/feishu/handlers/prompt.js";
import type { OpenCodeSessionClient } from "../../src/feishu/handlers/session-resolution.js";
import type { MessageReader } from "../../src/feishu/message-reader.js";
import type { InteractionManager } from "../../src/interaction/manager.js";
import type { SettingsManager } from "../../src/settings/manager.js";
import type { Logger } from "../../src/utils/logger.js";

type PromptAsyncParams = Parameters<
  OpenCodePromptAsyncClient["promptAsync"]
>[0];

function createMockSettings(
  overrides?: Partial<SettingsManager>,
): SettingsManager {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    getChatSession: vi.fn().mockReturnValue(undefined),
    setChatSession: vi.fn(),
    clearChatSession: vi.fn(),
    clearChatStatusMessageId: vi.fn(),
    getCurrentModel: vi.fn().mockReturnValue(undefined),
    getCurrentAgent: vi.fn().mockReturnValue(undefined),
    __resetSettingsForTests: vi.fn(),
    ...overrides,
  } as unknown as SettingsManager;
}

function createMockInteractionManager(): InteractionManager {
  return {
    resolveGuardDecision: vi
      .fn()
      .mockReturnValue({ allow: true, inputType: "text", state: null }),
    startBusy: vi.fn(),
    clearBusy: vi.fn(),
    get: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
    isBusy: vi.fn().mockReturnValue(false),
    getBusyState: vi.fn().mockReturnValue(null),
    start: vi.fn(),
    transition: vi.fn(),
    clear: vi.fn(),
    clearAll: vi.fn(),
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

function makeGroupMentionEvent(
  text: string,
  botOpenId: string,
): FeishuMessageReceiveEvent {
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

function createMockMessageReader(): MessageReader {
  return {
    getChatMessages: vi.fn().mockResolvedValue([]),
    searchMessages: vi.fn().mockResolvedValue([]),
  } as unknown as MessageReader;
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function runScheduledTasks(tasks: Array<() => void>): Promise<void> {
  for (const task of tasks) {
    await task();
  }
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
        data: {
          id: "sess-1",
          title: "Session",
          directory: "/workspace/project",
        },
        error: undefined,
      }),
    };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
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

    const result = await handler.handleMessageEvent(
      makeDmTextEvent("Hello, fix the bug"),
    );

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
    expect(interactionManager.startBusy).toHaveBeenCalledWith("chat-1", {
      messageId: "msg-1",
    });
  });

  it("dispatches a group-mention text prompt and strips @_user_N placeholders", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
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
      status: vi.fn().mockResolvedValue({
        data: { "sess-existing": { type: "idle" } },
        error: undefined,
      }),
    };
    const promptAsyncCalls: PromptAsyncParams[] = [];
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
    const callParams = promptAsyncCalls[0];
    expect(callParams.sessionID).toBe("sess-existing");
    expect(
      (callParams.parts as Array<{ type: string; text: string }>).map(
        (p) => p.text,
      ),
    ).toEqual(["fix the types"]);
  });

  it("prepends recent chat history context before the current prompt parts", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "Existing",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
    };
    const messageReader = createMockMessageReader();
    vi.mocked(messageReader.getChatMessages).mockResolvedValue([
      {
        messageId: "msg-current",
        senderId: "user-1",
        senderType: "user",
        content: "Current prompt",
        messageType: "text",
        createdAt: "2026-04-07T10:02:00.000Z",
      },
      {
        messageId: "msg-reply",
        senderId: "bot-1",
        senderType: "app",
        content: "Prior answer",
        messageType: "text",
        createdAt: "2026-04-07T10:01:00.000Z",
      },
      {
        messageId: "msg-earlier",
        senderId: "user-2",
        senderType: "user",
        content: "Earlier question",
        messageType: "text",
        createdAt: "2026-04-07T10:00:00.000Z",
      },
    ]);

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      messageReader,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    const result = await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Current prompt",
      parts: [
        { type: "text", text: "Current prompt" },
        {
          type: "file",
          mime: "text/plain",
          filename: "notes.txt",
          url: "file:///tmp/notes.txt",
        },
      ],
    });

    expect(result.kind).toBe("dispatched");

    await runScheduledTasks(scheduledTasks);

    expect(messageReader.getChatMessages).toHaveBeenCalledWith({
      chatId: "chat-1",
    });
    expect(openCodePromptAsync.promptAsync).toHaveBeenCalledWith({
      sessionID: "sess-1",
      directory: "/workspace/project",
      parts: [
        {
          type: "text",
          text: "Recent chat context (oldest to newest, excluding the current message):\n- user:user-2: Earlier question\n- app:bot-1: Prior answer",
        },
        { type: "text", text: "Current prompt" },
        {
          type: "file",
          mime: "text/plain",
          filename: "notes.txt",
          url: "file:///tmp/notes.txt",
        },
      ],
    });
  });

  it("appends busy follow-up text without prepending history or overriding model settings", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "Existing",
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
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "busy" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
    };
    const messageReader = createMockMessageReader();
    vi.mocked(messageReader.getChatMessages).mockResolvedValue([
      {
        messageId: "msg-current",
        senderId: "user-1",
        senderType: "user",
        content: "Busy follow-up",
        messageType: "text",
        createdAt: "2026-04-07T10:01:00.000Z",
      },
      {
        messageId: "msg-prior",
        senderId: "user-2",
        senderType: "user",
        content: "Prior context only",
        messageType: "text",
        createdAt: "2026-04-07T10:00:00.000Z",
      },
    ]);

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      messageReader,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    const result = await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Busy follow-up",
    });

    expect(result.kind).toBe("appended");
    if (result.kind !== "appended") {
      throw new Error("unexpected result kind");
    }
    expect(result.followUpSummary).toBe("📥 Follow-up added: Busy follow-up");
    await runScheduledTasks(scheduledTasks);

    expect(messageReader.getChatMessages).not.toHaveBeenCalled();
    expect(interactionManager.startBusy).not.toHaveBeenCalled();
    expect(openCodePromptAsync.promptAsync).toHaveBeenCalledWith({
      sessionID: "sess-1",
      directory: "/workspace/project",
      parts: [{ type: "text", text: "Busy follow-up" }],
    });
  });

  it("resets poisoned session history before dispatching a file prompt", async () => {
    let currentSession:
      | { id: string; title: string; directory: string }
      | undefined = {
      id: "sess-poisoned",
      title: "Poisoned",
      directory: "/workspace/project",
    };

    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockImplementation(() => currentSession),
      clearChatSession: vi.fn().mockImplementation(() => {
        currentSession = undefined;
      }),
      setChatSession: vi.fn().mockImplementation((session) => {
        currentSession = session as {
          id: string;
          title: string;
          directory: string;
        };
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn().mockResolvedValue({
        data: {
          id: "sess-fresh",
          title: "Fresh",
          directory: "/workspace/project",
        },
        error: undefined,
      }),
    };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-fresh": { type: "idle" } },
        error: undefined,
      }),
    };
    const openCodeSessionMessages: OpenCodeSessionMessagesClient = {
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: { role: "user" },
            parts: [
              {
                type: "file",
                mime: "application/octet-stream",
                url: "data:application/octet-stream;base64,/9j/4AAQ",
              },
            ],
          },
        ],
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
    };

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodeSessionMessages,
      openCodePromptAsync,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    const result = await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Please review the attached file image.jpg.",
      parts: [
        {
          type: "text",
          text: "Please review the attached file image.jpg.",
        },
        {
          type: "file",
          mime: "image/jpeg",
          filename: "image.jpg",
          url: "data:image/jpeg;base64,/9j/4AAQ",
        },
      ],
    });

    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") {
      throw new Error("unexpected result kind");
    }
    expect(result.sessionId).toBe("sess-fresh");
    expect(settings.clearChatSession).toHaveBeenCalledTimes(1);
    expect(settings.clearChatStatusMessageId).toHaveBeenCalledTimes(1);
    expect(openCodeSession.create).toHaveBeenCalledTimes(1);

    await runScheduledTasks(scheduledTasks);

    expect(openCodePromptAsync.promptAsync).toHaveBeenCalledWith({
      sessionID: "sess-fresh",
      directory: "/workspace/project",
      parts: [
        {
          type: "text",
          text: "Please review the attached file image.jpg.",
        },
        {
          type: "file",
          mime: "image/jpeg",
          filename: "image.jpg",
          url: "data:image/jpeg;base64,/9j/4AAQ",
        },
      ],
    });
  });

  it("excludes the current inbound message from prepended history context", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "Existing",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
    };
    const messageReader = createMockMessageReader();
    vi.mocked(messageReader.getChatMessages).mockResolvedValue([
      {
        messageId: "msg-current",
        senderId: "user-1",
        senderType: "user",
        content: "Current prompt",
        messageType: "text",
        createdAt: "2026-04-07T10:01:00.000Z",
      },
      {
        messageId: "msg-prior",
        senderId: "user-2",
        senderType: "user",
        content: "Prior context only",
        messageType: "text",
        createdAt: "2026-04-07T10:00:00.000Z",
      },
    ]);

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      messageReader,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Current prompt",
    });

    await runScheduledTasks(scheduledTasks);

    const firstCall = vi.mocked(openCodePromptAsync.promptAsync).mock
      .calls[0]?.[0];
    const historyPart = firstCall?.parts?.[0];
    expect(historyPart).toEqual({
      type: "text",
      text: "Recent chat context (oldest to newest, excluding the current message):\n- user:user-2: Prior context only",
    });
    expect(historyPart?.type).toBe("text");
    if (historyPart?.type !== "text") {
      throw new Error("expected text history part");
    }
    expect(historyPart.text).not.toContain("Current prompt");
  });

  it("skips history enrichment when fetched history is empty after filtering", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "Existing",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
    };
    const messageReader = createMockMessageReader();
    vi.mocked(messageReader.getChatMessages).mockResolvedValue([
      {
        messageId: "msg-current",
        senderId: "user-1",
        senderType: "user",
        content: "Current prompt",
        messageType: "text",
        createdAt: "2026-04-07T10:01:00.000Z",
      },
      {
        messageId: "msg-empty",
        senderId: "user-2",
        senderType: "user",
        content: "   ",
        messageType: "text",
        createdAt: "2026-04-07T10:00:00.000Z",
      },
    ]);

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      messageReader,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Current prompt",
    });

    await runScheduledTasks(scheduledTasks);

    expect(openCodePromptAsync.promptAsync).toHaveBeenCalledWith({
      sessionID: "sess-1",
      directory: "/workspace/project",
      parts: [{ type: "text", text: "Current prompt" }],
    });
  });

  it("fails open when history loading throws", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "Existing",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
    };
    const messageReader = createMockMessageReader();
    const logger = createMockLogger();
    vi.mocked(messageReader.getChatMessages).mockRejectedValue(
      new Error("history unavailable"),
    );

    const scheduledTasks: Array<() => void> = [];
    const handler = new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
      messageReader,
      logger,
      scheduleAsync: (task) => scheduledTasks.push(task),
    });

    await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Current prompt",
    });

    await runScheduledTasks(scheduledTasks);

    expect(openCodePromptAsync.promptAsync).toHaveBeenCalledWith({
      sessionID: "sess-1",
      directory: "/workspace/project",
      parts: [{ type: "text", text: "Current prompt" }],
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("preserves existing behavior when no messageReader is provided", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "Existing",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
    };
    const openCodePromptAsync: OpenCodePromptAsyncClient = {
      promptAsync: vi.fn().mockResolvedValue(undefined),
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

    await handler.handlePromptInput({
      messageId: "msg-current",
      chatId: "chat-1",
      text: "Current prompt",
      parts: [
        { type: "text", text: "Current prompt" },
        {
          type: "file",
          mime: "text/plain",
          filename: "notes.txt",
          url: "file:///tmp/notes.txt",
        },
      ],
    });

    await runScheduledTasks(scheduledTasks);

    expect(openCodePromptAsync.promptAsync).toHaveBeenCalledWith({
      sessionID: "sess-1",
      directory: "/workspace/project",
      parts: [
        { type: "text", text: "Current prompt" },
        {
          type: "file",
          mime: "text/plain",
          filename: "notes.txt",
          url: "file:///tmp/notes.txt",
        },
      ],
    });
  });

  it("threads current model and agent into promptAsync when available", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
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
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
    };
    const promptAsyncCalls: PromptAsyncParams[] = [];
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

    const result = await handler.handleMessageEvent(
      makeDmTextEvent("test model threading"),
    );

    expect(result.kind).toBe("dispatched");
    for (const task of scheduledTasks) {
      await task();
    }

    expect(promptAsyncCalls).toHaveLength(1);
    const callParams = promptAsyncCalls[0];
    expect(callParams.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    });
    expect(callParams.agent).toBe("build");
    expect(callParams.variant).toBe("beta");
  });

  it("clears busy state on async prompt error", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-1",
        title: "S",
        directory: "/workspace/project",
      }),
    });
    const interactionManager = createMockInteractionManager();
    const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
    const openCodeSessionStatus: OpenCodeSessionStatusClient = {
      status: vi.fn().mockResolvedValue({
        data: { "sess-1": { type: "idle" } },
        error: undefined,
      }),
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

    const result = await handler.handleMessageEvent(
      makeDmTextEvent("trigger error"),
    );

    expect(result.kind).toBe("dispatched");

    for (const task of scheduledTasks) {
      await task();
    }

    expect(interactionManager.clearBusy).toHaveBeenCalledWith("chat-1");
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

    const result = await handler.handleMessageEvent(
      makeDmTextEvent("no project"),
    );

    expect(result).toEqual({ kind: "no-project", receiveId: "chat-1" });
  });

  it("returns session-reset when directory mismatches and does not dispatch", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-new",
        worktree: "/workspace/new",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "sess-old",
        title: "Old",
        directory: "/workspace/old",
      }),
    });
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

    const result = await handler.handleMessageEvent(
      makeDmTextEvent("mismatch"),
    );

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
