import { describe, expect, it, vi, type Mock } from "vitest";
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

const MULTI_SELECT_QUESTION = {
  header: "Pick several",
  question: "Which tools do you use?",
  options: [
    { label: "Bash", description: "Terminal" },
    { label: "Read", description: "Files" },
    { label: "Edit", description: "Changes" },
  ],
  multiple: true,
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

function buildCardAction(options: {
  action?: "question_answer" | "question_toggle" | "question_submit";
  requestId: string;
  messageId: string;
  optionIndex?: number;
}) {
  const action = options.action ?? "question_answer";
  const value =
    action === "question_submit"
      ? { action, requestId: options.requestId }
      : {
          action,
          requestId: options.requestId,
          optionIndex: options.optionIndex ?? 0,
        };

  return {
    open_message_id: options.messageId,
    action: {
      value,
    },
  };
}

describe("QuestionCardHandler - handleCardAction", () => {
  it("forwards raw option labels to OpenCode for a single-question flow", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-single");
    manager.setActiveMessageId("msg-active-1");

    const handler = createHandler(manager, renderer, client);

    await handler.handleCardAction(
      buildCardAction({
        requestId: "req-single",
        messageId: "msg-active-1",
        optionIndex: 0,
      }),
    );

    expect(client.question.reply).toHaveBeenCalledTimes(1);
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-single",
      answers: [["React"]],
    });
  });

  it("keeps question state active after reply (cleared by server event)", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-last");
    manager.setActiveMessageId("msg-last-1");

    const handler = createHandler(manager, renderer, client);

    await handler.handleCardAction(
      buildCardAction({
        requestId: "req-last",
        messageId: "msg-last-1",
        optionIndex: 0,
      }),
    );

    expect(client.question.reply).toHaveBeenCalledTimes(1);
    expect(manager.isActive()).toBe(true);
  });

  it("batches answers across multiple questions and replies once at the end", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    (renderer.renderQuestionCard as Mock)
      .mockResolvedValueOnce("msg-card-q1")
      .mockResolvedValueOnce("msg-card-q2");

    manager.startQuestions([QUESTION, SECOND_QUESTION], "req-multi");

    const handler = createHandler(manager, renderer, client);

    await handler.handleQuestionEvent("chat-1", "source-msg-1");

    await handler.handleCardAction(
      buildCardAction({
        requestId: "req-multi",
        messageId: "msg-card-q1",
        optionIndex: 1,
      }),
    );

    expect(client.question.reply).not.toHaveBeenCalled();
    expect(manager.getCurrentIndex()).toBe(1);
    expect(manager.getCurrentQuestion()).toEqual(SECOND_QUESTION);
    expect(renderer.renderQuestionCard).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      SECOND_QUESTION,
      "req-multi",
    );
    expect(manager.getActiveMessageId()).toBe("msg-card-q2");

    await handler.handleCardAction(
      buildCardAction({
        requestId: "req-multi",
        messageId: "msg-card-q2",
        optionIndex: 0,
      }),
    );

    expect(client.question.reply).toHaveBeenCalledTimes(1);
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-multi",
      answers: [["Vue"], ["TypeScript"]],
    });
    // State is no longer cleared optimistically; server event clears it
    expect(manager.isActive()).toBe(true);
  });

  it("waits for an explicit submit action before replying to a multi-select question", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([MULTI_SELECT_QUESTION], "req-multi-select");

    const handler = createHandler(manager, renderer, client);
    await handler.handleQuestionEvent("chat-1", "source-msg-1");

    await handler.handleCardAction(
      buildCardAction({
        action: "question_toggle",
        requestId: "req-multi-select",
        messageId: "msg-card-new",
        optionIndex: 2,
      }),
    );
    await handler.handleCardAction(
      buildCardAction({
        action: "question_toggle",
        requestId: "req-multi-select",
        messageId: "msg-card-new",
        optionIndex: 0,
      }),
    );

    expect(client.question.reply).not.toHaveBeenCalled();

    await handler.handleCardAction(
      buildCardAction({
        action: "question_submit",
        requestId: "req-multi-select",
        messageId: "msg-card-new",
      }),
    );

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "req-multi-select",
      answers: [["Bash", "Edit"]],
    });
  });

  it("returns an empty object for non-question card actions", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-ignore");
    manager.setActiveMessageId("msg-ignore-1");

    const handler = createHandler(manager, renderer, client);

    const cardAction = {
      open_message_id: "msg-ignore-1",
      action: {
        value: { action: "control_cancel", requestId: "req-ignore" },
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
    // State is no longer cleared optimistically; server event clears it
    expect(manager.isActive()).toBe(true);
  });
});
