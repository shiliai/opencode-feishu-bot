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

function createMockSettings(): SettingsManager {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(undefined),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
    clearStatusMessageId: vi.fn(),
    getCurrentModel: vi.fn().mockReturnValue(undefined),
    getCurrentAgent: vi.fn().mockReturnValue(undefined),
    __resetSettingsForTests: vi.fn(),
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

function makeEvent(overrides: Record<string, unknown>): FeishuMessageReceiveEvent {
  return {
    header: { event_id: "evt-1", event_type: "im.message.receive_v1" },
    event: overrides,
  } as unknown as FeishuMessageReceiveEvent;
}

describe("PromptIngressHandler unsupported paths", () => {
  const settings = createMockSettings();
  const interactionManager = createMockInteractionManager();
  const openCodeSession: OpenCodeSessionClient = { create: vi.fn() };
  const openCodeSessionStatus: OpenCodeSessionStatusClient = { status: vi.fn() };
  const openCodePromptAsync: OpenCodePromptAsyncClient = { promptAsync: vi.fn() };

  function createHandler(): PromptIngressHandler {
    return new PromptIngressHandler({
      settings,
      interactionManager,
      openCodeSession,
      openCodeSessionStatus,
      openCodePromptAsync,
    });
  }

  it("returns unsupported for image messages", async () => {
    const handler = createHandler();
    const event = makeEvent({
      message: {
        message_id: "msg-img",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img-123" }),
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "unsupported", messageType: "image" });
  });

  it("returns unsupported for file messages", async () => {
    const handler = createHandler();
    const event = makeEvent({
      message: {
        message_id: "msg-file",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file-123" }),
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "unsupported", messageType: "file" });
  });

  it("returns unsupported for audio messages", async () => {
    const handler = createHandler();
    const event = makeEvent({
      message: {
        message_id: "msg-audio",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({ file_key: "audio-123" }),
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "unsupported", messageType: "audio" });
  });

  it("returns unsupported for sticker messages", async () => {
    const handler = createHandler();
    const event = makeEvent({
      message: {
        message_id: "msg-sticker",
        chat_id: "chat-1",
        chat_type: "p2p",
        message_type: "sticker",
        content: JSON.stringify({ file_key: "sticker-123" }),
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "unsupported", messageType: "sticker" });
  });

  it("returns unsupported for malformed event with no message", async () => {
    const handler = createHandler();
    const event = makeEvent({});

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "unsupported", messageType: "unknown" });
  });

  it("returns ignored-no-mention for group text without mentions", async () => {
    const handler = createHandler();
    const event = makeEvent({
      message: {
        message_id: "msg-grp",
        chat_id: "chat-grp",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello everyone" }),
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "ignored-no-mention" });
  });

  it("returns unsupported for unsupported group message types", async () => {
    const handler = createHandler();
    const event = makeEvent({
      message: {
        message_id: "msg-grp-img",
        chat_id: "chat-grp",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img-456" }),
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const result = await handler.handleMessageEvent(event);

    expect(result).toEqual({ kind: "unsupported", messageType: "image" });
  });

  it("does not call promptAsync for any unsupported or no-op path", async () => {
    const event = makeEvent({
      message: {
        message_id: "msg-x",
        chat_id: "chat-x",
        chat_type: "p2p",
        message_type: "video",
        content: "{}",
      },
      sender: { sender_id: { open_id: "user-1" } },
    });

    const handler = createHandler();
    await handler.handleMessageEvent(event);

    expect(openCodePromptAsync.promptAsync).not.toHaveBeenCalled();
    expect(interactionManager.startBusy).not.toHaveBeenCalled();
  });
});
