import { describe, it, expect } from "vitest";
import {
  buildStatusCard,
  buildQuestionCard,
  buildPermissionCard,
  buildControlCard
} from "../../src/feishu/cards.js";
import type { Question } from "../../src/question/types.js";
import type { PermissionRequest } from "../../src/permission/types.js";

describe("Feishu Card Builders", () => {
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
        { label: "Blue", description: "" }
      ]
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
        { label: "Blue", description: "" }
      ],
      multiple: true
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
      always: []
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
