import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../src/feishu/file-store.js";
import {
  FileHandler,
  DEFAULT_FILE_POLICY,
  type FilePolicy,
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
    header: { event_id: "evt-reject-001", event_type: "im.message.receive_v1" },
    event: {
      message: {
        message_id: "msg-reject-001",
        chat_id: "chat-001",
        chat_type: "group",
        message_type: "file",
        content: JSON.stringify({ file_key: fileKey, file_name: fileName, file_size: fileSize }),
      },
      sender: { sender_id: { open_id: "ou_001" } },
    },
  };
}

function createMockClient(): FeishuFileClient {
  return {
    im: {
      resource: {
        get: vi.fn().mockResolvedValue({ data: Buffer.from("file content") }),
      },
      file: {
        create: vi.fn().mockResolvedValue({ data: { file_key: "uploaded-key" } }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: "sent-msg" } }),
      },
    },
  };
}

describe("File policy rejection", () => {
  let fileStore: FileStore;
  let client: FeishuFileClient;
  let replySender: FileReplySender;

  beforeEach(() => {
    fileStore = new FileStore();
    client = createMockClient();
    replySender = {
      sendText: vi.fn().mockResolvedValue(["reply-msg"]),
    };
  });

  afterEach(async () => {
    await fileStore.cleanupAll();
  });

  it("rejects unsupported file extension", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: DEFAULT_FILE_POLICY,
    });

    const event = createFileMessageEvent("fk_exe", "malware.exe", 1024);
    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).toBeNull();
    expect(replySender.sendText).toHaveBeenCalledOnce();
    const [sentReceiveId, sentText] = vi.mocked(replySender.sendText).mock.calls[0];
    expect(sentReceiveId).toBe("chat-001");
    expect(sentText).toContain("Unsupported file type");
    expect(sentText).toContain(".exe");
  });

  it("rejects oversized file", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: {
        maxFileSizeBytes: 1024,
        allowedExtensions: DEFAULT_FILE_POLICY.allowedExtensions,
      },
    });

    const event = createFileMessageEvent("fk_big", "large.txt", 2048);
    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).toBeNull();
    expect(replySender.sendText).toHaveBeenCalledOnce();
    const sentText = vi.mocked(replySender.sendText).mock.calls[0][1];
    expect(sentText).toContain("too large");
  });

  it("does not download or create temp files for rejected files", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: DEFAULT_FILE_POLICY,
    });

    const event = createFileMessageEvent("fk_zip", "archive.zip", 5000);
    await handler.handleInboundFile(event, "chat-001");

    expect(client.im.resource.get).not.toHaveBeenCalled();
    expect(fileStore.getActiveTempDirs()).toHaveLength(0);
  });

  it("does not download or create temp files for oversized files", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: {
        maxFileSizeBytes: 100,
        allowedExtensions: DEFAULT_FILE_POLICY.allowedExtensions,
      },
    });

    const event = createFileMessageEvent("fk_huge", "data.json", 99999);
    await handler.handleInboundFile(event, "chat-001");

    expect(client.im.resource.get).not.toHaveBeenCalled();
    expect(fileStore.getActiveTempDirs()).toHaveLength(0);
  });

  it("sends rejection reply message to user", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: DEFAULT_FILE_POLICY,
    });

    const event = createFileMessageEvent("fk_mp3", "audio.mp3", 500);
    await handler.handleInboundFile(event, "chat-target");

    expect(replySender.sendText).toHaveBeenCalledWith(
      "chat-target",
      expect.stringContaining("File upload rejected"),
    );
  });

  it("allows files with supported extensions", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: DEFAULT_FILE_POLICY,
    });

    const event = createFileMessageEvent("fk_ok", "script.py", 256);
    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("script.py");
    expect(replySender.sendText).not.toHaveBeenCalled();
  });

  it("allows files with no extension that have no extension check failure", async () => {
    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: DEFAULT_FILE_POLICY,
    });

    const event = createFileMessageEvent("fk_noext", "Makefile", 128);
    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).toBeNull();
    expect(replySender.sendText).toHaveBeenCalledOnce();
    const sentText = vi.mocked(replySender.sendText).mock.calls[0][1];
    expect(sentText).toContain("Unsupported file type");
  });

  it("custom policy allows additional extensions", async () => {
    const customPolicy: FilePolicy = {
      maxFileSizeBytes: DEFAULT_FILE_POLICY.maxFileSizeBytes,
      allowedExtensions: new Set([...DEFAULT_FILE_POLICY.allowedExtensions, ".exe"]),
    };

    const handler = new FileHandler({
      fileStore,
      client,
      replySender,
      filePolicy: customPolicy,
    });

    const event = createFileMessageEvent("fk_exe2", "app.exe", 1024);
    const result = await handler.handleInboundFile(event, "chat-001");

    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("app.exe");
  });
});
