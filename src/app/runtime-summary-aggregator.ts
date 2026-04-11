import type { Event } from "@opencode-ai/sdk/v2";
import type { FileHandler } from "../feishu/file-handler.js";
import type { FileStore } from "../feishu/file-store.js";
import type { PermissionCardHandler } from "../feishu/handlers/permission.js";
import type { QuestionCardHandler } from "../feishu/handlers/question.js";
import { QUESTION_GUIDED_REPLY_PREFIX } from "../feishu/handlers/question.js";
import type { StatusStore } from "../feishu/status-store.js";
import type { InteractionManager } from "../interaction/manager.js";
import type { PendingInteractionStore } from "../pending/store.js";
import type { PermissionManager } from "../permission/manager.js";
import type { QuestionManager } from "../question/manager.js";
import { SummaryAggregator } from "../summary/aggregator.js";
import type {
  SummaryCallbacks,
  SummaryPermissionEvent,
  SummaryQuestionEvent,
  SummaryToolEvent,
} from "../summary/types.js";
import type { Logger } from "../utils/logger.js";
import { logger as defaultLogger } from "../utils/logger.js";

export interface RuntimeSummaryAggregatorOptions {
  statusStore: StatusStore;
  questionManager: QuestionManager;
  permissionManager: PermissionManager;
  interactionManager: InteractionManager;
  pendingStore?: PendingInteractionStore;
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
  private readonly logger: Logger;

  constructor(private readonly options: RuntimeSummaryAggregatorOptions) {
    this.aggregator = new SummaryAggregator({
      scheduleAsync: (callback): void => callback(),
    });
    this.logger = options.logger ?? defaultLogger;
  }

  setCallbacks(callbacks: SummaryCallbacks): void {
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
        const turn = this.options.statusStore.get(sessionId);
        if (turn) {
          this.options.interactionManager.clear(
            turn.receiveId,
            "question_error",
          );
        }
      },
      onQuestionReplied: (sessionId, requestId) => {
        callbacks.onQuestionReplied?.(sessionId, requestId);
        this.handleQuestionReplied(sessionId, requestId);
      },
      onQuestionRejected: (sessionId, requestId) => {
        callbacks.onQuestionRejected?.(sessionId, requestId);
        this.handleQuestionRejected(sessionId, requestId);
      },
      onPermissionReplied: (sessionId, requestId) => {
        callbacks.onPermissionReplied?.(sessionId, requestId);
        this.handlePermissionReplied(sessionId, requestId);
      },
      onCleared: () => {
        callbacks.onCleared?.();
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

    const turn = this.options.statusStore.get(event.sessionId);
    if (!turn) {
      return;
    }

    this.options.pendingStore?.add(
      event.requestId,
      event.sessionId,
      turn.directory,
      turn.receiveId,
      "question",
    );

    const expectedInput =
      firstQuestion.options.length > 0 && firstQuestion.custom
        ? "mixed"
        : firstQuestion.options.length > 0
          ? "callback"
          : "text";

    this.options.interactionManager.start(turn.receiveId, {
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
    const turn = this.options.statusStore.get(event.sessionId);
    if (!turn) {
      return;
    }

    this.options.pendingStore?.add(
      event.request.id,
      event.sessionId,
      turn.directory,
      turn.receiveId,
      "permission",
    );

    this.options.interactionManager.start(turn.receiveId, {
      kind: "permission",
      expectedInput: "callback",
      allowedCommands: ["/help", "/status", "/abort"],
      metadata: {
        requestId: event.request.id,
        sessionId: event.sessionId,
      },
      expiresInMs: null,
    });

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

  private handleQuestionReplied(sessionId: string, requestId: string): void {
    this.logger.info(
      `[RuntimeSummaryAggregator] Question replied: session=${sessionId}, requestId=${requestId}`,
    );
    this.options.pendingStore?.remove(requestId);
    this.options.questionManager.clear();

    const turn = this.options.statusStore.get(sessionId);
    if (turn) {
      this.options.interactionManager.clear(turn.receiveId, "question_replied");
    }
  }

  private handleQuestionRejected(sessionId: string, requestId: string): void {
    this.logger.info(
      `[RuntimeSummaryAggregator] Question rejected: session=${sessionId}, requestId=${requestId}`,
    );
    this.options.pendingStore?.remove(requestId);
    this.options.questionManager.clear();

    const turn = this.options.statusStore.get(sessionId);
    if (turn) {
      this.options.interactionManager.clear(
        turn.receiveId,
        "question_rejected",
      );
    }
  }

  private handlePermissionReplied(sessionId: string, requestId: string): void {
    this.logger.info(
      `[RuntimeSummaryAggregator] Permission replied: session=${sessionId}, requestId=${requestId}`,
    );
    this.options.pendingStore?.remove(requestId);
    this.options.permissionManager.removeByRequestId(requestId);

    const turn = this.options.statusStore.get(sessionId);
    if (turn) {
      this.options.interactionManager.clear(
        turn.receiveId,
        "permission_replied",
      );
    }
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
