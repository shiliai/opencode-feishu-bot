import { describe, it, expect } from "vitest";
import {
  buildStatusCard,
  buildQuestionCard,
  buildPermissionCard,
  buildControlCard,
  buildThinkingCard,
  buildStreamingCard,
  buildCompleteCard,
  STREAMING_ELEMENT_ID,
  REASONING_ELEMENT_ID,
} from "../../src/feishu/cards.js";
import type { Question } from "../../src/question/types.js";
import type { PermissionRequest } from "../../src/permission/types.js";
import type { StatusTurnState } from "../../src/feishu/status-store.js";

describe("Feishu Card Builders", () => {
  it("exports required element constants", () => {
    expect(STREAMING_ELEMENT_ID).toBe("streaming_content");
    expect(REASONING_ELEMENT_ID).toBe("reasoning_content");
  });

  it("buildThinkingCard", () => {
    const card = buildThinkingCard("Agent Working", "Setting up context...");
    expect(card).toMatchSnapshot();
  });

  it("buildStreamingCard", () => {
    const mockState = {
      turnStartTime: Date.now() - 5000,
      accumulatedReasoning: "I should use bash.",
      toolEvents: [
        {
          sessionId: "s1",
          messageId: "m1",
          callId: "c1",
          tool: "bash",
          title: "npm install",
          status: "completed",
        },
      ],
      lastPartialText: "Installing dependencies...",
      latestTokens: {
        input: 10,
        output: 20,
        reasoning: 5,
        cacheRead: 0,
        cacheWrite: 0,
      },
    } as unknown as StatusTurnState;

    const card = buildStreamingCard("Agent Working", mockState);
    const cardStr = JSON.stringify(card);
    expect(cardStr).toContain("Agent Working");
    expect(cardStr).toContain("I should use bash.");
    expect(cardStr).toContain("Installing dependencies...");
  });

  it("buildCompleteCard", () => {
    const card = buildCompleteCard("Agent Working", "Task complete.", {
      reasoningText: "I finished the task.",
      reasoningDurationMs: 1500,
      elapsedMs: 2500,
      toolEvents: [
        {
          sessionId: "s1",
          messageId: "m1",
          callId: "c1",
          tool: "bash",
          title: "npm install",
          status: "completed",
        },
      ],
      tokens: {
        input: 100,
        output: 50,
        reasoning: 20,
        cacheRead: 10,
        cacheWrite: 5,
      },
      template: "green",
    });
    expect(card).toMatchSnapshot();
  });

  it("buildStatusCard - ongoing", () => {
    const card = buildStatusCard("Status", "Working on it...", false, "blue");
    expect(card).toMatchSnapshot();
  });

  it("buildStatusCard - completed", () => {
    const card = buildStatusCard("Status", "Done!", true, "blue");
    expect(card).toMatchSnapshot();
  });

  it("buildQuestionCard - single choice", () => {
    const q: Question = {
      question: "Which color?",
      header: "Color Selection",
      options: [
        { label: "Red", description: "" },
        { label: "Blue", description: "" },
      ],
    };
    const card = buildQuestionCard(q, "msg-1");
    expect(card).toMatchSnapshot();
  });

  it("buildQuestionCard - multiple choice", () => {
    const q: Question = {
      question: "Which colors?",
      header: "Color Selection",
      options: [
        { label: "Red", description: "" },
        { label: "Blue", description: "" },
      ],
      multiple: true,
    };
    const card = buildQuestionCard(q, "msg-2");
    expect(card).toMatchSnapshot();
  });

  it("buildPermissionCard", () => {
    const req: PermissionRequest = {
      id: "req-1",
      sessionID: "sess-1",
      permission: "fs.write",
      patterns: ["/tmp/test.txt"],
      metadata: {},
      always: [],
    };
    const card = buildPermissionCard(req);
    expect(card).toMatchSnapshot();
  });

  it("buildControlCard - no cancel", () => {
    const card = buildControlCard("Running");
    expect(card).toMatchSnapshot();
  });

  it("buildControlCard - with cancel", () => {
    const card = buildControlCard("Running", { showCancel: true });
    expect(card).toMatchSnapshot();
  });
});
