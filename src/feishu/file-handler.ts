import { createReadStream } from "node:fs";
import { extname, join } from "node:path";
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
  data?: unknown;
  getReadableStream?: () => AsyncIterable<unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

export interface FeishuMessageResourceAPI {
  get(params: {
    params: { type: "file" | "image" };
    path: { message_id: string; file_key: string };
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
    messageResource: FeishuMessageResourceAPI;
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
  messageId: string;
  fileKey: string;
  fileName: string;
  fileSize: number;
  messageType: "file" | "image";
}

export interface FileValidationResult {
  valid: boolean;
  reason?: string;
}

class FilePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilePolicyError";
  }
}

const IMAGE_MIME_EXTENSION_MAP: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

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

  private logParseFailure(
    event: FeishuMessageReceiveEvent,
    reason: string,
    details?: Record<string, string | number | boolean | null>,
  ): null {
    const normalized = normalizeFeishuEvent(event);
    const rawMessage = normalized.message;
    const rawContent = getString(rawMessage?.content);
    const metadata = {
      reason,
      messageType: getString(rawMessage?.message_type),
      messageId: getString(rawMessage?.message_id),
      chatId: getString(rawMessage?.chat_id),
      contentLen: rawContent?.length ?? 0,
      ...details,
    };

    this.logger.warn(
      `[FileHandler] Failed to parse inbound media event: ${JSON.stringify(metadata)}`,
    );
    return null;
  }

  private describeDownloadTransport(
    response: FeishuResourceDownloadResult,
  ): string {
    const { data } = response;
    if (Buffer.isBuffer(data)) {
      return "buffer";
    }
    if (typeof data === "string") {
      return "string";
    }
    if (
      data instanceof Uint8Array ||
      ArrayBuffer.isView(data) ||
      data instanceof ArrayBuffer
    ) {
      return "typed-array";
    }
    if (typeof response.getReadableStream === "function") {
      return "stream";
    }

    return "unknown";
  }

  parseFileMessage(event: FeishuMessageReceiveEvent): ParsedFileMessage | null {
    const normalized = normalizeFeishuEvent(event);
    const rawMessage = normalized.message;
    if (!rawMessage) {
      return this.logParseFailure(event, "missing_message");
    }

    const messageType = getString(rawMessage.message_type);
    const messageId = getString(rawMessage.message_id);
    const rawContent = getString(rawMessage.content);
    if (!messageId || !rawContent) {
      return this.logParseFailure(event, "missing_message_id_or_content", {
        hasMessageId: Boolean(messageId),
        hasContent: Boolean(rawContent),
      });
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch {
      return this.logParseFailure(event, "invalid_json");
    }

    if (!isRecord(parsedContent)) {
      return this.logParseFailure(event, "parsed_content_not_object");
    }

    if (messageType === "file") {
      const fileKey = getString(parsedContent.file_key);
      const fileName = getString(parsedContent.file_name);
      const fileSize = getNumber(parsedContent.file_size);

      if (!fileKey || !fileName) {
        return this.logParseFailure(event, "missing_file_key_or_name", {
          hasFileKey: Boolean(fileKey),
          hasFileName: Boolean(fileName),
          fileSize: fileSize ?? 0,
        });
      }
      return {
        messageId,
        fileKey,
        fileName,
        fileSize: fileSize ?? 0,
        messageType: "file",
      };
    }

    if (messageType === "image") {
      const imageKey = getString(parsedContent.image_key);
      if (!imageKey) {
        return this.logParseFailure(event, "missing_image_key");
      }
      return {
        messageId,
        fileKey: imageKey,
        fileName: "image.png",
        fileSize: 0,
        messageType: "image",
      };
    }

    return this.logParseFailure(event, "unsupported_message_type", {
      messageType,
    });
  }

  validateFile(fileName: string, fileSize: number): FileValidationResult {
    const ext = extname(fileName).toLowerCase();

    if (!this.filePolicy.allowedExtensions.has(ext)) {
      return {
        valid: false,
        reason: `Unsupported file type "${ext}". Allowed types: ${Array.from(this.filePolicy.allowedExtensions).join(", ")}`,
      };
    }

    return this.validateFileSize(fileSize);
  }

  validateFileSize(fileSize: number): FileValidationResult {
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

  private normalizeContentType(
    contentType: string | string[] | undefined,
  ): string | null {
    const raw = Array.isArray(contentType) ? contentType[0] : contentType;
    if (!raw) {
      return null;
    }

    const normalized = raw.split(";")[0]?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : null;
  }

  private sniffMimeType(data: Buffer | string): string | null {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      return "image/png";
    }

    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return "image/jpeg";
    }

    if (
      buffer.length >= 6 &&
      (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buffer.subarray(0, 6).toString("ascii") === "GIF89a")
    ) {
      return "image/gif";
    }

    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }

    if (
      buffer.length >= 2 &&
      buffer.subarray(0, 2).toString("ascii") === "BM"
    ) {
      return "image/bmp";
    }

    const textPrefix = buffer.subarray(0, 256).toString("utf8").trimStart();
    if (textPrefix.startsWith("<svg") || textPrefix.startsWith("<?xml")) {
      return textPrefix.includes("<svg") ? "image/svg+xml" : null;
    }

    return null;
  }

  private resolveDownloadedFileMetadata(
    fileName: string,
    messageType: "file" | "image",
    response: FeishuResourceDownloadResult,
    downloadData: Buffer | string,
  ): {
    fileName: string;
    mimeType?: string;
    headerMimeType: string | null;
    sniffedMimeType: string | null;
  } {
    const headerMimeType = this.normalizeContentType(
      response.headers?.["content-type"],
    );
    const sniffedMimeType = this.sniffMimeType(downloadData);
    const mimeType =
      headerMimeType && headerMimeType !== "application/octet-stream"
        ? headerMimeType
        : (sniffedMimeType ??
          (messageType === "image"
            ? "image/png"
            : (headerMimeType ?? undefined)));

    if (messageType !== "image" || !mimeType) {
      return { fileName, mimeType, headerMimeType, sniffedMimeType };
    }

    const extension = IMAGE_MIME_EXTENSION_MAP[mimeType];
    if (!extension) {
      return { fileName, mimeType, headerMimeType, sniffedMimeType };
    }

    return {
      fileName: `image${extension}`,
      mimeType,
      headerMimeType,
      sniffedMimeType,
    };
  }

  private async readDownloadStream(
    stream: AsyncIterable<unknown>,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        continue;
      }

      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
        continue;
      }

      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
        continue;
      }

      if (ArrayBuffer.isView(chunk)) {
        chunks.push(
          Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
        continue;
      }

      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(chunk));
        continue;
      }

      throw new Error("Unsupported Feishu resource stream chunk.");
    }

    return Buffer.concat(chunks);
  }

  private async readDownloadData(
    response: FeishuResourceDownloadResult,
  ): Promise<Buffer | string> {
    const { data } = response;
    if (Buffer.isBuffer(data) || typeof data === "string") {
      return data;
    }

    if (data instanceof Uint8Array) {
      return Buffer.from(data);
    }

    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    if (typeof response.getReadableStream === "function") {
      return this.readDownloadStream(response.getReadableStream());
    }

    throw new Error("Unsupported Feishu resource payload.");
  }

  async downloadFile(
    messageId: string,
    fileKey: string,
    fileName: string,
    messageType: "file" | "image",
  ): Promise<StoredFile> {
    const startedAt = Date.now();
    this.logger.debug(
      `[FileHandler] Downloading file: ${fileName} (message=${messageId}, key=${fileKey}, type=${messageType})`,
    );

    const response = await this.client.im.messageResource.get({
      params: { type: messageType },
      path: { message_id: messageId, file_key: fileKey },
    });

    const downloadData = await this.readDownloadData(response);
    const fileSize = Buffer.isBuffer(downloadData)
      ? downloadData.length
      : Buffer.byteLength(downloadData);
    const validation = this.validateFileSize(fileSize);
    if (!validation.valid) {
      throw new FilePolicyError(validation.reason ?? "File too large.");
    }

    const metadata = this.resolveDownloadedFileMetadata(
      fileName,
      messageType,
      response,
      downloadData,
    );

    this.logger.debug(
      `[FileHandler] Download metadata resolved: message=${messageId}, key=${fileKey}, type=${messageType}, transport=${this.describeDownloadTransport(response)}, bytes=${fileSize}, headerMime=${metadata.headerMimeType ?? "unknown"}, sniffedMime=${metadata.sniffedMimeType ?? "unknown"}, finalMime=${metadata.mimeType ?? "unknown"}, finalFileName=${metadata.fileName}, durationMs=${Date.now() - startedAt}`,
    );

    const tempDir = await this.fileStore.createTempDir();
    const stored = await this.fileStore.storeFile(
      tempDir,
      metadata.fileName,
      downloadData,
      metadata.mimeType,
    );

    this.logger.info(
      `[FileHandler] Downloaded file: ${fileName} -> ${stored.localPath} (${stored.fileSize} bytes, mime=${stored.mimeType ?? "unknown"})`,
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
      return null;
    }

    // Image messages have a synthetic filename; skip extension validation.
    if (parsed.messageType === "file") {
      const validation = this.validateFile(parsed.fileName, parsed.fileSize);
      if (!validation.valid) {
        this.logger.info(
          `[FileHandler] File rejected before download: message=${parsed.messageId}, key=${parsed.fileKey}, fileName=${parsed.fileName}, declaredBytes=${parsed.fileSize}, reason=${validation.reason}`,
        );
        await this.replySender.sendText(
          receiveId,
          `⚠️ File upload rejected: ${validation.reason}`,
        );
        return null;
      }
    }

    try {
      const stored = await this.downloadFile(
        parsed.messageId,
        parsed.fileKey,
        parsed.fileName,
        parsed.messageType,
      );
      return stored;
    } catch (error: unknown) {
      if (error instanceof FilePolicyError) {
        this.logger.info(
          `[FileHandler] File rejected after download: message=${parsed.messageId}, key=${parsed.fileKey}, fileName=${parsed.fileName}, reason=${error.message}`,
        );
        await this.replySender.sendText(
          receiveId,
          `⚠️ File upload rejected: ${error.message}`,
        );
        return null;
      }

      this.logger.error(
        `[FileHandler] Failed to download file: message=${parsed.messageId}, key=${parsed.fileKey}, fileName=${parsed.fileName}, type=${parsed.messageType}`,
        error,
      );
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
    this.logger.debug(
      `[FileHandler] Egressing stored file: fileName=${storedFile.fileName}, localPath=${storedFile.localPath}, bytes=${storedFile.fileSize}, mime=${storedFile.mimeType ?? "unknown"}, receiveId=${receiveId}`,
    );
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
    this.logger.debug(
      `[FileHandler] Cleaning up stored file temp dir: fileName=${storedFile.fileName}, tempDir=${tempDir}`,
    );
    await this.fileStore.cleanupTempDir(tempDir);
  }
}
