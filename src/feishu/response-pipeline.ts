import { randomUUID } from "node:crypto";
import type { Event } from "@opencode-ai/sdk/v2";
import { type AppConfig, getConfig, type ThrottleConfig } from "../config.js";
import {
  openCodeEventSubscriber,
  type SubscribeToEventsOptions,
} from "../opencode/events.js";
import { summaryAggregator as defaultSummaryAggregator } from "../summary/aggregator.js";
import type {
  SummaryCallbacks,
  SummarySessionDiffEvent,
  SummaryTokenEvent,
  SummaryToolEvent,
} from "../summary/types.js";
import { logger as defaultLogger, type Logger } from "../utils/logger.js";
import { buildStreamingStatusContent } from "./cards.js";
import type { ImageResolverLike } from "./image-resolver.js";
import { optimizeMarkdownStyle } from "./markdown-style.js";
import { splitReasoningText, stripReasoningTags } from "./reasoning-utils.js";
import type { FeishuRenderer } from "./renderer.js";
import {
  statusStore as defaultStatusStore,
  type ResponsePipelineTurnContext,
  type StatusStore,
  type StatusTurnState,
} from "./status-store.js";

interface ResponsePipelineRenderer {
  renderStatusCard: FeishuRenderer["renderStatusCard"];
  updateStatusCard: FeishuRenderer["updateStatusCard"];
  renderCompleteCard: FeishuRenderer["renderCompleteCard"];
  updateCompleteCard: FeishuRenderer["updateCompleteCard"];
  replyPost: FeishuRenderer["replyPost"];
  sendPost: FeishuRenderer["sendPost"];
}

interface ResponsePipelineSummaryAggregator {
  setCallbacks(callbacks: SummaryCallbacks): void;
  setSession(sessionId: string): void;
  processEvent(event: Event): void;
}

interface ResponsePipelineEventSubscriber {
  subscribeToEvents(
    directory: string,
    callback: (event: Event) => void,
    options?: SubscribeToEventsOptions,
  ): Promise<void>;
}

interface ResponsePipelineSettingsManager {
  setStatusMessageId(messageId: string): void;
  clearStatusMessageId(): void;
}

interface ResponsePipelineInteractionManager {
  clearBusy(): void;
}

export interface ResponsePipelineControllerOptions {
  eventSubscriber?: ResponsePipelineEventSubscriber;
  summaryAggregator?: ResponsePipelineSummaryAggregator;
  renderer: ResponsePipelineRenderer;
  imageResolver?: ImageResolverLike;
  settingsManager: ResponsePipelineSettingsManager;
  interactionManager: ResponsePipelineInteractionManager;
  statusStore?: StatusStore;
  config?: Pick<AppConfig, "throttle">;
  logger?: Logger;
  scheduleAsync?: (task: () => void) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ResponsePipelineControllerSnapshot {
  activeSessions: string[];
}

function getAssistantName(): string {
  return getConfig().assistantName;
}

const getActiveStatusCardTitle = () => `${getAssistantName()} is working`;
const ACTIVE_STATUS_CARD_TEMPLATE = "blue" as const;
const ACTIVE_STATUS_CARD_FALLBACK_TEXT = "Thinking…";
const FINAL_REPLY_FALLBACK_TEXT = "Done.";
const getFinalReplyTitle = () => `${getAssistantName()} reply`;
const getErrorReplyTitle = () => `${getAssistantName()} error`;
const STREAM_ENDED_MESSAGE = () =>
  `${getAssistantName()} stream ended before a final reply was delivered.`;
const RETRYABLE_UPDATE_KEYWORDS = [
  "rate limit",
  "too many requests",
  "retry later",
  "try again",
  "concurrent",
  "in flight",
  "updating",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash &= hash;
  }

  return hash.toString(36);
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function toPostParagraphs(text: string): string[][] {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [[ACTIVE_STATUS_CARD_FALLBACK_TEXT]];
  }

  return normalized.split("\n").map((line) => [line.length > 0 ? line : " "]);
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return Math.abs(millions) >= 100
      ? `${Math.round(millions)}m`
      : `${millions.toFixed(1)}m`;
  }

  if (abs >= 1_000) {
    const thousands = value / 1_000;
    return Math.abs(thousands) >= 100
      ? `${Math.round(thousands)}k`
      : `${thousands.toFixed(1)}k`;
  }

  return `${Math.round(value)}`;
}

function formatToolSummary(toolEvents: SummaryToolEvent[]): string | undefined {
  if (toolEvents.length === 0) {
    return undefined;
  }

  const lines = toolEvents
    .slice(-4)
    .map((toolEvent) => formatToolEventLine(toolEvent))
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return ["🔧 Progress", ...lines.map((line) => `- ${line}`)].join("\n");
}

function formatToolEventLine(toolEvent: SummaryToolEvent): string | undefined {
  const toolName = toolEvent.tool.trim();
  if (!toolName) {
    return undefined;
  }

  const title = toolEvent.title?.trim();
  const label = title && title.length > 0 ? title : toolName;
  const status = formatToolStatus(toolEvent.status);
  return `${getToolIcon(toolName)} ${label}${status ? ` · ${status}` : ""}`;
}

function formatToolStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "pending":
      return "in progress";
    case "completed":
      return "done";
    case "error":
    case "failed":
      return "failed";
    default:
      return status.trim().toLowerCase();
  }
}

function getToolIcon(tool: string): string {
  switch (tool.trim().toLowerCase()) {
    case "task":
    case "subtask":
      return "🤖";
    case "skill":
      return "🧠";
    case "bash":
      return "⚙️";
    case "read":
      return "📄";
    case "write":
      return "📝";
    case "edit":
    case "apply_patch":
      return "✏️";
    case "webfetch":
    case "websearch_web_search_exa":
      return "🌐";
    default:
      return "🔧";
  }
}

function buildFooterMetricsText(state: StatusTurnState): string | undefined {
  const elapsedMs = Math.max(0, Date.now() - state.turnStartTime);
  const parts: string[] = [`⏱️ ${formatElapsed(elapsedMs)}`];

  if (state.latestTokens) {
    parts.push(
      `↑ ${compactNumber(state.latestTokens.input)} ↓ ${compactNumber(state.latestTokens.output)}`,
    );

    if (state.latestTokens.reasoning > 0) {
      parts.push(`💭 ${compactNumber(state.latestTokens.reasoning)}`);
    }

    if (state.latestTokens.cacheRead > 0 || state.latestTokens.cacheWrite > 0) {
      parts.push(
        `cache ${compactNumber(state.latestTokens.cacheRead)}/${compactNumber(
          state.latestTokens.cacheWrite,
        )}`,
      );
    }
  }

  return parts.join(" · ");
}

function buildFinalReplyText(
  state: StatusTurnState,
  messageText: string,
): string {
  const normalizedText = normalizeText(messageText);
  const { reasoningText } = splitReasoningText(normalizedText);
  const finalReasoning =
    state.accumulatedReasoning?.trim() || reasoningText?.trim();
  const finalAnswer = getFinalAnswerContent(state, messageText);
  const toolSummary = formatToolSummary(state.toolEvents);
  const hasEnhancedSections = Boolean(
    finalReasoning || toolSummary || state.latestTokens,
  );

  if (!hasEnhancedSections) {
    return finalAnswer;
  }

  const sections: string[] = [];

  if (finalReasoning) {
    const reasoningElapsed = state.reasoningStartTime
      ? Math.max(0, Date.now() - state.reasoningStartTime)
      : undefined;
    const reasoningLabel = reasoningElapsed
      ? `💭 Reasoning (${formatElapsed(reasoningElapsed)})`
      : "💭 Reasoning";
    sections.push(`${reasoningLabel}\n${finalReasoning}`);
  }

  if (toolSummary) {
    sections.push(toolSummary);
  }

  sections.push(finalAnswer);

  const footer = buildFooterMetricsText(state);
  if (footer) {
    sections.push(footer);
  }

  return sections.join("\n\n");
}

function getFinalAnswerContent(
  state: StatusTurnState,
  messageText: string,
): string {
  const normalizedText = normalizeText(messageText);
  const { answerText } = splitReasoningText(normalizedText);
  const strippedAnswer = answerText ?? stripReasoningTags(normalizedText);
  const answerSource =
    strippedAnswer ||
    normalizedText ||
    state.lastPartialText ||
    FINAL_REPLY_FALLBACK_TEXT;
  return answerSource.trim() || FINAL_REPLY_FALLBACK_TEXT;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const directStatus = getNumber(error.status);
  if (directStatus !== undefined) {
    return directStatus;
  }

  const response = isRecord(error.response) ? error.response : undefined;
  return getNumber(response?.status);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (!isRecord(error)) {
    return "Unknown error";
  }

  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response.data : undefined;

  return (
    getString(responseData?.msg) ??
    getString(responseData?.message) ??
    getString(error.msg) ??
    getString(error.message) ??
    "Unknown error"
  );
}

export function isRetryableStatusCardUpdateError(error: unknown): boolean {
  const statusCode = getErrorStatusCode(error);
  if (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 423 ||
    statusCode === 425
  ) {
    return true;
  }

  if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true;
  }

  const normalizedMessage = getErrorMessage(error).toLowerCase();
  return RETRYABLE_UPDATE_KEYWORDS.some((keyword) =>
    normalizedMessage.includes(keyword),
  );
}

export class ResponsePipelineController {
  private readonly eventSubscriber: ResponsePipelineEventSubscriber;
  private readonly summaryAggregator: ResponsePipelineSummaryAggregator;
  private readonly renderer: ResponsePipelineRenderer;
  private readonly imageResolver?: ImageResolverLike;
  private readonly settingsManager: ResponsePipelineSettingsManager;
  private readonly interactionManager: ResponsePipelineInteractionManager;
  private readonly statusStore: StatusStore;
  private readonly throttleConfig: ThrottleConfig;
  private readonly logger: Logger;
  private readonly scheduleAsync: (task: () => void) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly sessionTasks = new Map<string, Promise<void>>();

  constructor(options: ResponsePipelineControllerOptions) {
    this.eventSubscriber = options.eventSubscriber ?? openCodeEventSubscriber;
    this.summaryAggregator =
      options.summaryAggregator ?? defaultSummaryAggregator;
    this.renderer = options.renderer;
    this.imageResolver = options.imageResolver;
    this.settingsManager = options.settingsManager;
    this.interactionManager = options.interactionManager;
    this.statusStore = options.statusStore ?? defaultStatusStore;
    this.throttleConfig = options.config?.throttle ?? getConfig().throttle;
    this.logger = options.logger ?? defaultLogger;
    this.scheduleAsync =
      options.scheduleAsync ?? ((task) => setImmediate(task));
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

    this.summaryAggregator.setCallbacks({
      onTypingStart: (sessionId) => {
        void this.enqueueSessionTask(sessionId, () =>
          this.handleTypingStart(sessionId),
        );
      },
      onTypingStop: () => undefined,
      onPartial: (sessionId, _messageId, messageText) => {
        this.handlePartial(sessionId, messageText);
      },
      onComplete: (sessionId, _messageId, messageText) => {
        void this.enqueueSessionTask(sessionId, () =>
          this.handleComplete(sessionId, messageText),
        );
      },
      onSessionIdle: (sessionId) => {
        void this.enqueueSessionTask(sessionId, () =>
          this.handleSessionIdle(sessionId),
        );
      },
      onTool: (toolEvent) => {
        this.handleTool(toolEvent);
      },
      onQuestion: () => undefined,
      onQuestionError: () => undefined,
      onPermission: () => undefined,
      onSessionDiff: (diffEvent) => {
        this.handleSessionDiff(diffEvent);
      },
      onTokenUpdate: (tokenEvent) => {
        this.handleTokenUpdate(tokenEvent);
      },
      onSessionRetry: () => undefined,
      onSessionCompacted: () => undefined,
      onSessionError: (sessionId, message) => {
        void this.enqueueSessionTask(sessionId, () =>
          this.handleSessionError(sessionId, message),
        );
      },
      onCleared: () => {
        this.handleAggregatorCleared();
      },
    });
  }

  getSnapshot(): ResponsePipelineControllerSnapshot {
    return {
      activeSessions: this.statusStore.getSessionIds(),
    };
  }

  startTurn(context: ResponsePipelineTurnContext): void {
    this.summaryAggregator.setSession(context.sessionId);

    const abortController = new AbortController();
    const state = this.statusStore.startTurn(context);
    state.subscriptionAbortController = abortController;

    this.scheduleAsync(() => {
      void this.runEventSubscription(context, abortController);
    });
  }

  handlePartial(sessionId: string, messageText: string): void {
    const normalizedText = normalizeText(messageText);
    if (!normalizedText) {
      return;
    }

    const state = this.statusStore.get(sessionId);
    if (!state || state.finalReplySent || state.pendingCompletion) {
      return;
    }

    const signature = hashString(normalizedText);
    if (state.lastPartialSignature === signature) {
      return;
    }

    const { reasoningText, answerText } = splitReasoningText(normalizedText);
    if (reasoningText && !state.accumulatedReasoning) {
      state.reasoningStartTime = Date.now();
    }
    if (reasoningText) {
      state.accumulatedReasoning = reasoningText;
    }

    const strippedText = answerText ?? stripReasoningTags(normalizedText);
    state.lastPartialText =
      reasoningText && !answerText ? undefined : strippedText || undefined;
    state.lastPartialSignature = signature;

    if (state.statusCardMessageId && !state.cardUpdatesBroken) {
      this.scheduleStatusCardUpdate(sessionId);
    }
  }

  handleTool(toolEvent: SummaryToolEvent): void {
    const state = this.statusStore.get(toolEvent.sessionId);
    if (!state) {
      return;
    }

    const existingIndex = state.toolEvents.findIndex(
      (existingEvent) => existingEvent.callId === toolEvent.callId,
    );
    if (existingIndex >= 0) {
      state.toolEvents.splice(existingIndex, 1, toolEvent);
    } else {
      state.toolEvents.push(toolEvent);
      if (state.toolEvents.length > 12) {
        state.toolEvents.splice(0, state.toolEvents.length - 12);
      }
    }

    if (
      state.statusCardMessageId &&
      !state.cardUpdatesBroken &&
      !state.finalReplySent &&
      !state.pendingCompletion
    ) {
      this.scheduleStatusCardUpdate(toolEvent.sessionId);
    }
  }

  handleSessionDiff(diffEvent: SummarySessionDiffEvent): void {
    const state = this.statusStore.get(diffEvent.sessionId);
    if (!state) {
      return;
    }

    state.diffs = [...diffEvent.diffs];
  }

  handleTokenUpdate(tokenEvent: SummaryTokenEvent): void {
    const state = this.statusStore.get(tokenEvent.sessionId);
    if (!state) {
      return;
    }

    state.latestTokens = tokenEvent.tokens;

    if (
      state.statusCardMessageId &&
      !state.cardUpdatesBroken &&
      !state.finalReplySent &&
      !state.pendingCompletion
    ) {
      this.scheduleStatusCardUpdate(tokenEvent.sessionId);
    }
  }

  handleImageResolved(): void {
    for (const sessionId of this.statusStore.getSessionIds()) {
      this.scheduleStatusCardUpdate(sessionId);
    }
  }

  handleAggregatorCleared(): void {
    const states = this.statusStore.clearAll();
    for (const state of states) {
      this.disposeTurnResources(state);
    }
  }

  async handleTypingStart(sessionId: string): Promise<void> {
    const state = this.statusStore.get(sessionId);
    if (!state || state.finalReplySent || state.cardUpdatesBroken) {
      return;
    }

    if (!state.turnStartTime) {
      state.turnStartTime = Date.now();
    }

    if (state.statusCardMessageId) {
      if (
        state.lastPartialSignature &&
        state.lastPartialSignature !== state.lastPatchedSignature
      ) {
        this.scheduleStatusCardUpdate(sessionId);
      }
      return;
    }

    const initialContent = this.getStatusCardContent(state);
    const initialSignature = hashString(initialContent);

    try {
      const messageId = await this.renderer.renderStatusCard(
        state.receiveId,
        getActiveStatusCardTitle(),
        initialContent,
        false,
        ACTIVE_STATUS_CARD_TEMPLATE,
      );

      const latestState = this.statusStore.get(sessionId);
      if (!latestState || latestState.finalReplySent) {
        return;
      }

      if (!messageId) {
        this.markCardUpdatesBroken(
          latestState,
          new Error("Status card create returned no message ID"),
        );
        return;
      }

      latestState.statusCardMessageId = messageId;
      latestState.lastPatchedText = initialContent;
      latestState.lastPatchedSignature = initialSignature;
      this.settingsManager.setStatusMessageId(messageId);

      if (
        latestState.lastPartialSignature &&
        latestState.lastPartialSignature !== latestState.lastPatchedSignature
      ) {
        this.scheduleStatusCardUpdate(sessionId);
      }
    } catch (error) {
      this.markCardUpdatesBroken(state, error);
    }
  }

  async handleComplete(sessionId: string, messageText: string): Promise<void> {
    const state = this.statusStore.get(sessionId);
    if (!state || state.finalReplySent) {
      return;
    }

    const normalizedText = normalizeText(messageText);
    const { reasoningText, answerText } = splitReasoningText(normalizedText);
    if (reasoningText && !state.accumulatedReasoning) {
      state.reasoningStartTime = Date.now();
    }
    if (reasoningText) {
      state.accumulatedReasoning = reasoningText;
    }

    const strippedText = answerText ?? stripReasoningTags(normalizedText);
    if (strippedText) {
      state.lastPartialText = strippedText;
      state.lastPartialSignature = hashString(normalizedText);
    }
    state.latestCompletedText = normalizedText;
  }

  async handleSessionIdle(sessionId: string): Promise<void> {
    const state = this.statusStore.get(sessionId);
    if (!state || state.finalReplySent) {
      return;
    }

    state.pendingCompletion = true;
    const completionText =
      state.latestCompletedText ?? state.lastPartialText ?? "";

    try {
      await this.flushPendingPartialUpdate(sessionId);
      await this.sendFinalReply(state, completionText, getFinalReplyTitle());
    } finally {
      this.finishTurn(sessionId);
    }
  }

  async handleSessionError(sessionId: string, message: string): Promise<void> {
    const state = this.statusStore.get(sessionId);
    if (!state || state.finalReplySent) {
      return;
    }

    state.pendingCompletion = true;
    state.cardUpdatesBroken = true;
    this.clearScheduledStatusUpdate(state);

    try {
      await this.sendFinalReply(state, message, getErrorReplyTitle());
    } finally {
      this.finishTurn(sessionId);
    }
  }

  private async runEventSubscription(
    context: ResponsePipelineTurnContext,
    abortController: AbortController,
  ): Promise<void> {
    try {
      await this.eventSubscriber.subscribeToEvents(
        context.directory,
        (event) => {
          this.summaryAggregator.processEvent(event);
        },
        { signal: abortController.signal },
      );
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.logger.error(
          `[ResponsePipeline] Event subscription failed for session=${context.sessionId}`,
          error,
        );
        await this.enqueueSessionTask(context.sessionId, () =>
          this.handleSessionError(context.sessionId, STREAM_ENDED_MESSAGE()),
        );
      }
      return;
    }

    if (!abortController.signal.aborted) {
      await this.enqueueSessionTask(context.sessionId, () =>
        this.handleSessionError(context.sessionId, STREAM_ENDED_MESSAGE()),
      );
    }
  }

  private scheduleStatusCardUpdate(sessionId: string): void {
    const state = this.statusStore.get(sessionId);
    if (
      !state ||
      state.statusUpdateTimer ||
      !state.statusCardMessageId ||
      state.cardUpdatesBroken ||
      state.finalReplySent
    ) {
      return;
    }

    state.statusUpdateTimer = this.setTimeoutFn(() => {
      const latestState = this.statusStore.get(sessionId);
      if (latestState) {
        latestState.statusUpdateTimer = undefined;
      }

      void this.enqueueSessionTask(sessionId, () =>
        this.flushStatusCardUpdate(sessionId),
      );
    }, this.throttleConfig.statusCardUpdateIntervalMs);
  }

  private clearScheduledStatusUpdate(state: StatusTurnState): void {
    if (!state.statusUpdateTimer) {
      return;
    }

    this.clearTimeoutFn(state.statusUpdateTimer);
    state.statusUpdateTimer = undefined;
  }

  private async flushPendingPartialUpdate(sessionId: string): Promise<void> {
    const state = this.statusStore.get(sessionId);
    if (!state) {
      return;
    }

    this.clearScheduledStatusUpdate(state);
    await this.flushStatusCardUpdate(sessionId);
  }

  private async flushStatusCardUpdate(sessionId: string): Promise<void> {
    const state = this.statusStore.get(sessionId);
    if (
      !state?.statusCardMessageId ||
      state.cardUpdatesBroken ||
      state.finalReplySent
    ) {
      return;
    }

    const statusCardMessageId = state.statusCardMessageId;

    const content = this.getStatusCardContent(state);
    const signature = hashString(content);
    if (signature === state.lastPatchedSignature) {
      return;
    }

    const maxAttempts = Math.max(
      1,
      this.throttleConfig.statusCardPatchMaxAttempts,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.renderer.updateStatusCard(
          statusCardMessageId,
          getActiveStatusCardTitle(),
          content,
          false,
          ACTIVE_STATUS_CARD_TEMPLATE,
        );
        state.lastPatchedText = content;
        state.lastPatchedSignature = signature;
        return;
      } catch (error) {
        if (attempt < maxAttempts && isRetryableStatusCardUpdateError(error)) {
          await this.waitFor(
            this.throttleConfig.statusCardPatchRetryDelayMs * attempt,
          );
          continue;
        }

        this.markCardUpdatesBroken(state, error);
        return;
      }
    }
  }

  private async sendFinalReply(
    state: StatusTurnState,
    messageText: string,
    title: string,
  ): Promise<void> {
    if (state.finalReplySent) {
      return;
    }

    const uuid = state.finalReplyUuid ?? randomUUID();
    state.finalReplyUuid = uuid;
    const answerContent = getFinalAnswerContent(state, messageText);
    const resolvedAnswer = this.imageResolver
      ? await this.imageResolver.resolveImagesAwait(answerContent, 15_000)
      : answerContent;
    const completeTemplate = title === getErrorReplyTitle() ? "red" : "green";
    const reasoningDurationMs = state.reasoningStartTime
      ? Math.max(0, Date.now() - state.reasoningStartTime)
      : undefined;
    const elapsedMs = Math.max(0, Date.now() - state.turnStartTime);

    try {
      if (state.statusCardMessageId && !state.cardUpdatesBroken) {
        await this.renderer.updateCompleteCard(
          state.statusCardMessageId,
          title,
          resolvedAnswer,
          {
            reasoningText: state.accumulatedReasoning,
            reasoningDurationMs,
            elapsedMs,
            tokens: state.latestTokens,
            toolEvents: state.toolEvents,
            template: completeTemplate,
          },
        );
      } else {
        const messageId = await this.renderer.renderCompleteCard(
          state.receiveId,
          title,
          resolvedAnswer,
          {
            reasoningText: state.accumulatedReasoning,
            reasoningDurationMs,
            elapsedMs,
            tokens: state.latestTokens,
            toolEvents: state.toolEvents,
            template: completeTemplate,
          },
        );
        if (messageId) {
          state.statusCardMessageId = messageId;
          this.settingsManager.setStatusMessageId(messageId);
        }
      }
      state.finalReplySent = true;
      return;
    } catch (error) {
      this.logger.warn(
        `[ResponsePipeline] Complete card delivery failed, falling back to post reply for session=${state.sessionId}`,
        error,
      );
    }

    const replyText = optimizeMarkdownStyle(
      buildFinalReplyText(state, messageText),
    );
    const resolvedText = this.imageResolver
      ? await this.imageResolver.resolveImagesAwait(replyText, 15_000)
      : replyText;
    const paragraphs = toPostParagraphs(resolvedText);

    try {
      await this.renderer.replyPost(state.sourceMessageId, title, paragraphs, {
        uuid,
      });
      state.finalReplySent = true;
      return;
    } catch (error) {
      this.logger.warn(
        `[ResponsePipeline] Reply send failed, falling back to non-threaded post for session=${state.sessionId}`,
        error,
      );
    }

    await this.renderer.sendPost(state.receiveId, title, paragraphs);
    state.finalReplySent = true;
  }

  private finishTurn(sessionId: string): void {
    const state = this.statusStore.clear(sessionId);
    if (!state) {
      return;
    }

    this.disposeTurnResources(state);
    this.settingsManager.clearStatusMessageId();
    this.interactionManager.clearBusy();
  }

  private disposeTurnResources(state: StatusTurnState): void {
    this.clearScheduledStatusUpdate(state);
    state.subscriptionAbortController?.abort();
  }

  private getStatusCardContent(state: StatusTurnState): string {
    const resolveImagesFn = this.imageResolver
      ? (text: string) => this.imageResolver!.resolveImages(text)
      : undefined;
    return (
      buildStreamingStatusContent(state, resolveImagesFn) ||
      ACTIVE_STATUS_CARD_FALLBACK_TEXT
    );
  }

  private markCardUpdatesBroken(state: StatusTurnState, error: unknown): void {
    state.cardUpdatesBroken = true;
    this.clearScheduledStatusUpdate(state);
    this.logger.warn(
      `[ResponsePipeline] Status card updates disabled for session=${state.sessionId}: ${getErrorMessage(error)}`,
      error,
    );
  }

  private waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeoutFn(() => resolve(), ms);
    });
  }

  async enqueueSessionTask(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previousTask = this.sessionTasks.get(sessionId) ?? Promise.resolve();
    const nextTask = previousTask
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.error(
          `[ResponsePipeline] Session task failed: session=${sessionId}`,
          error,
        );
      })
      .finally(() => {
        if (this.sessionTasks.get(sessionId) === nextTask) {
          this.sessionTasks.delete(sessionId);
        }
      });

    this.sessionTasks.set(sessionId, nextTask);
    await nextTask;
  }
}
