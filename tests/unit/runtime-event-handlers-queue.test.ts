import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

function createFileEvent(options: {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType?: "p2p" | "group";
  fileName?: string;
  mentions?: Array<{
    key: string;
    id: { open_id?: string; union_id?: string; user_id?: string };
    name?: string;
    tenant_key?: string;
  }>;
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
        chat_type: options.chatType ?? "group",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file-key-1",
          file_name: options.fileName ?? "review.txt",
          file_size: 12,
        }),
        mentions: options.mentions ?? [],
      },
      sender: {
        sender_id: { open_id: "user-open-id" },
      },
    },
  };
}

function createImageEvent(options: {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType?: "p2p" | "group";
  mentions?: Array<{
    key: string;
    id: { open_id?: string; union_id?: string; user_id?: string };
    name?: string;
    tenant_key?: string;
  }>;
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
        chat_type: options.chatType ?? "group",
        message_type: "image",
        content: JSON.stringify({
          image_key: "image-key-1",
        }),
        mentions: options.mentions ?? [],
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

  it("ignores group file messages without an explicit bot mention", async () => {
    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(),
    };
    const fileHandler = {
      isInboundFileMessage: vi.fn().mockReturnValue(true),
      handleInboundFile: vi.fn(),
      downloadFile: vi.fn(),
      cleanup: vi.fn(),
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
      fileHandler: fileHandler as never,
      botOpenId: "bot-open-id",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await handlers.handleMessageReceived(
      createFileEvent({
        eventId: "evt-file-no-mention",
        messageId: "msg-file-no-mention",
        chatId: "chat-group-1",
      }),
    );

    expect(fileHandler.handleInboundFile).not.toHaveBeenCalled();
    expect(promptIngressHandler.handlePromptInput).not.toHaveBeenCalled();
    expect(promptIngressHandler.handleMessageEvent).not.toHaveBeenCalled();
  });

  it("ignores group file messages when FEISHU_BOT_OPEN_ID is unset", async () => {
    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(),
    };
    const fileHandler = {
      isInboundFileMessage: vi.fn().mockReturnValue(true),
      handleInboundFile: vi.fn(),
      downloadFile: vi.fn(),
      cleanup: vi.fn(),
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
      fileHandler: fileHandler as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await handlers.handleMessageReceived(
      createFileEvent({
        eventId: "evt-file-no-bot-id",
        messageId: "msg-file-no-bot-id",
        chatId: "chat-group-1",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "some-other-user" },
            name: "Another User",
          },
        ],
      }),
    );

    expect(fileHandler.handleInboundFile).not.toHaveBeenCalled();
    expect(promptIngressHandler.handlePromptInput).not.toHaveBeenCalled();
    expect(promptIngressHandler.handleMessageEvent).not.toHaveBeenCalled();
  });

  it("dispatches group file messages when the bot is explicitly mentioned", async () => {
    const promptIngressHandler = {
      handlePromptInput: vi
        .fn()
        .mockResolvedValue({ kind: "blocked", reason: "noop" } as const),
      handleMessageEvent: vi.fn(),
    };
    const fileHandler = {
      isInboundFileMessage: vi.fn().mockReturnValue(true),
      handleInboundFile: vi.fn().mockResolvedValue({
        fileName: "review.txt",
        fileSize: 12,
        localPath: "/tmp/review.txt",
        mimeType: "text/plain",
      }),
      downloadFile: vi.fn(),
      cleanup: vi.fn(),
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
      fileHandler: fileHandler as never,
      botOpenId: "bot-open-id",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await handlers.handleMessageReceived(
      createFileEvent({
        eventId: "evt-file-with-mention",
        messageId: "msg-file-with-mention",
        chatId: "chat-group-1",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "bot-open-id" },
            name: "OpenCode Bot",
          },
        ],
      }),
    );

    expect(fileHandler.handleInboundFile).toHaveBeenCalledTimes(1);
    expect(promptIngressHandler.handlePromptInput).toHaveBeenCalledWith({
      messageId: "msg-file-with-mention",
      chatId: "chat-group-1",
      text: "Please review the attached file review.txt.",
      parts: [
        {
          type: "text",
          text: "Please review the attached file review.txt.",
        },
        {
          type: "file",
          mime: "text/plain",
          filename: "review.txt",
          url: pathToFileURL("/tmp/review.txt").href,
        },
      ],
    });
    expect(promptIngressHandler.handleMessageEvent).not.toHaveBeenCalled();
  });

  it("ignores group image messages without an explicit bot mention", async () => {
    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(),
    };
    const fileHandler = {
      isInboundFileMessage: vi.fn().mockReturnValue(true),
      handleInboundFile: vi.fn(),
      downloadFile: vi.fn(),
      cleanup: vi.fn(),
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
      fileHandler: fileHandler as never,
      botOpenId: "bot-open-id",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await handlers.handleMessageReceived(
      createImageEvent({
        eventId: "evt-image-no-mention",
        messageId: "msg-image-no-mention",
        chatId: "chat-group-1",
      }),
    );

    expect(fileHandler.handleInboundFile).not.toHaveBeenCalled();
    expect(promptIngressHandler.handlePromptInput).not.toHaveBeenCalled();
    expect(promptIngressHandler.handleMessageEvent).not.toHaveBeenCalled();
  });

  it("ignores group image messages when FEISHU_BOT_OPEN_ID is unset", async () => {
    const promptIngressHandler = {
      handlePromptInput: vi.fn(),
      handleMessageEvent: vi.fn(),
    };
    const fileHandler = {
      isInboundFileMessage: vi.fn().mockReturnValue(true),
      handleInboundFile: vi.fn(),
      downloadFile: vi.fn(),
      cleanup: vi.fn(),
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
      fileHandler: fileHandler as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await handlers.handleMessageReceived(
      createImageEvent({
        eventId: "evt-image-no-bot-id",
        messageId: "msg-image-no-bot-id",
        chatId: "chat-group-1",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "some-other-user" },
            name: "Another User",
          },
        ],
      }),
    );

    expect(fileHandler.handleInboundFile).not.toHaveBeenCalled();
    expect(promptIngressHandler.handlePromptInput).not.toHaveBeenCalled();
    expect(promptIngressHandler.handleMessageEvent).not.toHaveBeenCalled();
  });

  it("dispatches group image messages when the bot is explicitly mentioned", async () => {
    const imageTempDir = mkdtempSync(join(tmpdir(), "runtime-image-test-"));
    const imagePath = join(imageTempDir, "image.png");
    writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));

    try {
      const promptIngressHandler = {
        handlePromptInput: vi
          .fn()
          .mockResolvedValue({ kind: "blocked", reason: "noop" } as const),
        handleMessageEvent: vi.fn(),
      };
      const fileHandler = {
        isInboundFileMessage: vi.fn().mockReturnValue(true),
        handleInboundFile: vi.fn().mockResolvedValue({
          fileName: "image.png",
          fileSize: 9,
          localPath: imagePath,
          mimeType: "image/png",
        }),
        downloadFile: vi.fn(),
        cleanup: vi.fn(),
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
        fileHandler: fileHandler as never,
        botOpenId: "bot-open-id",
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      await handlers.handleMessageReceived(
        createImageEvent({
          eventId: "evt-image-with-mention",
          messageId: "msg-image-with-mention",
          chatId: "chat-group-1",
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "bot-open-id" },
              name: "OpenCode Bot",
            },
          ],
        }),
      );

      expect(fileHandler.handleInboundFile).toHaveBeenCalledTimes(1);
      expect(promptIngressHandler.handlePromptInput).toHaveBeenCalledWith({
        messageId: "msg-image-with-mention",
        chatId: "chat-group-1",
        text: "Please review the attached file image.png.",
        parts: [
          {
            type: "text",
            text: "Please review the attached file image.png.",
          },
          {
            type: "file",
            mime: "image/png",
            filename: "image.png",
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      });
      expect(promptIngressHandler.handleMessageEvent).not.toHaveBeenCalled();
    } finally {
      rmSync(imageTempDir, { recursive: true, force: true });
    }
  });
});
