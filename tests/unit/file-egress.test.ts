import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore, type StoredFile } from "../../src/feishu/file-store.js";
import {
  FileHandler,
  type FeishuFileClient,
  type FileReplySender,
} from "../../src/feishu/file-handler.js";

function createMockClient(
  uploadFileKey: string = "uploaded-fk-001",
  sendMessageId: string = "sent-msg-001",
  uploadShouldFail: boolean = false,
): FeishuFileClient {
  return {
    im: {
      resource: {
        get: vi.fn().mockResolvedValue({ data: Buffer.from("downloaded") }),
      },
      file: {
        create: uploadShouldFail
          ? vi.fn().mockRejectedValue(new Error("Upload failed: network error"))
          : vi.fn().mockResolvedValue({ data: { file_key: uploadFileKey } }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: sendMessageId } }),
      },
    },
  };
}

const mockReplySender: FileReplySender = {
  sendText: vi.fn().mockResolvedValue(["reply-msg-001"]),
};

describe("FileHandler egress", () => {
  let fileStore: FileStore;
  let client: FeishuFileClient;
  let handler: FileHandler;
  let tempDir: string;

  beforeEach(async () => {
    fileStore = new FileStore();
    tempDir = await fileStore.createTempDir();
    client = createMockClient();
    handler = new FileHandler({
      fileStore,
      client,
      replySender: mockReplySender,
    });
  });

  afterEach(async () => {
    await fileStore.cleanupAll();
  });

  function createLocalFile(fileName: string, content: string = "output data"): StoredFile {
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, content);
    return {
      localPath: filePath,
      fileName,
      fileSize: Buffer.byteLength(content),
    };
  }

  it("uploads a local file and sends it as a file message", async () => {
    const stored = createLocalFile("result.md", "# Generated output");

    const messageId = await handler.uploadAndSendFile(stored.localPath, stored.fileName, "chat-001");

    expect(messageId).toBe("sent-msg-001");
    expect(client.im.file.create).toHaveBeenCalledOnce();
    expect(client.im.message.create).toHaveBeenCalledOnce();

    const uploadCall = vi.mocked(client.im.file.create).mock.calls[0][0];
    expect(uploadCall.data.file_name).toBe("result.md");
    expect(uploadCall.data.file_type).toBe("stream");

    const sendCall = vi.mocked(client.im.message.create).mock.calls[0][0];
    expect(sendCall.data.receive_id).toBe("chat-001");
    expect(sendCall.data.msg_type).toBe("file");
    const content = JSON.parse(sendCall.data.content);
    expect(content.file_key).toBe("uploaded-fk-001");
  });

  it("cleans up temp file after successful egress", async () => {
    const stored = createLocalFile("output.ts", "const x = 1;");
    const filePath = stored.localPath;

    await handler.egressFile(stored, "chat-001");

    expect(existsSync(filePath)).toBe(false);
  });

  it("handles upload failure gracefully", async () => {
    const failClient = createMockClient("fk", "msg", true);
    const failHandler = new FileHandler({
      fileStore,
      client: failClient,
      replySender: mockReplySender,
    });

    const stored = createLocalFile("broken.ts", "code");

    const messageId = await failHandler.uploadAndSendFile(stored.localPath, stored.fileName, "chat-001");

    expect(messageId).toBeUndefined();
    expect(failClient.im.file.create).toHaveBeenCalledOnce();
    expect(failClient.im.message.create).not.toHaveBeenCalled();
  });

  it("cleans up temp file even after upload failure", async () => {
    const failClient = createMockClient("fk", "msg", true);
    const failHandler = new FileHandler({
      fileStore,
      client: failClient,
      replySender: mockReplySender,
    });

    const stored = createLocalFile("fail-output.py", "print('hi')");
    const filePath = stored.localPath;

    await failHandler.egressFile(stored, "chat-001");

    expect(existsSync(filePath)).toBe(false);
  });

  it("returns message_id from egressFile on success", async () => {
    const stored = createLocalFile("summary.json", "{}");

    const messageId = await handler.egressFile(stored, "chat-001");

    expect(messageId).toBe("sent-msg-001");
  });
});
