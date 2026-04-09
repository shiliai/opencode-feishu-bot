import { InteractiveCard } from "@larksuiteoapi/node-sdk";
import type { FeishuClients } from "./client.js";
import type { Question } from "../question/types.js";
import type { PermissionRequest } from "../permission/types.js";
import {
  buildPostPayload,
  splitTextPayload,
  truncateCardPayload,
} from "./payloads.js";
import {
  buildStatusCard,
  buildCompleteCard,
  buildQuestionCard,
  buildPermissionCard,
  buildControlCard,
} from "./cards.js";

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
}

function assertFeishuApiSuccess(
  action: string,
  response: FeishuApiResponse,
): void {
  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(
      `[FeishuRenderer] ${action} failed: code=${response.code}, msg=${response.msg ?? "unknown"}`,
    );
  }
}

function extractMessageId(action: string, response: FeishuApiResponse): string {
  assertFeishuApiSuccess(action, response);

  const messageId = response.data?.message_id;
  if (!messageId) {
    throw new Error(
      `[FeishuRenderer] ${action} failed: missing message_id in response`,
    );
  }

  return messageId;
}

export interface FeishuSendOptions {
  uuid?: string;
}

export interface FeishuSendCardOptions extends FeishuSendOptions {
  updateMulti?: boolean;
}

export interface FeishuRendererOptions {
  client: FeishuClients["client"];
  receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
}

export class FeishuRenderer {
  private client: FeishuClients["client"];
  private defaultReceiveIdType:
    | "open_id"
    | "user_id"
    | "union_id"
    | "email"
    | "chat_id";

  constructor(options: FeishuRendererOptions) {
    this.client = options.client;
    this.defaultReceiveIdType = options.receiveIdType || "chat_id";
  }

  // Raw primitive sends
  async sendText(
    receiveId: string,
    text: string,
    receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id",
    options: FeishuSendOptions = {},
  ): Promise<string[]> {
    const payloads = splitTextPayload(text);
    const messageIds: string[] = [];

    for (const payload of payloads) {
      const res = (await this.client.im.message.create({
        params: {
          receive_id_type: receiveIdType || this.defaultReceiveIdType,
        },
        data: {
          receive_id: receiveId,
          msg_type: "text",
          content: payload,
          uuid: options.uuid,
        },
      })) as FeishuApiResponse;

      messageIds.push(extractMessageId("send text message", res));
    }
    return messageIds;
  }

  async sendPost(
    receiveId: string,
    title: string,
    paragraphs: string[][],
    receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id",
    options: FeishuSendOptions = {},
  ): Promise<string | undefined> {
    const payload = buildPostPayload(title, paragraphs);
    const res = (await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType || this.defaultReceiveIdType,
      },
      data: {
        receive_id: receiveId,
        msg_type: "post",
        content: payload,
        uuid: options.uuid,
      },
    })) as FeishuApiResponse;
    return extractMessageId("send post message", res);
  }

  async sendCard(
    receiveId: string,
    card: InteractiveCard,
    receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id",
    options: FeishuSendCardOptions = {},
  ): Promise<string | undefined> {
    const payload = truncateCardPayload(card, options.updateMulti ?? false);
    const res = (await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType || this.defaultReceiveIdType,
      },
      data: {
        receive_id: receiveId,
        msg_type: "interactive",
        content: payload,
        uuid: options.uuid,
      },
    })) as FeishuApiResponse;
    return extractMessageId("send card message", res);
  }

  async replyPost(
    messageId: string,
    title: string,
    paragraphs: string[][],
    options: FeishuSendOptions = {},
  ): Promise<string | undefined> {
    const payload = buildPostPayload(title, paragraphs);
    const res = (await this.client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "post",
        content: payload,
        uuid: options.uuid,
      },
    })) as FeishuApiResponse;
    return extractMessageId("reply post message", res);
  }

  async updateCard(messageId: string, card: InteractiveCard): Promise<void> {
    const payload = truncateCardPayload(card, true);
    const response = (await this.client.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: payload,
      },
    })) as FeishuApiResponse;

    assertFeishuApiSuccess("patch card message", response);
  }

  async deleteMessage(messageId: string): Promise<void> {
    const response = (await this.client.im.message.delete({
      path: {
        message_id: messageId,
      },
    })) as FeishuApiResponse;

    assertFeishuApiSuccess("delete message", response);
  }

  // Pre-bound card senders
  async renderStatusCard(
    receiveId: string,
    title: string,
    content: string,
    isCompleted: boolean = false,
    template?: "blue" | "green" | "red" | "orange" | "grey",
  ): Promise<string | undefined> {
    const card = buildStatusCard(title, content, isCompleted, template);
    return this.sendCard(receiveId, card, undefined, { updateMulti: true });
  }

  async updateStatusCard(
    messageId: string,
    title: string,
    content: string,
    isCompleted: boolean = false,
    template?: "blue" | "green" | "red" | "orange" | "grey",
  ): Promise<void> {
    const card = buildStatusCard(title, content, isCompleted, template);
    return this.updateCard(messageId, card);
  }

  async renderCompleteCard(
    receiveId: string,
    title: string,
    answerContent: string,
    options?: Parameters<typeof buildCompleteCard>[2],
  ): Promise<string | undefined> {
    const card = buildCompleteCard(title, answerContent, options);
    return this.sendCard(receiveId, card, undefined, { updateMulti: true });
  }

  async updateCompleteCard(
    messageId: string,
    title: string,
    answerContent: string,
    options?: Parameters<typeof buildCompleteCard>[2],
  ): Promise<void> {
    const card = buildCompleteCard(title, answerContent, options);
    return this.updateCard(messageId, card);
  }

  async renderQuestionCard(
    receiveId: string,
    question: Question,
    associatedMessageId: string,
  ): Promise<string | undefined> {
    const card = buildQuestionCard(question, associatedMessageId);
    return this.sendCard(receiveId, card);
  }

  async renderPermissionCard(
    receiveId: string,
    request: PermissionRequest,
  ): Promise<string | undefined> {
    const card = buildPermissionCard(request);
    return this.sendCard(receiveId, card);
  }

  async renderControlCard(
    receiveId: string,
    status: string,
    options?: { showCancel?: boolean },
  ): Promise<string | undefined> {
    const card = buildControlCard(status, options);
    return this.sendCard(receiveId, card);
  }
}
