import { describe, expect, it, vi } from "vitest";
import {
  QuestionCardHandler,
  type QuestionRenderer,
} from "../../src/feishu/handlers/question.js";
import { QuestionManager } from "../../src/question/manager.js";
import type { Logger } from "../../src/utils/logger.js";

const QUESTION = {
  header: "Choose a language",
  question: "Which programming language do you prefer?",
  options: [
    { label: "TypeScript", description: "Static typing for JS" },
    { label: "Python", description: "Dynamic scripting" },
  ],
};

function createMockRenderer(): QuestionRenderer {
  return {
    renderQuestionCard: vi.fn().mockResolvedValue("msg-card-123"),
  };
}

function createMockOpenCodeClient() {
  const reply = vi.fn().mockResolvedValue({ data: { success: true } });
  return { question: { reply } };
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("QuestionCardHandler - handleQuestionEvent", () => {
  it("renders a question card when question manager has an active question", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    manager.startQuestions([QUESTION], "req-1");

    const handler = new QuestionCardHandler({
      questionManager: manager,
      renderer,
      openCodeClient: client,
    });

    await handler.handleQuestionEvent("chat-abc", "msg-source-456");

    expect(renderer.renderQuestionCard).toHaveBeenCalledTimes(1);
    expect(renderer.renderQuestionCard).toHaveBeenCalledWith(
      "chat-abc",
      QUESTION,
      "msg-source-456",
    );
    expect(manager.getActiveMessageId()).toBe("msg-card-123");
  });

  it("stores the returned message ID via setActiveMessageId", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    renderer.renderQuestionCard.mockResolvedValue("msg-unique-id-999");

    manager.startQuestions([QUESTION], "req-2");

    const handler = new QuestionCardHandler({
      questionManager: manager,
      renderer,
      openCodeClient: client,
    });

    await handler.handleQuestionEvent("chat-1", "msg-source-1");

    expect(manager.getActiveMessageId()).toBe("msg-unique-id-999");
    expect(manager.isActiveMessage("msg-unique-id-999")).toBe(true);
  });

  it("does not render a card when no active question exists", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();

    const handler = new QuestionCardHandler({
      questionManager: manager,
      renderer,
      openCodeClient: client,
    });

    await handler.handleQuestionEvent("chat-1", "msg-source-1");

    expect(renderer.renderQuestionCard).not.toHaveBeenCalled();
  });

  it("logs error but does not re-throw when renderer throws", async () => {
    const manager = new QuestionManager();
    const renderer = createMockRenderer();
    const client = createMockOpenCodeClient();
    const logger = createMockLogger();

    renderer.renderQuestionCard.mockRejectedValue(new Error("Feishu API timeout"));

    manager.startQuestions([QUESTION], "req-3");

    const handler = new QuestionCardHandler({
      questionManager: manager,
      renderer,
      openCodeClient: client,
      logger,
    });

    await expect(
      handler.handleQuestionEvent("chat-1", "msg-source-1"),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain("Failed to render question card");
  });
});
