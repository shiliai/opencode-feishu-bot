import { readFile } from "node:fs/promises";
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
import type { FeishuRenderer } from "../feishu/renderer.js";
import type {
  CardActionResponse,
  ControlRouter,
} from "../feishu/control-router.js";
import type { Logger } from "../utils/logger.js";
import { logger as defaultLogger } from "../utils/logger.js";
import { normalizeFeishuEvent } from "../feishu/message-events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PostImageSegment {
  imageKey: string;
}

function extractPostImageKeys(rawContent: string): PostImageSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const rows = Array.isArray(parsed.content) ? parsed.content : null;
  if (!rows) {
    return [];
  }

  const images: PostImageSegment[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }

    for (const segment of row) {
      if (
        isRecord(segment) &&
        segment.tag === "img" &&
        typeof segment.image_key === "string"
      ) {
        images.push({ imageKey: segment.image_key });
      }
    }
  }

  return images;
}

function getRawMessage(
  event: FeishuMessageReceiveEvent,
): Record<string, unknown> | null {
  const normalized = normalizeFeishuEvent(event);
  return normalized.message as Record<string, unknown> | null;
}

function getCardActionQueueKey(event: Record<string, unknown>): string {
  const payload = isRecord(event.event) ? event.event : event;
  const context = isRecord(payload.context) ? payload.context : null;
  const openMessageId =
    typeof payload.open_message_id === "string"
      ? payload.open_message_id
      : typeof context?.open_message_id === "string"
        ? context.open_message_id
        : null;

  return openMessageId ? `card:${openMessageId}` : "card:__default__";
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
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function isImageMimeType(mime: string): boolean {
  return mime.startsWith("image/");
}

async function toDataUri(localPath: string, mime: string): Promise<string> {
  const buffer = await readFile(localPath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export interface RuntimeEventHandlersOptions {
  promptIngressHandler: PromptIngressHandler;
  pipelineController: Pick<
    ResponsePipelineController,
    "startTurn" | "recordFollowUpAppended"
  >;
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
    "isInboundFileMessage" | "handleInboundFile" | "downloadFile" | "cleanup"
  >;
  renderer?: Pick<FeishuRenderer, "sendText">;
  botOpenId?: string | null;
  logger?: Logger;
  onPromptDispatched?: (
    result: Extract<PromptIngressResult, { kind: "dispatched" | "appended" }>,
    storedFiles?: StoredFile[],
  ) => Promise<void> | void;
}

export function createRuntimeEventHandlers(
  options: RuntimeEventHandlersOptions,
): {
  handleMessageReceived(event: FeishuMessageReceiveEvent): Promise<void>;
  handleCardAction(event: Record<string, unknown>): Promise<CardActionResponse>;
} {
  const logger = options.logger ?? defaultLogger;
  const messageTasks = new Map<string, Promise<void>>();
  const cardActionTasks = new Map<string, Promise<void>>();

  const sendBusyFeedback = async (receiveId: string): Promise<void> => {
    if (!options.renderer) {
      return;
    }

    try {
      await options.renderer.sendText(receiveId, "⏳ 正在处理中，请稍候…");
    } catch (error) {
      logger.warn("[RuntimeEventHandlers] Failed to send busy feedback", error);
    }
  };

  const sendAppendFeedback = async (receiveId: string): Promise<void> => {
    if (!options.renderer) {
      return;
    }

    try {
      await options.renderer.sendText(
        receiveId,
        "📝 已将新消息追加到当前任务，继续处理中…",
      );
    } catch (error) {
      logger.warn(
        "[RuntimeEventHandlers] Failed to send append acknowledgement",
        error,
      );
    }
  };

  const enqueueMessageTask = async (
    queueKey: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const previousTask = messageTasks.get(queueKey) ?? Promise.resolve();
    const nextTask = previousTask
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (messageTasks.get(queueKey) === nextTask) {
          messageTasks.delete(queueKey);
        }
      });

    messageTasks.set(queueKey, nextTask);
    await nextTask;
  };

  const enqueueCardActionTask = async (
    queueKey: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const previousTask = cardActionTasks.get(queueKey) ?? Promise.resolve();
    const nextTask = previousTask
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (cardActionTasks.get(queueKey) === nextTask) {
          cardActionTasks.delete(queueKey);
        }
      });

    cardActionTasks.set(queueKey, nextTask);
    await nextTask;
  };

  const processMessageReceived = async (
    event: FeishuMessageReceiveEvent,
  ): Promise<void> => {
    const rawMessage = getRawMessage(event);
    const eventId =
      typeof event.header?.event_id === "string" ? event.header.event_id : null;
    const chatId =
      typeof rawMessage?.chat_id === "string" ? rawMessage.chat_id : null;
    const messageId =
      typeof rawMessage?.message_id === "string" ? rawMessage.message_id : null;
    const messageType =
      typeof rawMessage?.message_type === "string"
        ? rawMessage.message_type
        : null;
    const chatType =
      typeof rawMessage?.chat_type === "string" ? rawMessage.chat_type : null;
    const contentLength =
      typeof rawMessage?.content === "string" ? rawMessage.content.length : 0;

    logger.debug(
      `[RuntimeEventHandlers] HOP-0 Event received: eventId=${eventId ?? "unknown"}, messageId=${messageId ?? "unknown"}, chatId=${chatId ?? "unknown"}, chatType=${chatType ?? "unknown"}, messageType=${messageType ?? "unknown"}, contentLen=${contentLength}`,
    );

    if (options.fileHandler.isInboundFileMessage(event)) {
      if (!chatId || !messageId) {
        logger.warn(
          `[RuntimeEventHandlers] Dropping inbound media event with missing identifiers: eventId=${eventId ?? "unknown"}, messageId=${messageId ?? "unknown"}, chatId=${chatId ?? "unknown"}, messageType=${messageType ?? "unknown"}`,
        );
        return;
      }

      logger.debug(
        `[RuntimeEventHandlers] HOP-1 Feishu inbound media event: eventId=${eventId ?? "unknown"}, messageId=${messageId}, chatId=${chatId}, rawMessageType=${messageType ?? "unknown"}, contentLen=${contentLength}`,
      );

      const storedFile = await options.fileHandler.handleInboundFile(
        event,
        chatId,
      );
      if (!storedFile) {
        logger.warn(
          `[RuntimeEventHandlers] HOP-2 handleInboundFile returned null for messageId=${messageId}`,
        );
        return;
      }

      logger.debug(
        `[RuntimeEventHandlers] HOP-2 File downloaded: fileName=${storedFile.fileName}, localPath=${storedFile.localPath}, fileSize=${storedFile.fileSize}, storedMimeType=${storedFile.mimeType ?? "undefined"}`,
      );

      const text = `Please review the attached file ${storedFile.fileName}.`;
      const mime = storedFile.mimeType ?? inferMimeType(storedFile.fileName);
      const fileUrl = isImageMimeType(mime)
        ? await toDataUri(storedFile.localPath, mime)
        : pathToFileURL(storedFile.localPath).href;

      logger.debug(
        `[RuntimeEventHandlers] HOP-3 Parts constructed: resolvedMime=${mime}, isImage=${isImageMimeType(mime)}, urlScheme=${fileUrl.slice(0, 30)}..., urlLength=${fileUrl.length}`,
      );

      const parts: PromptPartInput[] = [
        { type: "text", text },
        {
          type: "file",
          mime,
          filename: storedFile.fileName,
          url: fileUrl,
        },
      ];

      logger.info(
        `[RuntimeEventHandlers] HOP-3 Dispatching media prompt: parts=[${parts.map((p) => (p.type === "file" ? `file(mime=${p.mime},filename=${p.filename},urlLen=${p.url.length})` : `text(len=${p.text.length})`)).join(", ")}]`,
      );

      const result = await options.promptIngressHandler.handlePromptInput({
        messageId,
        chatId,
        text,
        parts,
      });
      await handlePromptResult(result, [storedFile]);
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

      const rawContent =
        typeof rawMessage?.content === "string" ? rawMessage.content : null;
      const messageType =
        typeof rawMessage?.message_type === "string"
          ? rawMessage.message_type
          : null;

      if (messageType === "post" && rawContent) {
        const imageSegments = extractPostImageKeys(rawContent);

        if (messageId && imageSegments.length === 0) {
          logger.debug(
            `[RuntimeEventHandlers] Post message contains no embedded images after extraction: messageId=${messageId}, chatId=${parsed.chatId}, textLen=${parsed.text.length}, rawContentLen=${rawContent.length}`,
          );
        }

        if (imageSegments.length > 0 && messageId) {
          logger.debug(
            `[RuntimeEventHandlers] Post contains ${imageSegments.length} embedded image(s), downloading: messageId=${messageId}, chatId=${parsed.chatId}, textLen=${parsed.text.length}`,
          );

          const storedFiles: StoredFile[] = [];
          const fileParts: PromptPartInput[] = [];
          let failedDownloads = 0;

          for (const segment of imageSegments) {
            try {
              const stored = await options.fileHandler.downloadFile(
                messageId,
                segment.imageKey,
                "image.png",
                "image",
              );
              storedFiles.push(stored);

              const mime = stored.mimeType ?? inferMimeType(stored.fileName);
              const dataUri = await toDataUri(stored.localPath, mime);
              fileParts.push({
                type: "file",
                mime,
                filename: stored.fileName,
                url: dataUri,
              });

              logger.debug(
                `[RuntimeEventHandlers] Post image downloaded: key=${segment.imageKey}, mime=${mime}, uriLen=${dataUri.length}`,
              );
            } catch (error: unknown) {
              failedDownloads += 1;
              logger.error(
                `[RuntimeEventHandlers] Failed to materialize post image: messageId=${messageId}, key=${segment.imageKey}`,
                error,
              );
            }
          }

          logger.info(
            `[RuntimeEventHandlers] Post image download summary: messageId=${messageId}, attempted=${imageSegments.length}, succeeded=${fileParts.length}, failed=${failedDownloads}`,
          );

          if (fileParts.length > 0) {
            const parts: PromptPartInput[] = [
              { type: "text", text: parsed.text },
              ...fileParts,
            ];

            logger.info(
              `[RuntimeEventHandlers] Dispatching post with ${fileParts.length} image(s) and text (len=${parsed.text.length})`,
            );

            const result = await options.promptIngressHandler.handlePromptInput(
              {
                messageId: parsed.messageId,
                chatId: parsed.chatId,
                text: parsed.text,
                parts,
              },
            );
            await handlePromptResult(result, storedFiles);
            return;
          }

          logger.warn(
            `[RuntimeEventHandlers] Skipping post image dispatch because no image parts were materialized: messageId=${messageId}, attempted=${imageSegments.length}`,
          );
        }
      }
    }

    const result = await options.promptIngressHandler.handleMessageEvent(event);
    await handlePromptResult(result);
  };

  const handlePromptResult = async (
    result: PromptIngressResult,
    storedFiles?: StoredFile[],
  ): Promise<void> => {
    if (result.kind === "appended") {
      if (options.onPromptDispatched) {
        await options.onPromptDispatched(result, storedFiles);
      }

      await options.pipelineController.recordFollowUpAppended(
        result.sessionId,
        result.followUpSummary,
      );
      await sendAppendFeedback(result.receiveId);
      logger.debug(
        `[RuntimeEventHandlers] Prompt appended to active session: ${JSON.stringify(
          {
            sessionId: result.sessionId,
            receiveId: result.receiveId,
            storedFileCount: storedFiles?.length ?? 0,
          },
        )}`,
      );
      return;
    }

    if (result.kind !== "dispatched") {
      if (result.kind === "blocked" && result.receiveId) {
        const isBusyBlock =
          result.reason === "session_busy" ||
          result.reason === "expected_text" ||
          result.guardDecision?.busy === true;
        if (isBusyBlock) {
          await sendBusyFeedback(result.receiveId);
        }
      }

      const identifiers = {
        kind: result.kind,
        ...(result.kind === "blocked" ? { reason: result.reason } : {}),
        ...(result.kind === "unsupported"
          ? { messageType: result.messageType }
          : {}),
      };
      logger.debug(
        `[RuntimeEventHandlers] Prompt result not dispatched: ${JSON.stringify({
          ...identifiers,
          storedFileCount: storedFiles?.length ?? 0,
          storedFiles: storedFiles?.map((sf) => sf.fileName) ?? [],
        })}`,
      );
      if (storedFiles) {
        logger.debug(
          `[RuntimeEventHandlers] Cleaning up stored files after non-dispatch: ${storedFiles.map((sf) => sf.fileName).join(", ")}`,
        );
        await Promise.all(
          storedFiles.map((sf) => options.fileHandler.cleanup(sf)),
        );
      }
      return;
    }

    if (options.onPromptDispatched) {
      await options.onPromptDispatched(result, storedFiles);
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
      const queueKey = chatId
        ? `chat:${chatId}`
        : messageId
          ? `message:${messageId}`
          : "chat:__default__";

      await enqueueMessageTask(queueKey, async () =>
        processMessageReceived(event),
      );
    },

    async handleCardAction(
      event: Record<string, unknown>,
    ): Promise<CardActionResponse> {
      const queueKey = getCardActionQueueKey(event);
      let response: CardActionResponse = {};
      await enqueueCardActionTask(queueKey, async () => {
        await options.questionCardHandler.handleCardAction(event);
        await options.permissionCardHandler.handleCardAction(event);
        response = await options.controlRouter.handleCardAction(event);
      });
      return response;
    },
  };
}
