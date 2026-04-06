import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { FeishuMessageReceiveEvent } from "../feishu/event-router.js";
import { parseFeishuPromptEvent } from "../feishu/message-events.js";
import type {
  PromptIngressHandler,
  PromptIngressResult,
} from "../feishu/handlers/prompt.js";
import type { PromptPartInput } from "../feishu/handlers/prompt.js";
import type { FileHandler } from "../feishu/file-handler.js";
import type { StoredFile } from "../feishu/file-store.js";
import type { ResponsePipelineController } from "../feishu/response-pipeline.js";
import type { QuestionCardHandler } from "../feishu/handlers/question.js";
import type { PermissionCardHandler } from "../feishu/handlers/permission.js";
import type { ControlRouter } from "../feishu/control-router.js";
import type { Logger } from "../utils/logger.js";
import { logger as defaultLogger } from "../utils/logger.js";
import { normalizeFeishuEvent } from "../feishu/message-events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRawMessage(
  event: FeishuMessageReceiveEvent,
): Record<string, unknown> | null {
  const normalized = normalizeFeishuEvent(event);
  return normalized.message as Record<string, unknown> | null;
}

function inferMimeType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".js":
    case ".jsx":
      return "text/javascript";
    case ".py":
      return "text/x-python";
    case ".yml":
    case ".yaml":
      return "application/yaml";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export interface RuntimeEventHandlersOptions {
  promptIngressHandler: PromptIngressHandler;
  pipelineController: Pick<ResponsePipelineController, "startTurn">;
  questionCardHandler: Pick<
    QuestionCardHandler,
    "handleCardAction" | "canHandleTextReply" | "handleTextReply"
  >;
  permissionCardHandler: Pick<PermissionCardHandler, "handleCardAction">;
  controlRouter: Pick<
    ControlRouter,
    "parseCommand" | "handleCommand" | "handleCardAction"
  >;
  fileHandler: Pick<
    FileHandler,
    "isInboundFileMessage" | "handleInboundFile" | "cleanup"
  >;
  botOpenId?: string | null;
  logger?: Logger;
  onPromptDispatched?: (
    result: Extract<PromptIngressResult, { kind: "dispatched" }>,
    storedFile?: StoredFile,
  ) => Promise<void> | void;
}

export function createRuntimeEventHandlers(
  options: RuntimeEventHandlersOptions,
): {
  handleMessageReceived(event: FeishuMessageReceiveEvent): Promise<void>;
  handleCardAction(
    event: Record<string, unknown>,
  ): Promise<Record<string, never>>;
} {
  const logger = options.logger ?? defaultLogger;

  const handlePromptResult = async (
    result: PromptIngressResult,
    storedFile?: StoredFile,
  ): Promise<void> => {
    if (result.kind !== "dispatched") {
      const identifiers = {
        kind: result.kind,
        ...(result.kind === "blocked" ? { reason: result.reason } : {}),
        ...(result.kind === "unsupported"
          ? { messageType: result.messageType }
          : {}),
      };
      logger.debug(
        `[RuntimeEventHandlers] Prompt result not dispatched: ${JSON.stringify(identifiers)}`,
      );
      if (storedFile) {
        await options.fileHandler.cleanup(storedFile);
      }
      return;
    }

    if (options.onPromptDispatched) {
      await options.onPromptDispatched(result, storedFile);
    }

    options.pipelineController.startTurn({
      sessionId: result.sessionId,
      directory: result.directory,
      receiveId: result.receiveId,
      sourceMessageId: result.sourceMessageId,
    });
  };

  return {
    async handleMessageReceived(
      event: FeishuMessageReceiveEvent,
    ): Promise<void> {
      const rawMessage = getRawMessage(event);
      const chatId =
        typeof rawMessage?.chat_id === "string" ? rawMessage.chat_id : null;
      const messageId =
        typeof rawMessage?.message_id === "string"
          ? rawMessage.message_id
          : null;

      if (options.fileHandler.isInboundFileMessage(event)) {
        if (!chatId || !messageId) {
          return;
        }

        const storedFile = await options.fileHandler.handleInboundFile(
          event,
          chatId,
        );
        if (!storedFile) {
          return;
        }

        const text = `Please review the attached file ${storedFile.fileName}.`;
        const parts: PromptPartInput[] = [
          { type: "text", text },
          {
            type: "file",
            mime: inferMimeType(storedFile.fileName),
            filename: storedFile.fileName,
            url: pathToFileURL(storedFile.localPath).href,
          },
        ];

        const result = await options.promptIngressHandler.handlePromptInput({
          messageId,
          chatId,
          text,
          parts,
        });
        await handlePromptResult(result, storedFile);
        return;
      }

      const parsed = parseFeishuPromptEvent(event, {
        botOpenId: options.botOpenId ?? null,
      });
      if (parsed) {
        if (options.controlRouter.parseCommand(parsed.text)) {
          await options.controlRouter.handleCommand(parsed.chatId, parsed.text);
          return;
        }

        if (options.questionCardHandler.canHandleTextReply(parsed.text)) {
          const handled = await options.questionCardHandler.handleTextReply(
            parsed.text,
          );
          if (handled) {
            return;
          }
        }
      }

      const result =
        await options.promptIngressHandler.handleMessageEvent(event);
      await handlePromptResult(result);
    },

    async handleCardAction(
      event: Record<string, unknown>,
    ): Promise<Record<string, never>> {
      await options.questionCardHandler.handleCardAction(event);
      await options.permissionCardHandler.handleCardAction(event);
      await options.controlRouter.handleCardAction(event);
      return {};
    },
  };
}
