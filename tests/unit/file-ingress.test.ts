import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { FileStore } from "../../src/feishu/file-store.js";
import {
  FileHandler,
  DEFAULT_FILE_POLICY,
  type FeishuFileClient,
  type FileReplySender,
} from "../../src/feishu/file-handler.js";
import type { FeishuMessageReceiveEvent } from "../../src/feishu/event-router.js";

function createFileMessageEvent(
  fileKey: string,
  fileName: string,
  fileSize: number,
): FeishuMessageReceiveEvent {
  return {
    header: { event_id: "evt-file-001", event_type: "im.message.receive_v1" },
    event: {
      message: {
        message_id: "msg-file-001",
        chat_id: "chat-001",
        chat_type: "group",
        message_type: "file",
        content: JSON.stringify({ file_key: fileKey, file_name: fileName, file_size: fileSize }),
      },
      sender: { sender_id: { open_id: "ou_001" } },
    },
  };
}

function createTextMessageEvent(): FeishuMessageReceiveEvent {
  return {
    header: { event_id: "evt-text-001", event_type: "im.message.receive_v1" },
    event: {
      message: {
        message_id: "msg-text-001",
        chat_id: "chat-001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello world" }),
      },
      sender: { sender_id: { open_id: "ou_001" } },
    },
  };
}

function createMockClient(fileData: Buffer): FeishuFileClient {
  return {
    im: {
      resource: {
        get: vi.fn().mockResolvedValue({ data: fileData }),
      },
      file: {
        create: vi.fn().mockResolvedValue({ data: { file_key: "uploaded-key" } }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: "sent-msg-001" } }),
      },
    },
  };
}

const mockReplySender: FileReplySender = {
  sendText: vi.fn().mockResolvedValue(["reply-msg-001"]),
};

describe("FileHandler ingress", () => {
  let fileStore: FileStore;
  let handler: FileHandler;
  const sampleContent = Buffer.from("hello from feishu file");

  beforeEach(() => {
    fileStore = new FileStore();
    const client = createMockClient(sampleContent);
    handler = new FileHandler({
      fileStore,
      client,
      replySender: mockReplySender,
    });
  });

  afterEach(async () => {
    await fileStore.cleanupAll();
  });

  it("downloads a supported file and stores it in temp dir", async () => {
    const event = createFileMessageEvent("file_key_abc", "example.ts", sampleContent.length);

    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("example.ts");
    expect(result!.fileSize).toBe(sampleContent.length);
    expect(existsSync(result!.localPath)).toBe(true);

    const diskContent = await readFile(result!.localPath);
    expect(diskContent).toEqual(sampleContent);
  });

  it("returns correct metadata for downloaded file", async () => {
    const event = createFileMessageEvent("file_key_xyz", "config.json", 42);

    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("config.json");
    expect(result!.fileSize).toBe(sampleContent.length);
    expect(result!.localPath).toContain("config.json");
  });

  it("returns null for non-file messages", async () => {
    const event = createTextMessageEvent();

    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).toBeNull();
  });

  it("returns null for events with no event body", async () => {
    const event: FeishuMessageReceiveEvent = {
      header: { event_id: "evt-empty" },
    };

    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).toBeNull();
  });

  it("detects file messages via isInboundFileMessage", () => {
    const fileEvent = createFileMessageEvent("k", "f.txt", 10);
    const textEvent = createTextMessageEvent();

    expect(handler.isInboundFileMessage(fileEvent)).toBe(true);
    expect(handler.isInboundFileMessage(textEvent)).toBe(false);
  });

  it("parses file message metadata correctly", () => {
    const event = createFileMessageEvent("fk_123", "report.pdf", 1024);

    const parsed = handler.parseFileMessage(event);

    expect(parsed).toEqual({ fileKey: "fk_123", fileName: "report.pdf", fileSize: 1024 });
  });

  it("cleans up temp dir after cleanup is called", async () => {
    const event = createFileMessageEvent("fk_clean", "test.py", 5);
    const result = await handler.handleInboundFile(event, "chat-001");
    expect(result).not.toBeNull();

    const pathBefore = result!.localPath;
    expect(existsSync(pathBefore)).toBe(true);

    await handler.cleanup(result!);

    expect(existsSync(pathBefore)).toBe(false);
  });
});
