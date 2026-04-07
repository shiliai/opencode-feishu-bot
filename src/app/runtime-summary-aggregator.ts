import type { Event } from "@opencode-ai/sdk/v2";
import { SummaryAggregator } from "../summary/aggregator.js";
import type {
  SummaryCallbacks,
  SummaryPermissionEvent,
  SummaryQuestionEvent,
  SummaryToolEvent,
} from "../summary/types.js";
import type { StatusStore } from "../feishu/status-store.js";
import type { QuestionManager } from "../question/manager.js";
import type { PermissionManager } from "../permission/manager.js";
import type { InteractionManager } from "../interaction/manager.js";
import type { QuestionCardHandler } from "../feishu/handlers/question.js";
import { QUESTION_GUIDED_REPLY_PREFIX } from "../feishu/handlers/question.js";
import type { PermissionCardHandler } from "../feishu/handlers/permission.js";
import type { FileHandler } from "../feishu/file-handler.js";
import type { FileStore } from "../feishu/file-store.js";
import type { Logger } from "../utils/logger.js";
import { logger as defaultLogger } from "../utils/logger.js";

export interface RuntimeSummaryAggregatorOptions {
  statusStore: StatusStore;
  questionManager: QuestionManager;
  permissionManager: PermissionManager;
  interactionManager: InteractionManager;
  questionCardHandler: Pick<QuestionCardHandler, "handleQuestionEvent">;
  permissionCardHandler: Pick<PermissionCardHandler, "handlePermissionEvent">;
  fileHandler: Pick<FileHandler, "egressFile">;
  fileStore: FileStore;
  logger?: Logger;
  onSessionSettled?: (sessionId: string) => Promise<void> | void;
  trackTask?: (task: Promise<unknown>) => void;
}

function runAsync(
  task: Promise<unknown>,
  logger: Logger,
  context: string,
  trackTask?: (task: Promise<unknown>) => void,
): void {
  trackTask?.(task);
  void task.catch((error) => {
    logger.error(`[RuntimeSummaryAggregator] ${context}`, error);
  });
}

export class RuntimeSummaryAggregator {
  private readonly aggregator: SummaryAggregator;
  private callbacks: SummaryCallbacks = {};
  private readonly logger: Logger;

  constructor(private readonly options: RuntimeSummaryAggregatorOptions) {
    this.aggregator = new SummaryAggregator({
      scheduleAsync: (callback): void => callback(),
    });
    this.logger = options.logger ?? defaultLogger;
  }

  setCallbacks(callbacks: SummaryCallbacks): void {
    this.callbacks = callbacks;
    this.aggregator.setCallbacks({
      ...callbacks,
      onQuestion: (event) => {
        callbacks.onQuestion?.(event);
        this.handleQuestion(event);
      },
      onPermission: (event) => {
        callbacks.onPermission?.(event);
        this.handlePermission(event);
      },
      onTool: (event) => {
        callbacks.onTool?.(event);
        this.handleTool(event);
      },
      onComplete: (sessionId, messageId, messageText) => {
        callbacks.onComplete?.(sessionId, messageId, messageText);
      },
      onSessionIdle: (sessionId) => {
        callbacks.onSessionIdle?.(sessionId);
        this.handleSessionSettled(sessionId);
      },
      onSessionError: (sessionId, message) => {
        callbacks.onSessionError?.(sessionId, message);
        this.handleSessionSettled(sessionId);
      },
      onQuestionError: (sessionId) => {
        callbacks.onQuestionError?.(sessionId);
        this.options.interactionManager.clear("question_error");
      },
      onCleared: () => {
        callbacks.onCleared?.();
        this.options.interactionManager.clear("aggregator_cleared");
      },
    });
  }

  setSession(sessionId: string): void {
    this.aggregator.setSession(sessionId);
  }

  processEvent(event: Event): void {
    this.aggregator.processEvent(event);
  }

  private handleQuestion(event: SummaryQuestionEvent): void {
    this.options.questionManager.startQuestions(
      event.questions,
      event.requestId,
    );

    const firstQuestion = event.questions[0];
    if (!firstQuestion) {
      return;
    }

    const expectedInput =
      firstQuestion.options.length > 0 && firstQuestion.custom
        ? "mixed"
        : firstQuestion.options.length > 0
          ? "callback"
          : "text";

    this.options.interactionManager.start({
      kind: "question",
      expectedInput,
      allowedCommands: ["/help", "/status", "/abort"],
      metadata: {
        requestId: event.requestId,
        sessionId: event.sessionId,
        answerPrefix: QUESTION_GUIDED_REPLY_PREFIX,
      },
      expiresInMs: null,
    });

    const turn = this.options.statusStore.get(event.sessionId);
    if (!turn) {
      return;
    }

    runAsync(
      this.options.questionCardHandler.handleQuestionEvent(
        turn.receiveId,
        turn.sourceMessageId,
      ),
      this.logger,
      "Failed to render question interaction",
      this.options.trackTask,
    );
  }

  private handlePermission(event: SummaryPermissionEvent): void {
    this.options.interactionManager.start({
      kind: "permission",
      expectedInput: "callback",
      allowedCommands: ["/help", "/status", "/abort"],
      metadata: {
        requestId: event.request.id,
        sessionId: event.sessionId,
      },
      expiresInMs: null,
    });

    const turn = this.options.statusStore.get(event.sessionId);
    if (!turn) {
      return;
    }

    runAsync(
      this.options.permissionCardHandler.handlePermissionEvent(
        turn.receiveId,
        event.request,
        turn.sourceMessageId,
      ),
      this.logger,
      "Failed to render permission interaction",
      this.options.trackTask,
    );
  }

  private handleTool(event: SummaryToolEvent): void {
    const attachment = event.attachment;
    if (!attachment) {
      return;
    }

    const turn = this.options.statusStore.get(event.sessionId);
    if (!turn) {
      return;
    }

    runAsync(
      (async () => {
        const tempDir = await this.options.fileStore.createTempDir();
        const storedFile = await this.options.fileStore.storeFile(
          tempDir,
          attachment.filename,
          attachment.buffer,
        );
        await this.options.fileHandler.egressFile(storedFile, turn.receiveId);
      })(),
      this.logger,
      "Failed to deliver tool attachment",
      this.options.trackTask,
    );
  }

  private handleSessionSettled(sessionId: string): void {
    if (!this.options.onSessionSettled) {
      return;
    }

    runAsync(
      Promise.resolve(this.options.onSessionSettled(sessionId)),
      this.logger,
      `Failed to settle session ${sessionId}`,
      this.options.trackTask,
    );
  }
}
