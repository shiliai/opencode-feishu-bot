import type { Logger } from "../utils/logger.js";
import type { FeishuClients } from "./client.js";
import {
  extractPromptTextFromMessageContent,
  stripMentionPlaceholders,
} from "./message-events.js";
import { splitReasoningText } from "./reasoning-utils.js";

const DEFAULT_CHAT_MESSAGE_COUNT = 20;
const DEFAULT_SEARCH_MESSAGE_COUNT = 20;
const MAX_MESSAGE_COUNT = 50;
const DEFAULT_CONTAINER_ID_TYPE = "chat";
const SEARCH_START_TIME = "0";
const CARD_MESSAGE_CONTENT_TYPE = "raw_card_content";
const SEARCH_END_TIME_FALLBACK = () => Math.floor(Date.now() / 1000).toString();

export interface MessageReaderOptions {
  client: FeishuClients["client"];
  logger?: Logger;
}

export interface ChatMessage {
  messageId: string;
  senderId: string;
  senderType: "user" | "app" | "unknown";
  content: string;
  messageType: string;
  createdAt: string;
  chatId?: string;
}

interface RawMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  chat_id?: string;
  body?: {
    content?: string;
  };
  sender?: {
    id?: string;
    sender_type?: string;
  };
}

interface MessageListResponse {
  code?: number;
  msg?: string;
  data?: {
    items?: RawMessageItem[];
    has_more?: boolean;
    page_token?: string;
  };
}

interface MessageSearchResponse {
  code?: number;
  msg?: string;
  data?: {
    items?: string[];
    has_more?: boolean;
    page_token?: string;
  };
}

type MessageListApi = {
  list(request: unknown): Promise<MessageListResponse>;
};

type MessageSearchApi = {
  create(request: unknown): Promise<MessageSearchResponse>;
};

type FeishuRequestClient = FeishuClients["client"] & {
  request(request: unknown): Promise<unknown>;
  search?: {
    message?: MessageSearchApi;
  };
};

function createNoopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampCount(count: number | undefined, fallback: number): number {
  if (!Number.isFinite(count) || !count) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(count), 1), MAX_MESSAGE_COUNT);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripReasoningArtifacts(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  const { reasoningText, answerText } = splitReasoningText(normalized);
  if (typeof answerText === "string") {
    return normalizeWhitespace(answerText);
  }

  if (typeof reasoningText === "string") {
    return "";
  }

  return normalized;
}

function collectReadableText(
  value: unknown,
  parts: string[],
  visited: Set<object>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReadableText(item, parts, visited);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      typeof nestedValue === "string" &&
      ["content", "text", "title", "name", "label"].includes(key)
    ) {
      const normalized = normalizeWhitespace(
        stripMentionPlaceholders(nestedValue),
      );
      if (normalized) {
        parts.push(normalized);
      }
      continue;
    }

    if (Array.isArray(nestedValue) || isRecord(nestedValue)) {
      collectReadableText(nestedValue, parts, visited);
    }
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const uniqueValues: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function parseMessageContent(
  messageId: string,
  messageType: string,
  rawContent: string,
  logger: Logger,
): string {
  const normalizedRawContent = normalizeWhitespace(rawContent);
  if (!normalizedRawContent) {
    return "";
  }

  if (messageType === "text" || messageType === "post") {
    const extracted = extractPromptTextFromMessageContent(
      messageType,
      rawContent,
    );
    if (extracted) {
      return stripReasoningArtifacts(extracted);
    }
  }

  const parsedContent = safeParseJson(rawContent);
  if (typeof parsedContent === "string") {
    return stripReasoningArtifacts(stripMentionPlaceholders(parsedContent));
  }

  const parts: string[] = [];
  collectReadableText(parsedContent, parts, new Set<object>());
  const extracted = normalizeWhitespace(uniqueStrings(parts).join("\n"));
  if (extracted) {
    return stripReasoningArtifacts(extracted);
  }

  logger.debug(
    `[MessageReader] Falling back to raw content preview: messageId=${messageId || "unknown"}, messageType=${messageType}, contentLen=${normalizedRawContent.length}`,
  );
  return stripReasoningArtifacts(normalizedRawContent);
}

function normalizeSenderType(value: unknown): ChatMessage["senderType"] {
  return value === "user" || value === "app" ? value : "unknown";
}

function parseCreatedAt(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    return value;
  }

  return new Date(parsedValue).toISOString();
}

function toChatMessage(item: RawMessageItem, logger: Logger): ChatMessage {
  const rawContent =
    typeof item.body?.content === "string" ? item.body.content : "";

  return {
    messageId: item.message_id ?? "",
    senderId: item.sender?.id ?? "",
    senderType: normalizeSenderType(item.sender?.sender_type),
    content: parseMessageContent(
      item.message_id ?? "",
      item.msg_type ?? "unknown",
      rawContent,
      logger,
    ),
    messageType: item.msg_type ?? "unknown",
    createdAt: parseCreatedAt(item.create_time),
    chatId: item.chat_id,
  };
}

function assertLarkOk(response: { code?: number; msg?: string }): void {
  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(response.msg || `Feishu API error: ${response.code}`);
  }
}

export class MessageReader {
  private readonly client: FeishuClients["client"];
  private readonly logger: Logger;

  constructor(options: MessageReaderOptions) {
    this.client = options.client;
    this.logger = options.logger ?? createNoopLogger();
  }

  async getChatMessages(params: {
    chatId: string;
    count?: number;
    containerIdType?: string;
  }): Promise<ChatMessage[]> {
    const count = clampCount(params.count, DEFAULT_CHAT_MESSAGE_COUNT);
    const containerIdType = params.containerIdType || DEFAULT_CONTAINER_ID_TYPE;
    const messageApi = this.client.im.message as unknown as MessageListApi;

    const response = await messageApi.list({
      params: {
        container_id_type: containerIdType,
        container_id: params.chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: count,
        card_msg_content_type: CARD_MESSAGE_CONTENT_TYPE,
      },
    });

    assertLarkOk(response);
    const items = response.data?.items ?? [];

    this.logger.debug(
      `[MessageReader] Loaded ${items.length} messages for chat ${params.chatId}`,
    );

    return items.map((item) => toChatMessage(item, this.logger));
  }

  async searchMessages(params: {
    query: string;
    count?: number;
  }): Promise<ChatMessage[]> {
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const count = clampCount(params.count, DEFAULT_SEARCH_MESSAGE_COUNT);
    const client = this.client as FeishuRequestClient;
    const searchApi = client.search?.message;

    if (!searchApi) {
      this.logger.warn(
        "[MessageReader] Feishu search.message API is unavailable",
      );
      return [];
    }

    const searchResponse = await searchApi.create({
      params: {
        page_size: count,
      },
      data: {
        query,
        start_time: SEARCH_START_TIME,
        end_time: SEARCH_END_TIME_FALLBACK(),
      },
    });

    assertLarkOk(searchResponse);

    const messageIds = searchResponse.data?.items ?? [];
    if (messageIds.length === 0) {
      return [];
    }

    const queryString = messageIds
      .map((messageId) => `message_ids=${encodeURIComponent(messageId)}`)
      .join("&");

    const mgetResponse = (await client.request({
      method: "GET",
      url: `/open-apis/im/v1/messages/mget?${queryString}`,
      params: {
        card_msg_content_type: CARD_MESSAGE_CONTENT_TYPE,
      },
    })) as MessageListResponse;

    assertLarkOk(mgetResponse);
    return (mgetResponse.data?.items ?? []).map((item) =>
      toChatMessage(item, this.logger),
    );
  }
}
