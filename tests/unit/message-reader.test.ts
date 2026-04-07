import { describe, expect, it, vi } from "vitest";
import type { FeishuClients } from "../../src/feishu/client.js";
import { MessageReader } from "../../src/feishu/message-reader.js";

function createMessageClient(items: unknown[]) {
  const list = vi.fn().mockResolvedValue({
    code: 0,
    data: {
      items,
    },
  });

  const client = {
    im: {
      message: {
        list,
      },
    },
  } as unknown as FeishuClients["client"];

  return { client, list };
}

describe("MessageReader", () => {
  it("strips reasoning tags from text message history", async () => {
    const { client } = createMessageClient([
      {
        message_id: "om_1",
        msg_type: "text",
        create_time: "1710000000000",
        chat_id: "oc_1",
        body: {
          content: JSON.stringify({
            text: "<thinking>internal reasoning</thinking>Final answer",
          }),
        },
        sender: {
          id: "ou_sender",
          sender_type: "user",
        },
      },
    ]);

    const reader = new MessageReader({ client });
    const messages = await reader.getChatMessages({ chatId: "oc_1", count: 1 });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Final answer");
  });

  it("removes Reasoning-prefixed payloads from history preview text", async () => {
    const { client } = createMessageClient([
      {
        message_id: "om_2",
        msg_type: "text",
        create_time: "1710000000000",
        chat_id: "oc_1",
        body: {
          content: JSON.stringify({
            text: "Reasoning:\n_line one_\n_line two_",
          }),
        },
        sender: {
          id: "ou_sender",
          sender_type: "app",
        },
      },
    ]);

    const reader = new MessageReader({ client });
    const messages = await reader.getChatMessages({ chatId: "oc_1", count: 1 });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("");
  });
});
