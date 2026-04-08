import type { Question } from "../../question/types.js";
import type { QuestionManager } from "../../question/manager.js";
import type { Logger } from "../../utils/logger.js";
import { logger as defaultLogger } from "../../utils/logger.js";

export const QUESTION_GUIDED_REPLY_PREFIX = "answer:";

export interface OpenCodeQuestionClient {
  question: {
    reply(params: {
      requestID: string;
      answers?: Array<Array<string>>;
    }): Promise<unknown>;
  };
}

export interface QuestionRenderer {
  renderQuestionCard(
    receiveId: string,
    question: Question,
    associatedMessageId: string,
  ): Promise<string | undefined>;
  sendText?(receiveId: string, text: string): Promise<string[]>;
}

export interface QuestionInteractionManager {
  clear(reason?: string): void;
  transition(options: {
    kind?: "question";
    expectedInput?: "callback" | "text" | "mixed";
    allowedCommands?: string[];
    metadata?: Record<string, unknown>;
    expiresInMs?: number | null;
  }): void;
}

export interface QuestionCardHandlerOptions {
  questionManager: QuestionManager;
  renderer: QuestionRenderer;
  openCodeClient: OpenCodeQuestionClient;
  interactionManager?: QuestionInteractionManager;
  logger?: Logger;
}

interface CardActionValue {
  action: string;
  messageId: string;
  optionIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractActionValue(
  event: Record<string, unknown>,
): CardActionValue | null {
  const actionObj = event.action;
  if (!isRecord(actionObj)) {
    return null;
  }

  const value = actionObj.value;
  if (!isRecord(value)) {
    return null;
  }

  if (value.action !== "question_answer") {
    return null;
  }

  if (
    typeof value.messageId !== "string" ||
    typeof value.optionIndex !== "number"
  ) {
    return null;
  }

  return {
    action: value.action,
    messageId: value.messageId,
    optionIndex: value.optionIndex,
  };
}

export class QuestionCardHandler {
  private readonly questionManager: QuestionManager;
  private readonly renderer: QuestionRenderer;
  private readonly openCodeClient: OpenCodeQuestionClient;
  private readonly interactionManager?: QuestionInteractionManager;
  private readonly logger: Logger;
  private activeReceiveId: string | null = null;
  private activeSourceMessageId: string | null = null;

  constructor(options: QuestionCardHandlerOptions) {
    this.questionManager = options.questionManager;
    this.renderer = options.renderer;
    this.openCodeClient = options.openCodeClient;
    this.interactionManager = options.interactionManager;
    this.logger = options.logger ?? defaultLogger;
  }

  canHandleTextReply(text: string): boolean {
    const question = this.questionManager.getCurrentQuestion();
    if (!this.questionManager.isActive() || !question) {
      return false;
    }

    const normalized = text.trim().toLowerCase();
    return normalized.startsWith(QUESTION_GUIDED_REPLY_PREFIX);
  }

  async handleTextReply(text: string): Promise<boolean> {
    if (!this.canHandleTextReply(text)) {
      return false;
    }

    const answer = text
      .trim()
      .slice(QUESTION_GUIDED_REPLY_PREFIX.length)
      .trim();
    if (!answer) {
      return false;
    }

    const currentIndex = this.questionManager.getCurrentIndex();
    const requestID = this.questionManager.getRequestID();
    if (!requestID) {
      this.logger.warn(
        "[QuestionCardHandler] No requestID found for guided reply",
      );
      return false;
    }

    this.questionManager.setCustomAnswer(currentIndex, answer);
    await this.openCodeClient.question.reply({
      requestID,
      answers: [[answer]],
    });

    await this.advanceQuestionFlow();
    return true;
  }

  async handleQuestionEvent(
    receiveId: string,
    sourceMessageId: string,
  ): Promise<void> {
    const question = this.questionManager.getCurrentQuestion();
    if (!question) {
      this.logger.debug("[QuestionCardHandler] No active question to render");
      return;
    }

    this.activeReceiveId = receiveId;
    this.activeSourceMessageId = sourceMessageId;

    if (question.custom && this.renderer.sendText) {
      await this.renderer.sendText(
        receiveId,
        `Reply with \`${QUESTION_GUIDED_REPLY_PREFIX} <your answer>\` to submit a custom answer for: ${question.question}`,
      );
    }

    if (question.options.length === 0) {
      return;
    }

    try {
      const messageId = await this.renderer.renderQuestionCard(
        receiveId,
        question,
        sourceMessageId,
      );

      if (messageId) {
        this.questionManager.setActiveMessageId(messageId);
        this.logger.debug(
          `[QuestionCardHandler] Rendered question card: messageId=${messageId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        "[QuestionCardHandler] Failed to render question card",
        error,
      );
    }
  }

  async handleCardAction(
    event: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    const actionValue = extractActionValue(event);
    if (!actionValue) {
      return {};
    }

    const { messageId, optionIndex } = actionValue;

    if (!this.questionManager.isActiveMessage(messageId)) {
      this.logger.debug(
        `[QuestionCardHandler] Ignoring stale card action: messageId=${messageId}`,
      );
      return {};
    }

    const currentIndex = this.questionManager.getCurrentIndex();
    this.questionManager.selectOption(currentIndex, optionIndex);

    const selectedAnswer = this.questionManager.getSelectedAnswer(currentIndex);
    const requestID = this.questionManager.getRequestID();

    if (!requestID) {
      this.logger.warn(
        "[QuestionCardHandler] No requestID found, skipping reply",
      );
      return {};
    }

    await this.openCodeClient.question.reply({
      requestID,
      answers: [[selectedAnswer]],
    });

    this.logger.debug(
      `[QuestionCardHandler] Forwarded answer for question ${currentIndex}: ${selectedAnswer}`,
    );

    await this.advanceQuestionFlow();

    return {};
  }

  private async advanceQuestionFlow(): Promise<void> {
    this.questionManager.nextQuestion();

    if (this.questionManager.hasNextQuestion()) {
      const nextQuestion = this.questionManager.getCurrentQuestion();
      if (!nextQuestion) {
        return;
      }

      this.syncInteractionState(nextQuestion);

      if (!this.activeReceiveId || !this.activeSourceMessageId) {
        this.logger.warn(
          "[QuestionCardHandler] Missing render context for next question",
        );
        return;
      }

      await this.handleQuestionEvent(
        this.activeReceiveId,
        this.activeSourceMessageId,
      );
      return;
    }

    this.questionManager.clear();
    this.interactionManager?.clear("question_answered");
    this.activeReceiveId = null;
    this.activeSourceMessageId = null;
  }

  private syncInteractionState(question: Question): void {
    if (!this.interactionManager) {
      return;
    }

    const expectedInput =
      question.options.length > 0 && question.custom
        ? "mixed"
        : question.options.length > 0
          ? "callback"
          : "text";

    this.interactionManager.transition({
      kind: "question",
      expectedInput,
      allowedCommands: ["/help", "/status", "/abort"],
      metadata: {
        answerPrefix: QUESTION_GUIDED_REPLY_PREFIX,
      },
      expiresInMs: null,
    });
  }
}
