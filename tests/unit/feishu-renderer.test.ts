import { describe, it, expect, vi, type Mock } from "vitest";
import { FeishuRenderer } from "../../src/feishu/renderer.js";
import type { Client } from "@larksuiteoapi/node-sdk";

describe("FeishuRenderer", () => {
  const createMock = vi
    .fn()
    .mockResolvedValue({ data: { message_id: "msg-123" } });
  const patchMock = vi.fn().mockResolvedValue({});
  const deleteMock = vi.fn().mockResolvedValue({});

  const mockClient = {
    im: {
      message: {
        create: createMock,
        patch: patchMock,
        delete: deleteMock,
      },
    },
  } as unknown as Client;

  const renderer = new FeishuRenderer({
    client: mockClient,
    receiveIdType: "chat_id",
  });

  it("sends text message", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({ data: { message_id: "msg-123" } });

    const ids = await renderer.sendText("chat-1", "hello");

    expect(ids).toEqual(["msg-123"]);
    expect(createMock).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "chat-1",
        msg_type: "text",
        content: '{"text":"hello"}',
      },
    });
  });

  it("renders question card", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({ data: { message_id: "msg-123" } });

    const q = {
      question: "Which one?",
      header: "Question",
      options: [
        { label: "A", description: "Alpha" },
        { label: "B", description: "Beta" },
      ],
    };

    await renderer.renderQuestionCard("chat-1", q, "req-question-1");

    expect(createMock).toHaveBeenCalled();
    const args = createMock.mock.calls[0][0];
    expect(args.data.msg_type).toBe("interactive");
    const parsed = JSON.parse(args.data.content);
    expect(parsed.header.template).toBe("orange");
    expect(parsed.elements[1].tag).toBe("action");
    expect(parsed.elements[1].actions[0].value.action).toBe("question_answer");
    expect(parsed.elements[1].actions[0].value.requestId).toBe(
      "req-question-1",
    );
  });

  it("renders permission card", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({ data: { message_id: "msg-123" } });

    const req = {
      id: "req-1",
      sessionID: "sess-1",
      permission: "fs.read",
      patterns: ["/tmp/*"],
      metadata: {},
      always: [],
    };

    await renderer.renderPermissionCard("chat-1", req);
    const args = createMock.mock.calls[0][0];
    const parsed = JSON.parse(args.data.content);
    expect(parsed.header.template).toBe("red");
    expect(parsed.elements[1].actions[0].value.reply).toBe("approve");
  });

  it("renders status card", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({ data: { message_id: "msg-123" } });

    await renderer.renderStatusCard("chat-1", "Working", "Step 1...");
    const args = createMock.mock.calls[0][0];
    const parsed = JSON.parse(args.data.content);
    expect(parsed.header.template).toBe("blue");
    expect(parsed.elements[0].content).toBe("Step 1...");
  });

  it("updates card", async () => {
    patchMock.mockReset();
    patchMock.mockResolvedValue({});

    await renderer.updateStatusCard("msg-1", "Done", "All good", true);

    expect(patchMock).toHaveBeenCalled();
    const args = patchMock.mock.calls[0][0];
    expect(args.path.message_id).toBe("msg-1");

    const parsed = JSON.parse(args.data.content);
    expect(parsed.header.template).toBe("green");
    expect(parsed.config.update_multi).toBe(true);
  });

  it("deletes message", async () => {
    deleteMock.mockReset();
    deleteMock.mockResolvedValue({});

    await renderer.deleteMessage("msg-1");

    expect(deleteMock).toHaveBeenCalledWith({
      path: { message_id: "msg-1" },
    });
  });

  it("throws when sendCard API returns a non-zero code", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({ code: 99991663, msg: "rate limited" });

    await expect(
      renderer.sendCard("chat-1", {
        header: {
          title: { tag: "plain_text", content: "Test" },
          template: "blue",
        },
        elements: [{ tag: "markdown", content: "content" }],
      }),
    ).rejects.toThrow("code=99991663");
  });
});
