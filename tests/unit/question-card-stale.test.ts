import { describe, expect, it, vi } from "vitest";
import {
  QuestionCardHandler,
  type QuestionRenderer,
} from "../../src/feishu/handlers/question.js";
import { QuestionManager } from "../../src/question/manager.js";

const QUESTION = {
  header: "Choose",
  question: "Pick one?",
  options: [
    { label: "A", description: "Option A" },
    { label: "B", description: "Option B" },
  ],
};

function createMockRenderer(): QuestionRenderer {
  return {
    renderQuestionCard: vi.fn().mockResolvedValue("msg-rendered"),
  };
}

function createMockOpenCodeClient() {
  const reply = vi.fn().mockResolvedValue({ data: { success: true } });
  return { question: { reply } };
}

function createHandler(
  manager: QuestionManager,
  renderer: QuestionRenderer,
  client: ReturnType<typeof createMockOpenCodeClient>,
) {
  return new QuestionCardHandler({
    questionManager: manager,
    renderer,
    openCodeClient: client,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("QuestionCardHandler - stale card rejection", () => {
  it("ignores card callback with a messageId that does not match the active card", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-1");
    manager.setActiveMessageId("msg-active-current");

    const handler = createHandler(manager, renderer, client);

    const staleAction = {
      action: {
        value: { action: "question_answer", messageId: "msg-old-expired", optionIndex: 0 },
      },
    };

    const result = await handler.handleCardAction(staleAction);

    expect(result).toEqual({});
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("ignores card callback after question state has been cleared", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-2");
    manager.setActiveMessageId("msg-will-be-cleared");
    manager.clear();

    const handler = createHandler(manager, renderer, client);

    const action = {
      action: {
        value: { action: "question_answer", messageId: "msg-will-be-cleared", optionIndex: 0 },
      },
    };

    const result = await handler.handleCardAction(action);

    expect(result).toEqual({});
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("does not alter question manager state when processing a stale callback", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-3");
    manager.setActiveMessageId("msg-active-3");

    const snapshotBefore = manager.getStateSnapshot();

    const handler = createHandler(manager, renderer, client);

    const staleAction = {
      action: {
        value: { action: "question_answer", messageId: "msg-different-id", optionIndex: 1 },
      },
    };

    await handler.handleCardAction(staleAction);

    const snapshotAfter = manager.getStateSnapshot();
    expect(snapshotAfter.currentIndex).toBe(snapshotBefore.currentIndex);
    expect(snapshotAfter.activeMessageId).toBe(snapshotBefore.activeMessageId);
    expect(snapshotAfter.isActive).toBe(snapshotBefore.isActive);
    expect(snapshotAfter.requestID).toBe(snapshotBefore.requestID);
    expect(snapshotAfter.selectedOptions.size).toBe(snapshotBefore.selectedOptions.size);
  });

  it("no OpenCode reply call is made for any stale callback scenario", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-4");
    manager.setActiveMessageId("msg-active-4");

    const handler = createHandler(manager, renderer, client);

    await handler.handleCardAction({
      action: {
        value: { action: "question_answer", messageId: "wrong-id", optionIndex: 0 },
      },
    });

    await handler.handleCardAction({
      action: {
        value: { action: "question_answer", messageId: "also-wrong", optionIndex: 1 },
      },
    });

    await handler.handleCardAction({
      action: {
        value: { action: "other_action", messageId: "msg-active-4", optionIndex: 0 },
      },
    });

    expect(client.question.reply).not.toHaveBeenCalled();
  });
});
