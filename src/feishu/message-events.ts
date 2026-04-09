import type { FeishuMessageReceiveEvent } from "./event-router.js";

export type SupportedPromptMessageType = "text" | "post";

/**
 * Normalizes Feishu event payloads to handle both webhook-style nested
 * and WebSocket top-level structures.
 *
 * Webhook shape: { header, event: { message, sender } }
 * WebSocket shape: { message, sender, ... } (top-level)
 */
export interface NormalizedFeishuEvent {
  header: { event_id?: string; event_type?: string } | null;
  message: RawFeishuMessage | null;
  sender: { sender_id?: { open_id?: string } } | null;
}

export function normalizeFeishuEvent(
  event: FeishuMessageReceiveEvent,
): NormalizedFeishuEvent {
  const header = isRecord(event.header) ? event.header : null;

  const rawEvent = isRecord(event.event) ? event.event : null;
  const nestedMessage =
    rawEvent && isRecord(rawEvent.message)
      ? (rawEvent.message as RawFeishuMessage)
      : null;
  const nestedSender =
    rawEvent && isRecord(rawEvent.sender) ? rawEvent.sender : null;

  const topLevelMessage = isRecord(event.message)
    ? (event.message as RawFeishuMessage)
    : null;
  const topLevelSender = isRecord(event.sender) ? event.sender : null;

  const message = nestedMessage ?? topLevelMessage ?? null;
  const sender = nestedSender ?? topLevelSender ?? null;

  return { header, message, sender };
}

export interface FeishuMentionId {
  open_id?: string;
  union_id?: string;
  user_id?: string;
}

export interface FeishuMention {
  key?: string;
  id: FeishuMentionId;
  name?: string;
  tenant_key?: string;
}

export interface ParsedFeishuPromptEvent {
  eventId: string | null;
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: SupportedPromptMessageType;
  text: string;
  rawContent: string;
  senderOpenId: string | null;
  threadId: string | null;
  rootId: string | null;
  parentId: string | null;
  mentions: FeishuMention[];
  isDirectMessage: boolean;
  botMentioned: boolean;
}

export interface ParsedFeishuMessageAddressing {
  chatType: string;
  mentions: FeishuMention[];
  isDirectMessage: boolean;
  botMentioned: boolean;
}

export interface ParseFeishuPromptEventOptions {
  botOpenId?: string | null;
}

interface RawFeishuMessage {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  chat_id?: string;
  thread_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: unknown;
}

function resolveFeishuMessageAddressing(
  rawMessage: Pick<RawFeishuMessage, "chat_type" | "mentions">,
  options: ParseFeishuPromptEventOptions = {},
): ParsedFeishuMessageAddressing | null {
  const chatType = getString(rawMessage.chat_type);
  if (!chatType) {
    return null;
  }

  const mentions = extractMentions(rawMessage.mentions);
  const mentionedOpenIds = new Set(extractMentionedOpenIds(mentions));
  const isDirectMessage = chatType === "p2p";
  const botMentioned = options.botOpenId
    ? mentionedOpenIds.has(options.botOpenId)
    : false;

  return {
    chatType,
    mentions,
    isDirectMessage,
    botMentioned,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function stripMentionPlaceholders(text: string): string {
  return normalizeWhitespace(text.replace(/@_user_\d+\s*/g, ""));
}

export function isSupportedPromptMessageType(
  value: unknown,
): value is SupportedPromptMessageType {
  return value === "text" || value === "post";
}

export function extractMentions(value: unknown): FeishuMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map(
    (mention): FeishuMention => ({
      key: getString(mention.key) ?? undefined,
      id: isRecord(mention.id)
        ? {
            open_id: getString(mention.id.open_id) ?? undefined,
            union_id: getString(mention.id.union_id) ?? undefined,
            user_id: getString(mention.id.user_id) ?? undefined,
          }
        : {},
      name: getString(mention.name) ?? undefined,
      tenant_key: getString(mention.tenant_key) ?? undefined,
    }),
  );
}

export function extractMentionedOpenIds(
  mentions: readonly FeishuMention[],
): string[] {
  return mentions
    .map((mention) => mention.id.open_id)
    .filter(
      (openId): openId is string =>
        typeof openId === "string" && openId.length > 0,
    );
}

export function parseFeishuMessageAddressing(
  event: FeishuMessageReceiveEvent,
  options: ParseFeishuPromptEventOptions = {},
): ParsedFeishuMessageAddressing | null {
  const normalized = normalizeFeishuEvent(event);
  const rawMessage = normalized.message;

  if (!rawMessage) {
    return null;
  }

  return resolveFeishuMessageAddressing(rawMessage, options);
}

function extractTextFromPostSegment(segment: unknown): string | null {
  if (!isRecord(segment)) {
    return null;
  }

  if (typeof segment.text === "string") {
    return segment.text;
  }

  if (typeof segment.user_name === "string") {
    return `@${segment.user_name}`;
  }

  if (typeof segment.name === "string") {
    return segment.name;
  }

  return null;
}

function collectPostBodies(
  content: unknown,
): Array<{ title: string | null; rows: unknown[] }> {
  if (!isRecord(content)) {
    return [];
  }

  const directRows = Array.isArray(content.content) ? content.content : null;
  if (directRows) {
    return [{ title: getString(content.title), rows: directRows }];
  }

  const bodies: Array<{ title: string | null; rows: unknown[] }> = [];
  for (const nestedValue of Object.values(content)) {
    if (!isRecord(nestedValue)) {
      continue;
    }

    const rows = Array.isArray(nestedValue.content)
      ? nestedValue.content
      : null;
    if (!rows) {
      continue;
    }

    bodies.push({ title: getString(nestedValue.title), rows });
  }

  return bodies;
}

export function extractPromptTextFromMessageContent(
  messageType: SupportedPromptMessageType,
  content: string,
): string | null {
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(content);
  } catch {
    return null;
  }

  if (messageType === "text") {
    if (!isRecord(parsedContent) || typeof parsedContent.text !== "string") {
      return null;
    }

    const cleanedText = stripMentionPlaceholders(parsedContent.text);
    return cleanedText.length > 0 ? cleanedText : null;
  }

  const bodies = collectPostBodies(parsedContent);
  if (bodies.length === 0) {
    return null;
  }

  const chunks: string[] = [];
  for (const body of bodies) {
    if (body.title) {
      chunks.push(body.title);
    }

    for (const row of body.rows) {
      if (!Array.isArray(row)) {
        continue;
      }

      const rowText = row
        .map((segment) => extractTextFromPostSegment(segment))
        .filter(
          (segment): segment is string =>
            typeof segment === "string" && segment.length > 0,
        )
        .join("");

      if (rowText) {
        chunks.push(rowText);
      }
    }
  }

  const normalized = normalizeWhitespace(chunks.join("\n"));
  return normalized.length > 0 ? normalized : null;
}

export function parseFeishuPromptEvent(
  event: FeishuMessageReceiveEvent,
  options: ParseFeishuPromptEventOptions = {},
): ParsedFeishuPromptEvent | null {
  const normalized = normalizeFeishuEvent(event);
  const { header, message: rawMessage, sender: rawSender } = normalized;

  if (!rawMessage) {
    return null;
  }

  const messageType = rawMessage.message_type;
  if (!isSupportedPromptMessageType(messageType)) {
    return null;
  }

  const messageId = getString(rawMessage.message_id);
  const chatId = getString(rawMessage.chat_id);
  const rawContent = getString(rawMessage.content);
  const addressing = resolveFeishuMessageAddressing(rawMessage, options);

  if (!messageId || !chatId || !rawContent || !addressing) {
    return null;
  }

  const text = extractPromptTextFromMessageContent(messageType, rawContent);
  if (!text) {
    return null;
  }

  if (!addressing.isDirectMessage && !addressing.botMentioned) {
    return null;
  }

  const rawSenderId =
    rawSender && isRecord(rawSender.sender_id) ? rawSender.sender_id : null;

  return {
    eventId: header?.event_id ?? null,
    messageId,
    chatId,
    chatType: addressing.chatType,
    messageType,
    text,
    rawContent,
    senderOpenId: getString(rawSenderId?.open_id),
    threadId: getString(rawMessage.thread_id),
    rootId: getString(rawMessage.root_id),
    parentId: getString(rawMessage.parent_id),
    mentions: addressing.mentions,
    isDirectMessage: addressing.isDirectMessage,
    botMentioned: addressing.botMentioned,
  };
}
