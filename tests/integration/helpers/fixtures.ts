import type { Event } from "@opencode-ai/sdk/v2";
import type { FeishuMessageReceiveEvent } from "../../../src/feishu/event-router.js";
import type { PermissionRequest } from "../../../src/permission/types.js";
import type { Question } from "../../../src/question/types.js";

interface BridgeEventShape {
  type: string;
  properties: Record<string, unknown>;
}

function toEvent(event: BridgeEventShape): Event {
  return event as Event;
}

export function createTextMessageEvent(options: {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  text: string;
  chatType?: "p2p" | "group";
}): FeishuMessageReceiveEvent {
  return {
    header: {
      event_id: options.eventId ?? "evt-text-1",
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "user-open-1",
        },
      },
      message: {
        message_id: options.messageId ?? "msg-text-1",
        chat_id: options.chatId ?? "chat-1",
        chat_type: options.chatType ?? "p2p",
        message_type: "text",
        content: JSON.stringify({ text: options.text }),
      },
    },
  };
}

export function createFileMessageEvent(options: {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  fileKey?: string;
  fileName: string;
  fileSize: number;
}): FeishuMessageReceiveEvent {
  return {
    header: {
      event_id: options.eventId ?? "evt-file-1",
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "user-open-1",
        },
      },
      message: {
        message_id: options.messageId ?? "msg-file-1",
        chat_id: options.chatId ?? "chat-1",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({
          file_key: options.fileKey ?? "file-key-1",
          file_name: options.fileName,
          file_size: options.fileSize,
        }),
      },
    },
  };
}

export function createImageMessageEvent(options: {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  imageKey?: string;
}): FeishuMessageReceiveEvent {
  return {
    header: {
      event_id: options.eventId ?? "evt-image-1",
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "user-open-1",
        },
      },
      message: {
        message_id: options.messageId ?? "msg-image-1",
        chat_id: options.chatId ?? "chat-1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          image_key: options.imageKey ?? "img-key-1",
        }),
      },
    },
  };
}

export function createAssistantTextEvents(options: {
  sessionId: string;
  messageId?: string;
  text: string;
}): Event[] {
  const messageId = options.messageId ?? "assistant-message-1";

  return [
    toEvent({
      type: "message.updated",
      properties: {
        info: {
          id: messageId,
          sessionID: options.sessionId,
          role: "assistant",
          time: { created: 1 },
        },
      },
    }),
    toEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: options.sessionId,
          messageID: messageId,
          type: "text",
          text: options.text,
        },
      },
    }),
    toEvent({
      type: "message.updated",
      properties: {
        info: {
          id: messageId,
          sessionID: options.sessionId,
          role: "assistant",
          time: { created: 1, completed: 2 },
        },
      },
    }),
    toEvent({
      type: "session.idle",
      properties: {
        sessionID: options.sessionId,
      },
    }),
  ];
}

export function createQuestionAskedEvent(options: {
  sessionId: string;
  requestId?: string;
  questions: Question[];
}): Event {
  return toEvent({
    type: "question.asked",
    properties: {
      sessionID: options.sessionId,
      id: options.requestId ?? "question-request-1",
      questions: options.questions,
    },
  });
}

export function createPermissionAskedEvent(options: {
  request: PermissionRequest;
}): Event {
  return toEvent({
    type: "permission.asked",
    properties: options.request as unknown as Record<string, unknown>,
  });
}

export function createWriteToolEvent(options: {
  sessionId: string;
  messageId?: string;
  filePath: string;
  content: string;
}): Event {
  return toEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool-part-1",
        sessionID: options.sessionId,
        messageID: options.messageId ?? "assistant-message-1",
        type: "tool",
        tool: "write",
        callID: "tool-call-1",
        state: {
          status: "completed",
          input: {
            filePath: options.filePath,
            content: options.content,
          },
          title: `Write ${options.filePath}`,
          metadata: {},
        },
      },
    },
  });
}

export function createQuestionCardAction(options: {
  messageId: string;
  optionIndex: number;
  eventId?: string;
}): Record<string, unknown> {
  return {
    event_id:
      options.eventId ??
      `card-question-${options.messageId}-${options.optionIndex}`,
    open_message_id: options.messageId,
    action: {
      value: {
        action: "question_answer",
        messageId: options.messageId,
        optionIndex: options.optionIndex,
      },
    },
  };
}

export function createPermissionCardAction(options: {
  messageId: string;
  requestId: string;
  reply: "approve" | "always" | "deny";
  eventId?: string;
}): Record<string, unknown> {
  return {
    event_id:
      options.eventId ??
      `card-permission-${options.messageId}-${options.reply}`,
    open_message_id: options.messageId,
    action: {
      value: {
        action: "permission_reply",
        requestId: options.requestId,
        reply: options.reply,
      },
    },
  };
}

export function createModelCardAction(options: {
  modelName: string;
  chatId?: string;
  eventId?: string;
  messageId?: string;
}): Record<string, unknown> {
  return {
    event_id:
      options.eventId ??
      `card-model-${options.modelName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    open_message_id: options.messageId ?? "card-message-model",
    open_chat_id: options.chatId ?? "chat-1",
    action: {
      value: {
        action: "select_model",
        modelName: options.modelName,
      },
    },
  };
}

export function createAgentCardAction(options: {
  agentName: string;
  chatId?: string;
  eventId?: string;
  messageId?: string;
}): Record<string, unknown> {
  return {
    event_id:
      options.eventId ??
      `card-agent-${options.agentName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    open_message_id: options.messageId ?? "card-message-agent",
    open_chat_id: options.chatId ?? "chat-1",
    action: {
      value: {
        action: "select_agent",
        agentName: options.agentName,
      },
    },
  };
}

export function createProjectCardAction(options: {
  projectId: string;
  chatId?: string;
  eventId?: string;
  messageId?: string;
}): Record<string, unknown> {
  return {
    event_id:
      options.eventId ??
      `card-project-${options.projectId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    open_message_id: options.messageId ?? "card-message-project",
    open_chat_id: options.chatId ?? "chat-1",
    action: {
      value: {
        action: "select_project",
        projectId: options.projectId,
      },
    },
  };
}

export function createSessionCardAction(options: {
  sessionId: string;
  chatId?: string;
  eventId?: string;
  messageId?: string;
}): Record<string, unknown> {
  return {
    event_id:
      options.eventId ??
      `card-session-${options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    open_message_id: options.messageId ?? "card-message-session",
    open_chat_id: options.chatId ?? "chat-1",
    action: {
      value: {
        action: "select_session",
        sessionId: options.sessionId,
      },
    },
  };
}
