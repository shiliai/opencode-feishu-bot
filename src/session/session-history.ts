import type { OpenCodeSessionClient } from "../feishu/control-router.js";
import type { Logger } from "../utils/logger.js";

export interface SessionHistoryContext {
  maxTokensUsed: number;
  totalCost: number;
  messageCount: number;
  lastActiveAt: string | null;
}

export interface SessionPreviewMessage {
  role: "user" | "assistant";
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export async function loadContextFromHistory(
  sessionClient: OpenCodeSessionClient,
  sessionId: string,
  directory: string,
  logger?: Logger,
): Promise<SessionHistoryContext> {
  let maxTokensUsed = 0;
  let totalCost = 0;
  let messageCount = 0;
  let lastActiveAt: string | null = null;

  try {
    const result = await sessionClient.messages({
      sessionID: sessionId,
      directory,
      limit: 100,
    });

    if (result.error) {
      throw result.error;
    }

    const messages = Array.isArray(result.data) ? result.data : [];

    for (const msg of messages) {
      if (!isRecord(msg) || !isRecord(msg.info)) {
        continue;
      }

      const info = msg.info;

      if (
        getTrimmedString(info.role) === "assistant" &&
        info.summary !== true
      ) {
        messageCount++;

        const tokens = isRecord(info.tokens) ? info.tokens : null;
        if (tokens) {
          const input = getNumber(tokens.input) ?? 0;
          const cache = isRecord(tokens.cache) ? tokens.cache : null;
          const cacheRead = getNumber(cache?.read) ?? 0;
          maxTokensUsed = Math.max(maxTokensUsed, input + cacheRead);
        }

        const cost = getNumber(info.cost);
        if (cost !== null) {
          totalCost += cost;
        }
      }

      const createdAt = getTrimmedString(info.createdAt);
      if (createdAt && (!lastActiveAt || createdAt > lastActiveAt)) {
        lastActiveAt = createdAt;
      }
    }
  } catch (error) {
    logger?.warn("[SessionHistory] Failed to load context from history", error);
  }

  return { maxTokensUsed, totalCost, messageCount, lastActiveAt };
}

export async function loadSessionPreview(
  sessionClient: OpenCodeSessionClient,
  sessionId: string,
  directory: string,
  limit = 6,
  logger?: Logger,
): Promise<SessionPreviewMessage[]> {
  const previewMessages: SessionPreviewMessage[] = [];

  try {
    const result = await sessionClient.messages({
      sessionID: sessionId,
      directory,
      limit,
    });

    if (result.error) {
      throw result.error;
    }

    const messages = Array.isArray(result.data) ? result.data : [];

    for (const msg of messages) {
      if (!isRecord(msg) || !isRecord(msg.info)) {
        continue;
      }

      const info = msg.info;
      const role = getTrimmedString(info.role);

      if ((role === "user" || role === "assistant") && info.summary !== true) {
        let content = "";
        if (typeof info.text === "string") {
          content = info.text;
        } else if (Array.isArray(info.parts)) {
          const textParts: string[] = [];
          for (const part of info.parts) {
            if (isRecord(part) && typeof part.text === "string") {
              textParts.push(part.text);
            }
          }
          content = textParts.join("\n");
        }

        if (content.trim()) {
          const truncated =
            content.length > 200 ? `${content.slice(0, 199)}…` : content;
          previewMessages.push({ role, content: truncated });
        }
      }
    }
  } catch (error) {
    logger?.warn("[SessionHistory] Failed to load session preview", error);
  }

  return previewMessages;
}

export function formatSessionPreview(
  messages: SessionPreviewMessage[],
): string {
  if (messages.length === 0) {
    return "_No messages in this session._";
  }

  return messages
    .map((msg) => {
      const prefix = msg.role === "user" ? "**You**" : "**Agent**";
      return `${prefix}: ${msg.content}`;
    })
    .join("\n\n");
}
