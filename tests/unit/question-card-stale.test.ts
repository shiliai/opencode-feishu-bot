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

function buildCardAction(options: {
  requestId: string;
  messageId: string;
  optionIndex?: number;
  action?: string;
}) {
  return {
    open_message_id: options.messageId,
    action: {
      value: {
        action: options.action ?? "question_answer",
        requestId: options.requestId,
        optionIndex: options.optionIndex ?? 0,
      },
    },
  };
}

describe("QuestionCardHandler - stale card rejection", () => {
  it("ignores card callback with an open_message_id that does not match the active card", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-1");
    manager.setActiveMessageId("msg-active-current");

    const handler = createHandler(manager, renderer, client);

    const result = await handler.handleCardAction(
      buildCardAction({
        requestId: "req-stale-1",
        messageId: "msg-old-expired",
      }),
    );

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

    const result = await handler.handleCardAction(
      buildCardAction({
        requestId: "req-stale-2",
        messageId: "msg-will-be-cleared",
      }),
    );

    expect(result).toEqual({});
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("ignores card callback when request identity does not match the active request", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-active");
    manager.setActiveMessageId("msg-active-3");

    const snapshotBefore = manager.getStateSnapshot();

    const handler = createHandler(manager, renderer, client);

    await handler.handleCardAction(
      buildCardAction({
        requestId: "req-different",
        messageId: "msg-active-3",
        optionIndex: 1,
      }),
    );

    const snapshotAfter = manager.getStateSnapshot();
    expect(snapshotAfter.currentIndex).toBe(snapshotBefore.currentIndex);
    expect(snapshotAfter.activeMessageId).toBe(snapshotBefore.activeMessageId);
    expect(snapshotAfter.isActive).toBe(snapshotBefore.isActive);
    expect(snapshotAfter.requestID).toBe(snapshotBefore.requestID);
    expect(snapshotAfter.selectedOptions.size).toBe(
      snapshotBefore.selectedOptions.size,
    );
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("requires open_message_id for stale-card protection", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-4");
    manager.setActiveMessageId("msg-active-4");

    const handler = createHandler(manager, renderer, client);

    await handler.handleCardAction({
      action: {
        value: {
          action: "question_answer",
          requestId: "req-stale-4",
          optionIndex: 0,
        },
      },
    });

    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("no OpenCode reply call is made for stale or invalid callback scenarios", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-stale-5");
    manager.setActiveMessageId("msg-active-5");

    const handler = createHandler(manager, renderer, client);

    await handler.handleCardAction(
      buildCardAction({
        requestId: "req-stale-5",
        messageId: "wrong-id",
        optionIndex: 0,
      }),
    );

    await handler.handleCardAction(
      buildCardAction({
        requestId: "wrong-request",
        messageId: "msg-active-5",
        optionIndex: 1,
      }),
    );

    await handler.handleCardAction({
      open_message_id: "msg-active-5",
      action: {
        value: { action: "other_action", requestId: "req-stale-5" },
      },
    });

    expect(client.question.reply).not.toHaveBeenCalled();
  });
});
