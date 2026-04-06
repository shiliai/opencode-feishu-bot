import { createReadStream } from "node:fs";
import { join, extname } from "node:path";
import type { Logger } from "../utils/logger.js";
import type { FileStore, StoredFile } from "./file-store.js";
import type { FeishuMessageReceiveEvent } from "./event-router.js";
import { normalizeFeishuEvent } from "./message-events.js";

export interface FilePolicy {
  maxFileSizeBytes: number;
  allowedExtensions: Set<string>;
}

export const DEFAULT_FILE_POLICY: FilePolicy = {
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedExtensions: new Set([
    ".txt",
    ".md",
    ".json",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".csv",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".bash",
    ".zsh",
    ".sql",
    ".graphql",
    ".proto",
    ".gitignore",
    ".env",
    ".ini",
    ".cfg",
    ".conf",
    ".pdf",
    ".doc",
    ".docx",
  ]),
};

export interface FeishuResourceDownloadResult {
  data: Buffer;
}

export interface FeishuResourceAPI {
  get(params: {
    path: { file_key: string };
  }): Promise<FeishuResourceDownloadResult>;
}

export interface FeishuFileUploadResult {
  data: { file_key: string };
}

export interface FeishuFileAPI {
  create(params: {
    data: {
      file_type: string;
      file_name: string;
      file: NodeJS.ReadableStream;
    };
  }): Promise<FeishuFileUploadResult>;
}

export interface FeishuMessageSendResult {
  data: { message_id: string };
}

export interface FeishuMessageAPI {
  create(params: {
    params: { receive_id_type: string };
    data: {
      receive_id: string;
      msg_type: string;
      content: string;
    };
  }): Promise<FeishuMessageSendResult>;
}

export interface FeishuFileClient {
  im: {
    resource: FeishuResourceAPI;
    file: FeishuFileAPI;
    message: FeishuMessageAPI;
  };
}

export interface FileReplySender {
  sendText(
    receiveId: string,
    text: string,
    receiveIdType?: string,
  ): Promise<string[]>;
}

export interface ParsedFileMessage {
  fileKey: string;
  fileName: string;
  fileSize: number;
}

export interface FileValidationResult {
  valid: boolean;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface FileHandlerOptions {
  fileStore: FileStore;
  client: FeishuFileClient;
  replySender: FileReplySender;
  filePolicy?: FilePolicy;
  logger?: Logger;
}

export class FileHandler {
  private readonly fileStore: FileStore;
  private readonly client: FeishuFileClient;
  private readonly replySender: FileReplySender;
  private readonly filePolicy: FilePolicy;
  private readonly logger: Logger;

  constructor(options: FileHandlerOptions) {
    this.fileStore = options.fileStore;
    this.client = options.client;
    this.replySender = options.replySender;
    this.filePolicy = options.filePolicy ?? DEFAULT_FILE_POLICY;
    this.logger = options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  isInboundFileMessage(event: FeishuMessageReceiveEvent): boolean {
    const normalized = normalizeFeishuEvent(event);
    const rawMessage = normalized.message;
    if (!rawMessage) return false;

    const messageType = getString(rawMessage.message_type);
    return messageType === "file" || messageType === "image";
  }

  parseFileMessage(event: FeishuMessageReceiveEvent): ParsedFileMessage | null {
    const normalized = normalizeFeishuEvent(event);
    const rawMessage = normalized.message;
    if (!rawMessage) return null;

    const messageType = getString(rawMessage.message_type);
    const rawContent = getString(rawMessage.content);
    if (!rawContent) return null;

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch {
      return null;
    }

    if (!isRecord(parsedContent)) return null;

    if (messageType === "file") {
      const fileKey = getString(parsedContent.file_key);
      const fileName = getString(parsedContent.file_name);
      const fileSize = getNumber(parsedContent.file_size);

      if (!fileKey || !fileName) return null;
      return { fileKey, fileName, fileSize: fileSize ?? 0 };
    }

    if (messageType === "image") {
      const imageKey = getString(parsedContent.image_key);
      if (!imageKey) return null;
      return { fileKey: imageKey, fileName: "image.png", fileSize: 0 };
    }

    return null;
  }

  validateFile(fileName: string, fileSize: number): FileValidationResult {
    const ext = extname(fileName).toLowerCase();

    if (!this.filePolicy.allowedExtensions.has(ext)) {
      return {
        valid: false,
        reason: `Unsupported file type "${ext}". Allowed types: ${Array.from(this.filePolicy.allowedExtensions).join(", ")}`,
      };
    }

    if (fileSize > this.filePolicy.maxFileSizeBytes) {
      const maxMB = (this.filePolicy.maxFileSizeBytes / (1024 * 1024)).toFixed(
        1,
      );
      const fileMB = (fileSize / (1024 * 1024)).toFixed(1);
      return {
        valid: false,
        reason: `File too large (${fileMB}MB). Maximum allowed size is ${maxMB}MB.`,
      };
    }

    return { valid: true };
  }

  async downloadFile(fileKey: string, fileName: string): Promise<StoredFile> {
    this.logger.debug(
      `[FileHandler] Downloading file: ${fileName} (key=${fileKey})`,
    );

    const response = await this.client.im.resource.get({
      path: { file_key: fileKey },
    });

    const tempDir = await this.fileStore.createTempDir();
    const stored = await this.fileStore.storeFile(
      tempDir,
      fileName,
      response.data,
    );

    this.logger.info(
      `[FileHandler] Downloaded file: ${fileName} -> ${stored.localPath} (${stored.fileSize} bytes)`,
    );
    return stored;
  }

  async handleInboundFile(
    event: FeishuMessageReceiveEvent,
    receiveId: string,
  ): Promise<StoredFile | null> {
    if (!this.isInboundFileMessage(event)) {
      return null;
    }

    const parsed = this.parseFileMessage(event);
    if (!parsed) {
      this.logger.warn("[FileHandler] Could not parse file message from event");
      return null;
    }

    const validation = this.validateFile(parsed.fileName, parsed.fileSize);
    if (!validation.valid) {
      this.logger.info(`[FileHandler] File rejected: ${validation.reason}`);
      await this.replySender.sendText(
        receiveId,
        `⚠️ File upload rejected: ${validation.reason}`,
      );
      return null;
    }

    try {
      const stored = await this.downloadFile(parsed.fileKey, parsed.fileName);
      return stored;
    } catch (error: unknown) {
      this.logger.error("[FileHandler] Failed to download file", error);
      await this.replySender.sendText(
        receiveId,
        "⚠️ Failed to download the file. Please try again.",
      );
      return null;
    }
  }

  async uploadAndSendFile(
    localPath: string,
    fileName: string,
    receiveId: string,
  ): Promise<string | undefined> {
    this.logger.debug(
      `[FileHandler] Uploading file: ${fileName} from ${localPath}`,
    );

    try {
      const uploadResult = await this.client.im.file.create({
        data: {
          file_type: "stream",
          file_name: fileName,
          file: createReadStream(localPath),
        },
      });

      const fileKey = uploadResult.data.file_key;
      this.logger.debug(`[FileHandler] File uploaded, file_key: ${fileKey}`);

      const sendResult = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: receiveId,
          msg_type: "file",
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      this.logger.info(
        `[FileHandler] File sent as message: ${sendResult.data.message_id}`,
      );
      return sendResult.data.message_id;
    } catch (error: unknown) {
      this.logger.error("[FileHandler] Failed to upload/send file", error);
      return undefined;
    }
  }

  async egressFile(
    storedFile: StoredFile,
    receiveId: string,
  ): Promise<string | undefined> {
    const messageId = await this.uploadAndSendFile(
      storedFile.localPath,
      storedFile.fileName,
      receiveId,
    );

    await this.cleanup(storedFile);
    return messageId;
  }

  async cleanup(storedFile: StoredFile): Promise<void> {
    const tempDir = join(storedFile.localPath, "..");
    await this.fileStore.cleanupTempDir(tempDir);
  }
}
