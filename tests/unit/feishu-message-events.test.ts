import { describe, expect, it } from "vitest";
import type { FeishuMessageReceiveEvent } from "../../src/feishu/event-router.js";
import {
  extractMentionedOpenIds,
  extractPromptTextFromMessageContent,
  isSupportedPromptMessageType,
  parseFeishuPromptEvent,
  stripMentionPlaceholders,
} from "../../src/feishu/message-events.js";

function createEvent(overrides: Partial<FeishuMessageReceiveEvent> = {}): FeishuMessageReceiveEvent {
  return {
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender",
        },
      },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        mentions: [],
      },
    },
    ...overrides,
  };
}

describe("feishu message event helpers", () => {
  it("strips mention placeholders from text payloads", () => {
    expect(stripMentionPlaceholders("@_user_1 hello @_user_2 world")).toBe("hello world");
  });

  it("recognizes supported prompt message types", () => {
    expect(isSupportedPromptMessageType("text")).toBe(true);
    expect(isSupportedPromptMessageType("post")).toBe(true);
    expect(isSupportedPromptMessageType("file")).toBe(false);
  });

  it("extracts prompt text from post content", () => {
    const content = JSON.stringify({
      zh_cn: {
        title: "Build status",
        content: [
          [
            { tag: "text", text: "Line one" },
            { tag: "text", text: " + line two" },
          ],
        ],
      },
    });

    expect(extractPromptTextFromMessageContent("post", content)).toBe("Build status\nLine one + line two");
  });

  it("parses direct-message text events into prompt payloads", () => {
    const parsed = parseFeishuPromptEvent(
      createEvent({
        event: {
          sender: { sender_id: { open_id: "ou_sender" } },
          message: {
            message_id: "om_1",
            chat_id: "oc_1",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "hello there" }),
            mentions: [],
          },
        },
      }),
    );

    expect(parsed).toMatchObject({
      eventId: "evt-1",
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "p2p",
      messageType: "text",
      text: "hello there",
      senderOpenId: "ou_sender",
      isDirectMessage: true,
      botMentioned: false,
    });
  });

  it("accepts group text only when the bot is mentioned", () => {
    const event = createEvent({
      event: {
        sender: { sender_id: { open_id: "ou_sender" } },
        message: {
          message_id: "om_group",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 summarize this" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "ou_bot" },
              name: "OpenCode Bot",
            },
          ],
        },
      },
    });

    expect(extractMentionedOpenIds(parseFeishuPromptEvent(event, { botOpenId: "ou_bot" })?.mentions ?? [])).toEqual([
      "ou_bot",
    ]);
    expect(parseFeishuPromptEvent(event, { botOpenId: "ou_bot" })).toMatchObject({
      chatType: "group",
      botMentioned: true,
      text: "summarize this",
    });
    expect(parseFeishuPromptEvent(event, { botOpenId: "ou_other" })).toBeNull();
  });

  it("rejects unsupported or invalid payloads safely", () => {
    expect(
      parseFeishuPromptEvent(
        createEvent({
          event: {
            sender: { sender_id: { open_id: "ou_sender" } },
            message: {
              message_id: "om_file",
              chat_id: "oc_1",
              chat_type: "p2p",
              message_type: "file",
              content: JSON.stringify({ file_key: "file_1" }),
              mentions: [],
            },
          },
        }),
      ),
    ).toBeNull();

    expect(
      parseFeishuPromptEvent(
        createEvent({
          event: {
            sender: { sender_id: { open_id: "ou_sender" } },
            message: {
              message_id: "om_invalid",
              chat_id: "oc_1",
              chat_type: "p2p",
              message_type: "text",
              content: "{not-json}",
              mentions: [],
            },
          },
        }),
      ),
    ).toBeNull();
  });
});
