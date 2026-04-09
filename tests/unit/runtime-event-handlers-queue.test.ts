import { describe, expect, it, vi } from "vitest";
import { createRuntimeEventHandlers } from "../../src/app/runtime-event-handlers.js";
import type { FeishuMessageReceiveEvent } from "../../src/feishu/event-router.js";

function createTextEvent(options: {
  eventId: string;
  messageId: string;
  chatId: string;
  text: string;
}): FeishuMessageReceiveEvent {
  return {
    header: {
      event_id: options.eventId,
      event_type: "im.message.receive_v1",
    },
    event: {
      message: {
        message_id: options.messageId,
        chat_id: options.chatId,
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: options.text }),
      },
      sender: {
        sender_id: { open_id: "user-open-id" },
      },
    },
  };
}

describe("runtime event handlers chat serialization", () => {
  it("serializes message handling for the same chat", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(async (event: FeishuMessageReceiveEvent) => {
        const message =
          event.event && typeof event.event === "object"
            ? (event.event as { message?: { message_id?: string } }).message
            : undefined;
        if (message?.message_id === "msg-1") {
          await firstBarrier;
        }
        return { kind: "blocked", reason: "noop" } as const;
      }),
    };

    const handlers = createRuntimeEventHandlers({
      promptIngressHandler: promptIngressHandler as never,
      pipelineController: {
        startTurn: vi.fn(),
        recordFollowUpAppended: vi.fn().mockResolvedValue(undefined),
      },
      questionCardHandler: {
        handleCardAction: vi.fn(),
        canHandleTextReply: vi.fn().mockReturnValue(false),
        handleTextReply: vi.fn(),
      },
      permissionCardHandler: {
        handleCardAction: vi.fn(),
      },
      controlRouter: {
        parseCommand: vi.fn().mockReturnValue(null),
        handleCommand: vi.fn(),
        handleCardAction: vi.fn(),
      },
      fileHandler: {
        isInboundFileMessage: vi.fn().mockReturnValue(false),
        handleInboundFile: vi.fn(),
        downloadFile: vi.fn(),
        cleanup: vi.fn(),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const first = handlers.handleMessageReceived(
      createTextEvent({
        eventId: "evt-1",
        messageId: "msg-1",
        chatId: "chat-1",
        text: "first",
      }),
    );
    await Promise.resolve();

    const second = handlers.handleMessageReceived(
      createTextEvent({
        eventId: "evt-2",
        messageId: "msg-2",
        chatId: "chat-1",
        text: "second",
      }),
    );
    await Promise.resolve();

    expect(promptIngressHandler.handleMessageEvent).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await first;
    await second;

    expect(promptIngressHandler.handleMessageEvent).toHaveBeenCalledTimes(2);
  });

  it("does not serialize across different chats", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(async (event: FeishuMessageReceiveEvent) => {
        const message =
          event.event && typeof event.event === "object"
            ? (event.event as { message?: { message_id?: string } }).message
            : undefined;
        if (message?.message_id === "msg-chat-1") {
          await firstBarrier;
        }
        return { kind: "blocked", reason: "noop" } as const;
      }),
    };

    const handlers = createRuntimeEventHandlers({
      promptIngressHandler: promptIngressHandler as never,
      pipelineController: {
        startTurn: vi.fn(),
        recordFollowUpAppended: vi.fn().mockResolvedValue(undefined),
      },
      questionCardHandler: {
        handleCardAction: vi.fn(),
        canHandleTextReply: vi.fn().mockReturnValue(false),
        handleTextReply: vi.fn(),
      },
      permissionCardHandler: {
        handleCardAction: vi.fn(),
      },
      controlRouter: {
        parseCommand: vi.fn().mockReturnValue(null),
        handleCommand: vi.fn(),
        handleCardAction: vi.fn(),
      },
      fileHandler: {
        isInboundFileMessage: vi.fn().mockReturnValue(false),
        handleInboundFile: vi.fn(),
        downloadFile: vi.fn(),
        cleanup: vi.fn(),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const first = handlers.handleMessageReceived(
      createTextEvent({
        eventId: "evt-chat-1",
        messageId: "msg-chat-1",
        chatId: "chat-1",
        text: "first",
      }),
    );
    await Promise.resolve();

    const second = handlers.handleMessageReceived(
      createTextEvent({
        eventId: "evt-chat-2",
        messageId: "msg-chat-2",
        chatId: "chat-2",
        text: "second",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promptIngressHandler.handleMessageEvent).toHaveBeenCalledTimes(2);

    releaseFirst?.();
    await first;
    await second;
  });

  it("acknowledges appended follow-ups without starting a new turn", async () => {
    const promptResult = {
      kind: "appended",
      sessionId: "sess-1",
      directory: "/workspace/project",
      receiveId: "chat-1",
      sourceMessageId: "msg-1",
      text: "follow-up",
      followUpSummary: "📥 Follow-up added: follow-up",
    } as const;
    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(async () => promptResult),
    };
    const startTurn = vi.fn();
    const recordFollowUpAppended = vi.fn().mockResolvedValue(undefined);
    const onPromptDispatched = vi.fn();
    const sendText = vi.fn().mockResolvedValue(["ack-msg-1"]);

    const handlers = createRuntimeEventHandlers({
      promptIngressHandler: promptIngressHandler as never,
      pipelineController: { startTurn, recordFollowUpAppended },
      questionCardHandler: {
        handleCardAction: vi.fn(),
        canHandleTextReply: vi.fn().mockReturnValue(false),
        handleTextReply: vi.fn(),
      },
      permissionCardHandler: {
        handleCardAction: vi.fn(),
      },
      controlRouter: {
        parseCommand: vi.fn().mockReturnValue(null),
        handleCommand: vi.fn(),
        handleCardAction: vi.fn(),
      },
      fileHandler: {
        isInboundFileMessage: vi.fn().mockReturnValue(false),
        handleInboundFile: vi.fn(),
        downloadFile: vi.fn(),
        cleanup: vi.fn(),
      },
      renderer: { sendText },
      onPromptDispatched,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await handlers.handleMessageReceived(
      createTextEvent({
        eventId: "evt-append",
        messageId: "msg-1",
        chatId: "chat-1",
        text: "follow-up",
      }),
    );

    expect(onPromptDispatched).toHaveBeenCalledWith(promptResult, undefined);
    expect(recordFollowUpAppended).toHaveBeenCalledWith(
      "sess-1",
      "📥 Follow-up added: follow-up",
    );
    expect(startTurn).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      "📝 已将新消息追加到当前任务，继续处理中…",
    );
  });
});
