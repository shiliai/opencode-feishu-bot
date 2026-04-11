import type { InteractiveCard } from "@larksuiteoapi/node-sdk";
import type { Question } from "../../question/types.js";
import type { QuestionManager } from "../../question/manager.js";
import type { Logger } from "../../utils/logger.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import { buildResolvedQuestionCard } from "../cards.js";
import type { CardActionResponse } from "../control-router.js";

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
    requestId: string,
  ): Promise<string | undefined>;
  sendText?(receiveId: string, text: string): Promise<string[]>;
  updateCard?(messageId: string, card: InteractiveCard): Promise<void>;
}

export interface QuestionInteractionManager {
  clear(chatId: string, reason?: string): void;
  transition(
    chatId: string,
    options: {
      kind?: "question";
      expectedInput?: "callback" | "text" | "mixed";
      allowedCommands?: string[];
      metadata?: Record<string, unknown>;
      expiresInMs?: number | null;
    },
  ): void;
}

export interface QuestionCardHandlerOptions {
  questionManager: QuestionManager;
  renderer: QuestionRenderer;
  openCodeClient: OpenCodeQuestionClient;
  interactionManager?: QuestionInteractionManager;
  logger?: Logger;
}

type CardActionValue =
  | {
      action: "question_answer" | "question_toggle";
      requestId: string;
      optionIndex: number;
    }
  | {
      action: "question_submit";
      requestId: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCardActionPayload(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(event.event) ? event.event : event;
}

function extractActionValue(
  event: Record<string, unknown>,
): CardActionValue | null {
  const payload = getCardActionPayload(event);
  const actionObj = payload.action;
  if (!isRecord(actionObj)) {
    return null;
  }

  const value = actionObj.value;
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.action !== "question_answer" &&
    value.action !== "question_toggle" &&
    value.action !== "question_submit"
  ) {
    return null;
  }

  if (typeof value.requestId !== "string") {
    return null;
  }

  if (value.action === "question_submit") {
    return {
      action: value.action,
      requestId: value.requestId,
    };
  }

  if (typeof value.optionIndex !== "number") {
    return null;
  }

  return {
    action: value.action,
    requestId: value.requestId,
    optionIndex: value.optionIndex,
  };
}

function extractOpenMessageId(event: Record<string, unknown>): string | null {
  const payload = getCardActionPayload(event);
  const context = isRecord(payload.context) ? payload.context : null;

  return typeof payload.open_message_id === "string"
    ? payload.open_message_id
    : typeof context?.open_message_id === "string"
      ? context.open_message_id
      : null;
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

    const requestID = this.questionManager.getRequestID();
    if (!requestID) {
      this.logger.warn(
        "[QuestionCardHandler] No requestID found for question card render",
      );
      return;
    }

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
        requestID,
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
  ): Promise<CardActionResponse> {
    const actionValue = extractActionValue(event);
    if (!actionValue) {
      return {};
    }

    const messageId = extractOpenMessageId(event);
    if (!messageId) {
      this.logger.warn(
        "[QuestionCardHandler] Card action missing open_message_id",
      );
      return {};
    }

    if (!this.questionManager.isActiveMessage(messageId)) {
      this.logger.debug(
        `[QuestionCardHandler] Ignoring stale card action: messageId=${messageId}`,
      );
      return {};
    }

    const requestID = this.questionManager.getRequestID();
    if (!requestID || requestID !== actionValue.requestId) {
      this.logger.warn(
        `[QuestionCardHandler] Request mismatch for card action: manager=${requestID ?? "missing"}, card=${actionValue.requestId}`,
      );
      return {};
    }

    const currentIndex = this.questionManager.getCurrentIndex();

    if (actionValue.action !== "question_submit") {
      this.questionManager.selectOption(currentIndex, actionValue.optionIndex);
    }

    const answerValues = this.questionManager.getAnswerValues(currentIndex);

    if (actionValue.action === "question_toggle") {
      const selectedLabels =
        this.questionManager.getSelectedAnswerLabels(currentIndex);
      this.logger.debug(
        `[QuestionCardHandler] Toggled selections for question ${currentIndex}: ${answerValues.join(", ")}`,
      );
      return {
        toast: {
          type: "info",
          content:
            selectedLabels.length > 0
              ? `Selected: ${selectedLabels.join(", ")}`
              : "Selection cleared",
        },
      };
    }

    if (answerValues.length === 0) {
      this.logger.debug(
        `[QuestionCardHandler] Ignoring question action without a completed answer: requestID=${requestID}, questionIndex=${currentIndex}, action=${actionValue.action}`,
      );
      return {};
    }

    this.logger.debug(
      `[QuestionCardHandler] Captured answer for question ${currentIndex}: ${answerValues.join(", ")}`,
    );

    await this.advanceQuestionFlow();

    return {
      toast: {
        type: "success",
        content: `Answer submitted: ${answerValues.join(", ")}`,
      },
    };
  }

  private async advanceQuestionFlow(): Promise<void> {
    const currentIndex = this.questionManager.getCurrentIndex();
    const totalQuestions = this.questionManager.getTotalQuestions();
    const isLastQuestion = currentIndex + 1 >= totalQuestions;

    if (!isLastQuestion) {
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
      }

      return;
    }

    const requestID = this.questionManager.getRequestID();
    if (!requestID) {
      this.logger.warn(
        "[QuestionCardHandler] No requestID found, skipping final reply",
      );
      return;
    }

    if (this.questionManager.isSubmitted(requestID)) {
      this.logger.debug(
        `[QuestionCardHandler] Ignoring duplicate question submission for request ${requestID}`,
      );
      return;
    }

    const answers = this.questionManager.getAllAnswerValues();

    const missingIndex = answers.findIndex((answer) => answer.length === 0);
    if (missingIndex !== -1) {
      this.logger.warn(
        `[QuestionCardHandler] Refusing to reply with incomplete answers: requestID=${requestID}, missingIndex=${missingIndex}, totalQuestions=${totalQuestions}`,
      );
      return;
    }

    this.questionManager.markSubmitted(requestID);

    try {
      await this.openCodeClient.question.reply({
        requestID,
        answers,
      });
    } catch (error) {
      this.questionManager.clearSubmitted(requestID);
      throw error;
    }

    this.logger.debug(
      `[QuestionCardHandler] Forwarded ${answers.length} answers for request ${requestID}`,
    );

    await this.updateQuestionCardToResolved();

    this.activeReceiveId = null;
    this.activeSourceMessageId = null;
  }

  private async updateQuestionCardToResolved(): Promise<void> {
    const activeMessageId = this.questionManager.getActiveMessageId();
    if (!activeMessageId || !this.renderer.updateCard) {
      return;
    }

    const currentIndex = this.questionManager.getCurrentIndex();
    const question = this.questionManager.getCurrentQuestion();
    const questionText = question?.question ?? "Question";
    const answerLabels =
      this.questionManager.getSelectedAnswerLabels(currentIndex);
    const customAnswer = this.questionManager.getCustomAnswer(currentIndex);
    const displayAnswers =
      answerLabels.length > 0
        ? answerLabels
        : customAnswer
          ? [customAnswer]
          : [];

    try {
      const resolvedCard = buildResolvedQuestionCard(
        questionText,
        displayAnswers,
      );
      await this.renderer.updateCard(activeMessageId, resolvedCard);
    } catch (error) {
      this.logger.warn(
        "[QuestionCardHandler] Failed to update question card to resolved state",
        error,
      );
    }
  }

  private syncInteractionState(question: Question): void {
    if (!this.interactionManager || !this.activeReceiveId) {
      return;
    }

    const expectedInput =
      question.options.length > 0 && question.custom
        ? "mixed"
        : question.options.length > 0
          ? "callback"
          : "text";

    this.interactionManager.transition(this.activeReceiveId, {
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
