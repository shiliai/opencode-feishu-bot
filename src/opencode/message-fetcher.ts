import { opencodeClient } from "./client.js";
import {
  type SessionMessageEntry,
  type SessionMessageFetcher,
} from "../feishu/response-pipeline.js";
import { logger } from "../utils/logger.js";

interface OpenCodeSessionMessageClient {
  session: {
    messages(parameters: {
      sessionID: string;
      directory?: string;
      limit?: number;
    }): Promise<{
      data?:
        | Array<{
            info: {
              id: string;
              sessionID: string;
              role: string;
            };
            parts: Array<{
              type: string;
              text?: string;
            }>;
          }>
        | undefined;
      error?: unknown;
    }>;
  };
}

export function createSessionMessageFetcher(
  client: OpenCodeSessionMessageClient = opencodeClient,
  maxMessagesToScan: number = 10,
): SessionMessageFetcher {
  return {
    async fetchLastAssistantMessage(
      sessionId: string,
      directory: string,
    ): Promise<SessionMessageEntry | undefined> {
      logger.debug(
        `[SessionMessageFetcher] Fetching last assistant message: session=${sessionId}, directory=${directory}, limit=${maxMessagesToScan}`,
      );

      const result = await client.session.messages({
        sessionID: sessionId,
        directory,
        limit: maxMessagesToScan,
      });

      if (result.error) {
        logger.warn(
          `[SessionMessageFetcher] API returned error: session=${sessionId}`,
          result.error,
        );
        return undefined;
      }

      const messages = result.data;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        logger.debug(
          `[SessionMessageFetcher] No messages returned: session=${sessionId}`,
        );
        return undefined;
      }

      const lastAssistantMessage = findLastAssistantMessage(messages);
      if (!lastAssistantMessage) {
        logger.debug(
          `[SessionMessageFetcher] No assistant message found among ${messages.length} messages: session=${sessionId}`,
        );
        return undefined;
      }

      logger.debug(
        `[SessionMessageFetcher] Found last assistant message: session=${sessionId}, messageId=${lastAssistantMessage.info.id}, parts=${lastAssistantMessage.parts.length}`,
      );

      return lastAssistantMessage;
    },
  };
}

function findLastAssistantMessage(
  messages: Array<SessionMessageEntry>,
): SessionMessageEntry | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.info?.role === "assistant") {
      return message;
    }
  }

  return undefined;
}
