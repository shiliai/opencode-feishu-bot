import { randomUUID } from "node:crypto";
import type { Event } from "@opencode-ai/sdk/v2";
import {
  type AppConfig,
  DEFAULT_STATUS_CARD_RECREATE_INTERVAL,
  DEFAULT_STATUS_CARD_RECENT_UPDATES_COUNT,
  getConfig,
  type StatusCardConfig,
  type ThrottleConfig,
} from "../config.js";
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
  type StatusCardRecentUpdate,
  type StatusCardTodoItem,
  type ResponsePipelineTurnContext,
  type StatusStore,
  type StatusTurnState,
} from "./status-store.js";

interface ResponsePipelineRenderer {
  renderStatusCard: FeishuRenderer["renderStatusCard"];
  updateStatusCard: FeishuRenderer["updateStatusCard"];
  deleteMessage: FeishuRenderer["deleteMessage"];
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
  setChatStatusMessageId(chatId: string, messageId: string): void;
  clearChatStatusMessageId(chatId: string): void;
}

interface ResponsePipelineInteractionManager {
  clearBusy(chatId: string): void;
}

export interface SessionMessageEntry {
  info: {
    id: string;
    sessionID: string;
    role: string;
  };
  parts: Array<{
    type: string;
    text?: string;
  }>;
}

export interface SessionMessageFetcher {
  fetchLastAssistantMessage(
    sessionId: string,
    directory: string,
  ): Promise<SessionMessageEntry | undefined>;
}

export interface ResponsePipelineControllerOptions {
  eventSubscriber?: ResponsePipelineEventSubscriber;
  summaryAggregator?: ResponsePipelineSummaryAggregator;
  sessionMessageFetcher?: SessionMessageFetcher;
  renderer: ResponsePipelineRenderer;
  imageResolver?: ImageResolverLike;
  settingsManager: ResponsePipelineSettingsManager;
  interactionManager: ResponsePipelineInteractionManager;
  statusStore?: StatusStore;
  config?: {
    throttle?: AppConfig["throttle"];
    statusCard?: AppConfig["statusCard"];
  };
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
const MAX_RECENT_UPDATE_SUMMARY_CHARS = 160;
const getFinalReplyTitle = () => `${getAssistantName()} reply`;
const getAbortedReplyTitle = () => `${getAssistantName()} aborted`;
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

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateInlineText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function summarizeRecentText(prefix: string, text: string): string | undefined {
  const normalized = normalizeInlineText(stripReasoningTags(text));
  if (!normalized) {
    return undefined;
  }

  return `${prefix} ${truncateInlineText(normalized, MAX_RECENT_UPDATE_SUMMARY_CHARS)}`;
}

function isStatusCardTodoItem(value: unknown): value is StatusCardTodoItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    typeof value.status === "string" &&
    (value.priority === undefined || typeof value.priority === "string")
  );
}

function extractTodosFromMetadata(
  metadata: Record<string, unknown> | undefined,
): StatusCardTodoItem[] | undefined {
  const rawTodos = metadata?.todos;
  if (!Array.isArray(rawTodos)) {
    return undefined;
  }

  const todos = rawTodos.filter(isStatusCardTodoItem).map((todo) => ({
    id: todo.id,
    content: todo.content,
    status: todo.status,
    priority: todo.priority,
  }));

  return todos.length > 0 ? todos : [];
}

function buildTodoUpdateSummary(
  todos: StatusCardTodoItem[],
): string | undefined {
  if (todos.length === 0) {
    return undefined;
  }

  const counts = {
    completed: 0,
    inProgress: 0,
    pending: 0,
    cancelled: 0,
  };

  for (const todo of todos) {
    switch (todo.status.trim().toLowerCase()) {
      case "completed":
        counts.completed += 1;
        break;
      case "in_progress":
      case "running":
        counts.inProgress += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      case "pending":
      default:
        counts.pending += 1;
        break;
    }
  }

  const parts = [
    counts.inProgress > 0 ? `${counts.inProgress} active` : undefined,
    counts.pending > 0 ? `${counts.pending} pending` : undefined,
    counts.completed > 0 ? `${counts.completed} done` : undefined,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : undefined,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) {
    return `📝 Todo list · ${todos.length} items`;
  }

  return `📝 Todo list · ${parts.join(" · ")}`;
}

function extractTextFromMessageEntry(entry: SessionMessageEntry): string {
  return entry.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
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
  private readonly sessionMessageFetcher?: SessionMessageFetcher;
  private readonly renderer: ResponsePipelineRenderer;
  private readonly imageResolver?: ImageResolverLike;
  private readonly settingsManager: ResponsePipelineSettingsManager;
  private readonly interactionManager: ResponsePipelineInteractionManager;
  private readonly statusStore: StatusStore;
  private readonly throttleConfig: ThrottleConfig;
  private readonly statusCardConfig: StatusCardConfig;
  private readonly logger: Logger;
  private readonly scheduleAsync: (task: () => void) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly sessionTasks = new Map<string, Promise<void>>();

  constructor(options: ResponsePipelineControllerOptions) {
    const appConfig = options.config ? undefined : getConfig();

    this.eventSubscriber = options.eventSubscriber ?? openCodeEventSubscriber;
    this.summaryAggregator =
      options.summaryAggregator ?? defaultSummaryAggregator;
    this.sessionMessageFetcher = options.sessionMessageFetcher;
    this.renderer = options.renderer;
    this.imageResolver = options.imageResolver;
    this.settingsManager = options.settingsManager;
    this.interactionManager = options.interactionManager;
    this.statusStore = options.statusStore ?? defaultStatusStore;
    this.throttleConfig =
      options.config?.throttle ?? appConfig?.throttle ?? getConfig().throttle;
    this.statusCardConfig = options.config?.statusCard ?? {
      recentUpdatesCount:
        appConfig?.statusCard.recentUpdatesCount ??
        DEFAULT_STATUS_CARD_RECENT_UPDATES_COUNT,
      recreateInterval:
        appConfig?.statusCard.recreateInterval ??
        DEFAULT_STATUS_CARD_RECREATE_INTERVAL,
    };
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

    this.logger.info(
      `[ResponsePipeline] Starting turn: session=${context.sessionId}, directory=${context.directory}, receiveId=${context.receiveId}, sourceMessageId=${context.sourceMessageId}`,
    );

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

    const recentSummary = strippedText
      ? summarizeRecentText("💬", strippedText)
      : reasoningText
        ? summarizeRecentText("💭", reasoningText)
        : undefined;
    if (recentSummary) {
      this.recordRecentUpdate(state, {
        kind: "partial",
        summary: recentSummary,
        key: `partial:${signature}`,
      });
    }

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

    const toolSummary = formatToolEventLine(toolEvent);
    if (toolSummary) {
      this.recordRecentUpdate(state, {
        kind: "tool",
        summary: toolSummary,
        key: `tool:${toolEvent.callId}:${toolEvent.status}:${toolEvent.title ?? ""}`,
      });
    }

    this.syncTodoStateFromToolEvent(state, toolEvent);

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
      this.settingsManager.setChatStatusMessageId(
        latestState.receiveId,
        messageId,
      );

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

    if (state.abortRequested) {
      this.logger.info(
        `[ResponsePipeline] Ignoring session idle finalization because abort is in progress: session=${sessionId}`,
      );
      return;
    }

    state.pendingCompletion = true;
    const eventBasedText =
      state.latestCompletedText ?? state.lastPartialText ?? "";

    let completionText = eventBasedText;

    if (this.sessionMessageFetcher) {
      try {
        const lastMessage =
          await this.sessionMessageFetcher.fetchLastAssistantMessage(
            sessionId,
            state.directory,
          );
        if (lastMessage) {
          const apiText = extractTextFromMessageEntry(lastMessage);
          if (apiText.trim()) {
            completionText = apiText;
            this.logger.info(
              `[ResponsePipeline] Session idle: using API-fetched message text (${apiText.length} chars) over event-based text (${eventBasedText.length} chars): session=${sessionId}`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `[ResponsePipeline] Failed to fetch last assistant message from API, falling back to event-based text: session=${sessionId}`,
          error,
        );
      }
    }

    this.logger.info(
      `[ResponsePipeline] Session idle reached finalization: session=${sessionId}, completionChars=${completionText.length}, hasStatusCard=${Boolean(state.statusCardMessageId)}, cardUpdatesBroken=${state.cardUpdatesBroken}`,
    );

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

    if (state.abortRequested) {
      this.logger.info(
        `[ResponsePipeline] Ignoring session error finalization because abort is in progress: session=${sessionId}, message=${message}`,
      );
      return;
    }

    state.pendingCompletion = true;
    state.cardUpdatesBroken = true;
    this.clearScheduledStatusUpdate(state);

    this.logger.info(
      `[ResponsePipeline] Handling session error: session=${sessionId}, message=${message}`,
    );

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

    if (this.shouldRecreateStatusCard(state)) {
      const recreated = await this.recreateStatusCard(
        state,
        content,
        signature,
      );
      if (recreated) {
        return;
      }
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
        state.statusCardUpdateCount += 1;
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

  private recordRecentUpdate(
    state: StatusTurnState,
    update: StatusCardRecentUpdate,
  ): void {
    if (this.statusCardConfig.recentUpdatesCount <= 0) {
      return;
    }

    const normalizedSummary = normalizeInlineText(update.summary);
    if (!normalizedSummary) {
      return;
    }

    const nextUpdate: StatusCardRecentUpdate = {
      ...update,
      summary: normalizedSummary,
    };
    const lastUpdate = state.recentUpdates.at(-1);
    if (
      lastUpdate?.key === nextUpdate.key ||
      lastUpdate?.summary === nextUpdate.summary
    ) {
      return;
    }

    state.recentUpdates = [...state.recentUpdates, nextUpdate].slice(
      -this.statusCardConfig.recentUpdatesCount,
    );
  }

  private syncTodoStateFromToolEvent(
    state: StatusTurnState,
    toolEvent: SummaryToolEvent,
  ): void {
    const todos = extractTodosFromMetadata(toolEvent.metadata);
    if (!todos) {
      return;
    }

    state.todos = todos;
    const todoSummary = buildTodoUpdateSummary(todos);
    if (!todoSummary) {
      return;
    }

    this.recordRecentUpdate(state, {
      kind: "todo",
      summary: todoSummary,
      key: `todo:${hashString(JSON.stringify(todos))}`,
    });
  }

  private shouldRecreateStatusCard(state: StatusTurnState): boolean {
    return (
      !state.pendingCompletion &&
      this.statusCardConfig.recreateInterval > 0 &&
      state.statusCardUpdateCount + 1 >= this.statusCardConfig.recreateInterval
    );
  }

  private async recreateStatusCard(
    state: StatusTurnState,
    content: string,
    signature: string,
  ): Promise<boolean> {
    const previousMessageId = state.statusCardMessageId;
    if (!previousMessageId) {
      return false;
    }

    try {
      const nextMessageId = await this.renderer.renderStatusCard(
        state.receiveId,
        getActiveStatusCardTitle(),
        content,
        false,
        ACTIVE_STATUS_CARD_TEMPLATE,
      );

      if (!nextMessageId) {
        return false;
      }

      state.statusCardMessageId = nextMessageId;
      state.lastPatchedText = content;
      state.lastPatchedSignature = signature;
      state.statusCardUpdateCount = 0;
      this.settingsManager.setChatStatusMessageId(
        state.receiveId,
        nextMessageId,
      );

      if (nextMessageId !== previousMessageId) {
        try {
          await this.renderer.deleteMessage(previousMessageId);
        } catch (error) {
          this.logger.warn(
            `[ResponsePipeline] Failed to delete stale status card after recreate: session=${state.sessionId}, messageId=${previousMessageId}`,
            error,
          );
        }
      }

      return true;
    } catch (error) {
      this.logger.warn(
        `[ResponsePipeline] Status card recreate failed, falling back to patch: session=${state.sessionId}`,
        error,
      );
      return false;
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
    const completeTemplate =
      title === getErrorReplyTitle()
        ? "red"
        : title === getAbortedReplyTitle()
          ? "orange"
          : "green";
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
        this.logger.info(
          `[ResponsePipeline] Final reply delivered via complete-card update: session=${state.sessionId}, statusCardMessageId=${state.statusCardMessageId}`,
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
          this.settingsManager.setChatStatusMessageId(
            state.receiveId,
            messageId,
          );
        }
        this.logger.info(
          `[ResponsePipeline] Final reply delivered via complete-card render: session=${state.sessionId}, statusCardMessageId=${messageId ?? "unknown"}`,
        );
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
      this.logger.info(
        `[ResponsePipeline] Final reply delivered via threaded post reply: session=${state.sessionId}, sourceMessageId=${state.sourceMessageId}`,
      );
      state.finalReplySent = true;
      return;
    } catch (error) {
      this.logger.warn(
        `[ResponsePipeline] Reply send failed, falling back to non-threaded post for session=${state.sessionId}`,
        error,
      );
    }

    await this.renderer.sendPost(state.receiveId, title, paragraphs);
    this.logger.info(
      `[ResponsePipeline] Final reply delivered via non-threaded post: session=${state.sessionId}, receiveId=${state.receiveId}`,
    );
    state.finalReplySent = true;
  }

  private finishTurn(sessionId: string): void {
    const state = this.statusStore.clear(sessionId);
    if (!state) {
      return;
    }

    this.logger.info(
      `[ResponsePipeline] Finishing turn: session=${sessionId}, finalReplySent=${state.finalReplySent}, cardUpdatesBroken=${state.cardUpdatesBroken}, elapsedMs=${Math.max(0, Date.now() - state.turnStartTime)}`,
    );

    this.disposeTurnResources(state);
    this.settingsManager.clearChatStatusMessageId(state.receiveId);
    this.interactionManager.clearBusy(state.receiveId);
  }

  private disposeTurnResources(state: StatusTurnState): void {
    this.clearScheduledStatusUpdate(state);
    state.subscriptionAbortController?.abort();
  }

  private getStatusCardContent(state: StatusTurnState): string {
    const imageResolver = this.imageResolver;
    const resolveImagesFn = imageResolver
      ? (text: string) => imageResolver.resolveImages(text)
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
