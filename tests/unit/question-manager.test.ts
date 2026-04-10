import { describe, expect, it } from "vitest";
import { QuestionManager } from "../../src/question/manager.js";

const QUESTIONS = [
  {
    header: "Single choice",
    question: "Choose a color",
    options: [
      { label: "Red", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ],
  },
  {
    header: "Multi choice",
    question: "Choose features",
    options: [
      { label: "Cards", description: "Interactive cards" },
      { label: "Files", description: "File uploads" },
      { label: "Mentions", description: "@mentions" },
    ],
    multiple: true,
  },
];

describe("QuestionManager", () => {
  it("tracks the current question and transport-neutral message ids", () => {
    const manager = new QuestionManager();

    manager.startQuestions(QUESTIONS, "request-1");
    manager.selectOption(0, 1);
    manager.addMessageId("msg-1");
    manager.setActiveMessageId("msg-1");

    expect(manager.getRequestID()).toBe("request-1");
    expect(manager.getCurrentQuestion()).toEqual(QUESTIONS[0]);
    expect([...manager.getSelectedOptions(0)]).toEqual([1]);
    expect(manager.getSelectedAnswer(0)).toBe("* Blue: Cool");
    expect(manager.getSelectedAnswerLabels(0)).toEqual(["Blue"]);
    expect(manager.getMessageIds()).toEqual(["msg-1"]);
    expect(manager.isActiveMessage("msg-1")).toBe(true);

    manager.nextQuestion();

    expect(manager.getCurrentIndex()).toBe(1);
    expect(manager.getCurrentQuestion()).toEqual(QUESTIONS[1]);
    expect(manager.getActiveMessageId()).toBeNull();
  });

  it("supports multi-select toggles and custom input answers", () => {
    const manager = new QuestionManager();

    manager.startQuestions(QUESTIONS, "request-2");
    manager.nextQuestion();
    manager.selectOption(1, 0);
    manager.selectOption(1, 2);
    manager.selectOption(1, 0);
    manager.startCustomInput(1);
    manager.setCustomAnswer(1, "Custom feature set");

    expect([...manager.getSelectedOptions(1)]).toEqual([2]);
    expect(manager.isWaitingForCustomInput(1)).toBe(true);
    expect(manager.getCustomAnswer(1)).toBe("Custom feature set");
    expect(manager.hasCustomAnswer(1)).toBe(true);
  });

  it("returns multi-select labels in stable option order", () => {
    const manager = new QuestionManager();

    manager.startQuestions(QUESTIONS, "request-stable");
    manager.nextQuestion();

    manager.selectOption(1, 2);
    manager.selectOption(1, 0);

    expect(manager.getSelectedAnswerLabels(1)).toEqual(["Cards", "Mentions"]);
  });

  it("getAllAnswerValues preserves positional alignment", () => {
    const manager = new QuestionManager();

    manager.startQuestions(QUESTIONS, "request-alignment");
    manager.selectOption(0, 0);

    expect(manager.getAllAnswerValues()).toEqual([["Red"], []]);
  });

  it("prefers custom answers and resets state when a new question flow starts", () => {
    const manager = new QuestionManager();

    manager.startQuestions(QUESTIONS, "request-3");
    manager.selectOption(0, 0);
    manager.nextQuestion();
    manager.setCustomAnswer(1, "Bring your own answer");

    expect(manager.getAllAnswers()).toEqual([
      { question: "Choose a color", answer: "* Red: Warm" },
      { question: "Choose features", answer: "Bring your own answer" },
    ]);
    expect(manager.getAllAnswerValues()).toEqual([
      ["Red"],
      ["Bring your own answer"],
    ]);

    manager.startQuestions([QUESTIONS[0]], "request-4");

    expect(manager.getCurrentIndex()).toBe(0);
    expect(manager.getMessageIds()).toEqual([]);
    expect(manager.getRequestID()).toBe("request-4");
    expect(manager.getAllAnswers()).toEqual([]);
  });
});
