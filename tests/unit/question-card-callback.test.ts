import { describe, expect, it, vi } from "vitest";
import {
  QuestionCardHandler,
  type QuestionRenderer,
} from "../../src/feishu/handlers/question.js";
import { QuestionManager } from "../../src/question/manager.js";

const QUESTION = {
  header: "Pick one",
  question: "Which framework?",
  options: [
    { label: "React", description: "Component library" },
    { label: "Vue", description: "Progressive framework" },
  ],
};

const SECOND_QUESTION = {
  header: "Pick another",
  question: "Which language?",
  options: [
    { label: "TypeScript", description: "Static typing" },
    { label: "JavaScript", description: "Dynamic scripting" },
  ],
};

function createMockRenderer(): QuestionRenderer {
  return {
    renderQuestionCard: vi.fn().mockResolvedValue("msg-card-new"),
    sendText: vi.fn().mockResolvedValue(["msg-guidance-1"]),
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

describe("QuestionCardHandler - handleCardAction", () => {
  it("forwards exactly one answer to OpenCode for a single-question flow", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-single");
    manager.setActiveMessageId("msg-active-1");

    const handler = createHandler(manager, renderer, client);

    const cardAction = {
      action: {
        value: { action: "question_answer", messageId: "msg-active-1", optionIndex: 0 },
      },
    };

    await handler.handleCardAction(cardAction);

    expect(client.question.reply).toHaveBeenCalledTimes(1);
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-single",
      answers: [["* React: Component library"]],
    });
  });

  it("answer text matches the selected option's label and description", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-label");
    manager.setActiveMessageId("msg-label-1");

    const handler = createHandler(manager, renderer, client);

    const cardAction = {
      action: {
        value: { action: "question_answer", messageId: "msg-label-1", optionIndex: 1 },
      },
    };

    await handler.handleCardAction(cardAction);

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-label",
      answers: [["* Vue: Progressive framework"]],
    });
  });

  it("clears question state after answering the last question", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-last");

    const handler = createHandler(manager, renderer, client);

    manager.setActiveMessageId("msg-last-1");

    const cardAction = {
      action: {
        value: { action: "question_answer", messageId: "msg-last-1", optionIndex: 0 },
      },
    };

    await handler.handleCardAction(cardAction);

    expect(manager.isActive()).toBe(false);
  });

  it("renders the next question card and does not clear when more questions remain", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION, SECOND_QUESTION], "req-multi");
    manager.setActiveMessageId("msg-multi-1");

    const handler = createHandler(manager, renderer, client);

    await handler.handleQuestionEvent("chat-1", "source-msg-1");

    const cardAction = {
      action: {
        value: { action: "question_answer", messageId: "msg-card-new", optionIndex: 1 },
      },
    };

    await handler.handleCardAction(cardAction);

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-multi",
      answers: [["* Vue: Progressive framework"]],
    });

    expect(manager.getCurrentIndex()).toBe(1);
    expect(manager.getCurrentQuestion()).toEqual(SECOND_QUESTION);

    expect(renderer.renderQuestionCard).toHaveBeenCalledTimes(2);
    expect(renderer.renderQuestionCard).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      SECOND_QUESTION,
      "source-msg-1",
    );
    expect(manager.getActiveMessageId()).toBe("msg-card-new");

    expect(manager.isActive()).toBe(true);
  });

  it("returns an empty object for non-question card actions", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-ignore");
    manager.setActiveMessageId("msg-ignore-1");

    const handler = createHandler(manager, renderer, client);

    const cardAction = {
      action: {
        value: { action: "control_cancel", messageId: "msg-ignore-1" },
      },
    };

    const result = await handler.handleCardAction(cardAction);

    expect(result).toEqual({});
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("returns an empty object when action value is missing", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    const handler = createHandler(manager, renderer, client);

    const result = await handler.handleCardAction({ action: {} });

    expect(result).toEqual({});
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it("supports guided text replies for custom-answer questions", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions(
      [
        {
          header: "Custom",
          question: "Provide your own answer",
          options: [],
          custom: true,
        },
      ],
      "req-custom",
    );

    const handler = createHandler(manager, renderer, client);
    await handler.handleQuestionEvent("chat-1", "source-msg-1");

    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("answer:"),
    );

    const handled = await handler.handleTextReply("answer: my custom answer");

    expect(handled).toBe(true);
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-custom",
      answers: [["my custom answer"]],
    });
    expect(manager.isActive()).toBe(false);
  });
});
