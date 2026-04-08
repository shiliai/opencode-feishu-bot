import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createAssistantTextEvents,
  createFileMessageEvent,
  createImageMessageEvent,
  createTextMessageEvent,
  createWriteToolEvent,
} from "./helpers/fixtures.js";

describe("file flow integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("downloads supported inbound files and uploads outbound tool artifacts", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.setSseEvents(
      createAssistantTextEvents({
        sessionId: "session-1",
        text: "Inbound file received",
      }),
    );

    await harness.handleMessageReceived(
      createFileMessageEvent({
        eventId: "evt-file-1",
        messageId: "source-msg-file-1",
        chatId: "chat-file-1",
        fileName: "notes.md",
        fileSize: 24,
      }),
    );

    await harness.flushSession();

    const downloaded = harness.getDownloadedFiles();
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]?.fileName).toBe("notes.md");
    expect(
      harness.feishuFileClient.im.messageResource.get,
    ).toHaveBeenCalledWith({
      params: { type: "file" },
      path: {
        message_id: "source-msg-file-1",
        file_key: "file-key-1",
      },
    });
    expect(harness.openCodeClients.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/project",
      parts: [
        { type: "text", text: "Please review the attached file notes.md." },
        expect.objectContaining({
          type: "file",
          filename: "notes.md",
          mime: "text/markdown",
          url: expect.stringMatching(/^file:\/\//),
        }),
      ],
    });

    harness.setSseEvents([
      createWriteToolEvent({
        sessionId: "session-1",
        filePath: "/workspace/project/generated.md",
        content: "Generated artifact contents",
      }),
    ]);

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-file-egress-1",
        messageId: "source-msg-file-egress-1",
        chatId: "chat-file-1",
        text: "Produce a file",
      }),
    );

    await harness.flushSession();

    expect(harness.feishuFileClient.im.file.create).toHaveBeenCalledTimes(1);
    expect(harness.feishuFileClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "chat-file-1",
        msg_type: "file",
        content: JSON.stringify({ file_key: "uploaded-file-key-1" }),
      },
    });
    await harness.fileHandler.cleanup(downloaded[0]!);
    expect(harness.fileStore.getActiveTempDirs()).toEqual([]);
  });

  it("forwards inbound Feishu images with an image MIME type", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.setSseEvents(
      createAssistantTextEvents({
        sessionId: "session-1",
        text: "Inbound image received",
      }),
    );

    await harness.handleMessageReceived(
      createImageMessageEvent({
        eventId: "evt-image-1",
        messageId: "source-msg-image-1",
        chatId: "chat-image-1",
        imageKey: "img-key-1",
      }),
    );

    await harness.flushSession();

    const downloaded = harness.getDownloadedFiles();
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]?.fileName).toBe("image.png");
    expect(
      harness.feishuFileClient.im.messageResource.get,
    ).toHaveBeenCalledWith({
      params: { type: "image" },
      path: {
        message_id: "source-msg-image-1",
        file_key: "img-key-1",
      },
    });
    expect(harness.openCodeClients.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/project",
      parts: [
        { type: "text", text: "Please review the attached file image.png." },
        expect.objectContaining({
          type: "file",
          filename: "image.png",
          mime: "image/png",
          url: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      ],
    });

    await harness.fileHandler.cleanup(downloaded[0]!);
    expect(harness.fileStore.getActiveTempDirs()).toEqual([]);
  });
});
