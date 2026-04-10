import { describe, expect, it } from "vitest";
import {
  buildPostPayload,
  buildCardPayload,
} from "../../src/feishu/payloads.js";
import {
  buildPermissionCard,
  buildQuestionCard,
  buildStatusCard,
} from "../../src/feishu/cards.js";

describe("Feishu payload contracts", () => {
  it("buildPostPayload returns a Feishu post body with locale, title, and text rows", () => {
    const payload = JSON.parse(
      buildPostPayload("Bridge Reply", [["First line"], ["Second line"]]),
    ) as Record<string, unknown>;

    expect(payload).toHaveProperty("zh_cn");

    const zhCn = payload.zh_cn as {
      title: string;
      content: Array<Array<{ tag: string; text: string }>>;
    };
    expect(zhCn.title).toBe("Bridge Reply");
    expect(zhCn.content).toEqual([
      [{ tag: "text", text: "First line" }],
      [{ tag: "text", text: "Second line" }],
    ]);
  });

  it("buildCardPayload enables update_multi when requested", () => {
    const payload = JSON.parse(
      buildCardPayload(buildStatusCard("Working", "Streaming", false), true),
    ) as {
      config?: { update_multi?: boolean };
      header: { template: string };
      elements: Array<{ tag: string; content?: string }>;
    };

    expect(payload.config?.update_multi).toBe(true);
    expect(payload.header.template).toBe("blue");
    expect(payload.elements[0]).toEqual({
      tag: "markdown",
      content: "Streaming",
    });
  });

  it("question cards encode question request identity in card actions", () => {
    const card = buildQuestionCard(
      {
        header: "Pick one",
        question: "Which framework?",
        options: [
          { label: "React", description: "Component UI" },
          { label: "Vue", description: "Progressive UI" },
        ],
      },
      "request-123",
    );

    expect(card.header?.template).toBe("orange");
    expect(card.elements?.[1]).toMatchObject({
      tag: "action",
      actions: [
        {
          value: {
            action: "question_answer",
            requestId: "request-123",
            optionIndex: 0,
          },
        },
        {
          value: {
            action: "question_answer",
            requestId: "request-123",
            optionIndex: 1,
          },
        },
      ],
    });
  });

  it("multi-select question cards use toggle and submit actions", () => {
    const card = buildQuestionCard(
      {
        header: "Pick several",
        question: "Which tools?",
        options: [
          { label: "Bash", description: "Terminal" },
          { label: "Read", description: "Files" },
        ],
        multiple: true,
      },
      "request-multi-1",
    );

    expect(card.elements?.[1]).toMatchObject({
      tag: "action",
      actions: [
        {
          value: {
            action: "question_toggle",
            requestId: "request-multi-1",
            optionIndex: 0,
          },
        },
        {
          value: {
            action: "question_toggle",
            requestId: "request-multi-1",
            optionIndex: 1,
          },
        },
      ],
    });
    expect(card.elements?.[3]).toMatchObject({
      tag: "action",
      actions: [
        {
          value: { action: "question_submit", requestId: "request-multi-1" },
        },
      ],
    });
  });

  it("permission cards encode approve, always, and deny actions", () => {
    const card = buildPermissionCard({
      id: "permission-1",
      sessionID: "session-1",
      permission: "bash",
      patterns: ["npm test"],
      metadata: {},
      always: [],
    });

    expect(card.header?.template).toBe("red");
    expect(card.elements?.[1]).toMatchObject({
      tag: "action",
      actions: [
        {
          value: {
            action: "permission_reply",
            reply: "approve",
            requestId: "permission-1",
          },
        },
        {
          value: {
            action: "permission_reply",
            reply: "always",
            requestId: "permission-1",
          },
        },
        {
          value: {
            action: "permission_reply",
            reply: "deny",
            requestId: "permission-1",
          },
        },
      ],
    });
  });
});
