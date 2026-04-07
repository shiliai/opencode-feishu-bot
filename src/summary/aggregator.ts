import type { Event } from "@opencode-ai/sdk/v2";
import type { PermissionRequest } from "../permission/types.js";
import type { Question } from "../question/types.js";
import { getCurrentProject, type ProjectInfo } from "../settings/manager.js";
import { logger } from "../utils/logger.js";
import type {
  SummaryCallbacks,
  SummaryFileChange,
  SummaryPermissionEvent,
  SummaryQuestionEvent,
  SummarySessionDiffEvent,
  SummarySessionRetryInfo,
  SummaryTokenEvent,
  SummaryTokensInfo,
  SummaryToolAttachment,
  SummaryToolEvent,
} from "./types.js";

interface SummaryAggregatorOptions {
  getCurrentProject?: () => ProjectInfo | undefined;
  scheduleAsync?: (callback: () => void) => void;
}

interface TextMessageState {
  orderedPartIds: string[];
  partTexts: Map<string, string>;
  optimisticUpdateCount: number;
}

interface PreparedToolContext {
  attachment?: SummaryToolAttachment;
  fileChange?: SummaryFileChange;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getEventProperties(event: Event): Record<string, unknown> | undefined {
  const rawEvent = event as { properties?: unknown };
  return isRecord(rawEvent.properties) ? rawEvent.properties : undefined;
}

function isQuestionOption(
  value: unknown,
): value is Question["options"][number] {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.description === "string"
  );
}

function isQuestion(value: unknown): value is Question {
  return (
    isRecord(value) &&
    typeof value.question === "string" &&
    typeof value.header === "string" &&
    Array.isArray(value.options) &&
    value.options.every(isQuestionOption) &&
    (value.multiple === undefined || typeof value.multiple === "boolean") &&
    (value.custom === undefined || typeof value.custom === "boolean")
  );
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sessionID === "string" &&
    typeof value.permission === "string" &&
    Array.isArray(value.patterns) &&
    value.patterns.every((pattern) => typeof pattern === "string") &&
    Array.isArray(value.always) &&
    value.always.every((entry) => typeof entry === "string") &&
    isRecord(value.metadata) &&
    (!("tool" in value) ||
      value.tool === undefined ||
      (isRecord(value.tool) &&
        typeof value.tool.messageID === "string" &&
        typeof value.tool.callID === "string"))
  );
}

function extractFirstUpdatedFileFromTitle(title: string): string {
  for (const rawLine of title.split("\n")) {
    const line = rawLine.trim();
    if (line.length >= 3 && line[1] === " " && /[AMDURC]/.test(line[0])) {
      return line.slice(2).trim();
    }
  }

  return "";
}

export function countDiffChangesFromText(text: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function formatDiffForAttachment(diff: string): string {
  const lines = diff.split("\n");
  const formattedLines: string[] = [];

  for (const line of lines) {
    if (
      line.startsWith("@@") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("Index:")
    ) {
      continue;
    }

    if (line.startsWith("===") || line.startsWith("\\ No newline")) {
      continue;
    }

    if (line.startsWith(" ")) {
      formattedLines.push(` ${line.slice(1)}`);
      continue;
    }

    if (line.startsWith("+")) {
      formattedLines.push(`+ ${line.slice(1)}`);
      continue;
    }

    if (line.startsWith("-")) {
      formattedLines.push(`- ${line.slice(1)}`);
      continue;
    }

    formattedLines.push(line);
  }

  return formattedLines.join("\n");
}

function countLines(text: string): number {
  return text.split("\n").length;
}

export class SummaryAggregator {
  private readonly getCurrentProjectFn: () => ProjectInfo | undefined;
  private readonly scheduleAsync: (callback: () => void) => void;
  private currentSessionId: string | null = null;
  private readonly textMessageStates = new Map<string, TextMessageState>();
  private readonly messages = new Map<string, { role: string }>();
  private readonly processedToolStates = new Set<string>();
  private readonly knownTextPartIds = new Map<string, Set<string>>();
  private readonly partHashes = new Map<string, Set<string>>();
  private readonly reasoningMessages = new Set<string>();
  private callbacks: SummaryCallbacks = {};
  private typingActive = false;

  constructor(options: SummaryAggregatorOptions = {}) {
    this.getCurrentProjectFn = options.getCurrentProject ?? getCurrentProject;
    this.scheduleAsync =
      options.scheduleAsync ?? ((callback) => setImmediate(callback));
  }

  setCallbacks(callbacks: SummaryCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  setOnTypingStart(
    callback: NonNullable<SummaryCallbacks["onTypingStart"]>,
  ): void {
    this.callbacks.onTypingStart = callback;
  }

  setOnTypingStop(
    callback: NonNullable<SummaryCallbacks["onTypingStop"]>,
  ): void {
    this.callbacks.onTypingStop = callback;
  }

  setOnPartial(callback: NonNullable<SummaryCallbacks["onPartial"]>): void {
    this.callbacks.onPartial = callback;
  }

  setOnComplete(callback: NonNullable<SummaryCallbacks["onComplete"]>): void {
    this.callbacks.onComplete = callback;
  }

  setOnSessionIdle(
    callback: NonNullable<SummaryCallbacks["onSessionIdle"]>,
  ): void {
    this.callbacks.onSessionIdle = callback;
  }

  setOnTool(callback: NonNullable<SummaryCallbacks["onTool"]>): void {
    this.callbacks.onTool = callback;
  }

  setOnQuestion(callback: NonNullable<SummaryCallbacks["onQuestion"]>): void {
    this.callbacks.onQuestion = callback;
  }

  setOnQuestionError(
    callback: NonNullable<SummaryCallbacks["onQuestionError"]>,
  ): void {
    this.callbacks.onQuestionError = callback;
  }

  setOnPermission(
    callback: NonNullable<SummaryCallbacks["onPermission"]>,
  ): void {
    this.callbacks.onPermission = callback;
  }

  setOnSessionDiff(
    callback: NonNullable<SummaryCallbacks["onSessionDiff"]>,
  ): void {
    this.callbacks.onSessionDiff = callback;
  }

  setOnTokenUpdate(
    callback: NonNullable<SummaryCallbacks["onTokenUpdate"]>,
  ): void {
    this.callbacks.onTokenUpdate = callback;
  }

  setOnSessionRetry(
    callback: NonNullable<SummaryCallbacks["onSessionRetry"]>,
  ): void {
    this.callbacks.onSessionRetry = callback;
  }

  setOnSessionCompacted(
    callback: NonNullable<SummaryCallbacks["onSessionCompacted"]>,
  ): void {
    this.callbacks.onSessionCompacted = callback;
  }

  setOnSessionError(
    callback: NonNullable<SummaryCallbacks["onSessionError"]>,
  ): void {
    this.callbacks.onSessionError = callback;
  }

  setOnCleared(callback: NonNullable<SummaryCallbacks["onCleared"]>): void {
    this.callbacks.onCleared = callback;
  }

  setSession(sessionId: string): void {
    if (this.currentSessionId === sessionId) {
      return;
    }

    this.clear();
    this.currentSessionId = sessionId;
  }

  clear(): void {
    const previousSessionId = this.currentSessionId;
    this.stopTyping("clear", previousSessionId);
    this.currentSessionId = null;
    this.textMessageStates.clear();
    this.messages.clear();
    this.processedToolStates.clear();
    this.knownTextPartIds.clear();
    this.partHashes.clear();
    this.reasoningMessages.clear();
    this.callbacks.onCleared?.();
  }

  processEvent(event: Event): void {
    const eventType = (event as { type?: string }).type;
    if (!eventType) {
      return;
    }

    switch (eventType) {
      case "message.updated":
        this.handleMessageUpdated(event);
        break;
      case "message.part.updated":
        this.handleMessagePartUpdated(event);
        break;
      case "message.part.delta":
        this.handleMessagePartDelta(event);
        break;
      case "question.asked":
        this.handleQuestionAsked(event);
        break;
      case "permission.asked":
        this.handlePermissionAsked(event);
        break;
      case "session.diff":
        this.handleSessionDiff(event);
        break;
      case "session.status":
        this.handleSessionStatus(event);
        break;
      case "session.compacted":
        this.handleSessionCompacted(event);
        break;
      case "session.error":
        this.handleSessionError(event);
        break;
      case "session.idle":
        this.handleSessionIdle(event);
        break;
      default:
        logger.debug(`[SummaryAggregator] Unhandled event type: ${eventType}`);
        break;
    }
  }

  private handleMessageUpdated(event: Event): void {
    const properties = getEventProperties(event);
    const info =
      properties && isRecord(properties.info) ? properties.info : undefined;
    const sessionId = info && getString(info.sessionID);
    const messageId = info && getString(info.id);
    const role = info && getString(info.role);

    if (
      !sessionId ||
      !messageId ||
      !role ||
      sessionId !== this.currentSessionId
    ) {
      return;
    }

    this.messages.set(messageId, { role });
    if (role !== "assistant") {
      return;
    }

    const state = this.getOrCreateTextMessageState(messageId);
    this.ensureTypingStarted(sessionId);

    const time = info.time;
    const timeRecord = isRecord(time) ? time : undefined;
    const isCompleted = typeof getNumber(timeRecord?.completed) === "number";
    const messageText = this.getCombinedMessageText(messageId);
    const tokenEvent = this.createTokenEvent(
      sessionId,
      messageId,
      info,
      isCompleted,
    );

    if (tokenEvent) {
      this.callbacks.onTokenUpdate?.(tokenEvent);
    }

    if (
      !isCompleted &&
      state.optimisticUpdateCount === 1 &&
      messageText.trim()
    ) {
      this.callbacks.onPartial?.(sessionId, messageId, messageText);
    }

    if (!isCompleted) {
      return;
    }

    if (messageText.trim()) {
      this.callbacks.onComplete?.(sessionId, messageId, messageText);
    }

    this.textMessageStates.delete(messageId);
    this.messages.delete(messageId);
    this.partHashes.delete(messageId);
    this.knownTextPartIds.delete(messageId);
    this.reasoningMessages.delete(messageId);

    if (this.textMessageStates.size === 0) {
      this.stopTyping("message_completed", sessionId);
    }
  }

  private handleMessagePartUpdated(event: Event): void {
    const properties = getEventProperties(event);
    const part =
      properties && isRecord(properties.part) ? properties.part : undefined;
    const sessionId = part && getString(part.sessionID);
    const messageId = part && getString(part.messageID);
    const partId = part && getString(part.id);
    const partType = part && getString(part.type);

    if (
      !sessionId ||
      !messageId ||
      !partId ||
      !partType ||
      sessionId !== this.currentSessionId
    ) {
      return;
    }

    if (partType === "text") {
      this.registerKnownTextPart(messageId, partId);
      const text = getString(part.text);
      if (!text) {
        return;
      }

      const messageInfo = this.messages.get(messageId);
      if (messageInfo?.role === "assistant") {
        const wasUpdated = this.setTextPartSnapshot(messageId, partId, text);
        if (!wasUpdated) {
          return;
        }

        const fullText = this.getCombinedMessageText(messageId);
        if (!fullText.trim()) {
          return;
        }

        this.ensureTypingStarted(sessionId);
        this.callbacks.onPartial?.(sessionId, messageId, fullText);
        return;
      }

      const wasUpdated = this.setOptimisticTextSnapshot(
        messageId,
        partId,
        text,
      );
      if (!wasUpdated) {
        return;
      }

      const state = this.getOrCreateTextMessageState(messageId);
      state.optimisticUpdateCount += 1;
      if (state.optimisticUpdateCount >= 2) {
        this.callbacks.onPartial?.(
          sessionId,
          messageId,
          this.getCombinedMessageText(messageId),
        );
      }
      return;
    }

    if (partType === "reasoning") {
      this.reasoningMessages.add(messageId);
      this.ensureTypingStarted(sessionId);
      return;
    }

    if (partType === "subtask") {
      this.ensureTypingStarted(sessionId);
      const agentName = getString(part.agent)?.trim();
      const description = getString(part.description)?.trim();
      const title =
        [agentName, description].filter(Boolean).join(" — ") || "Subagent task";
      const subtaskEvent: SummaryToolEvent = {
        sessionId,
        messageId,
        callId: partId,
        tool: "subtask",
        status: "started",
        title,
      };
      this.callbacks.onTool?.(subtaskEvent);
      return;
    }

    if (partType === "step-start" || partType === "step-finish") {
      this.ensureTypingStarted(sessionId);
      const snapshot = getString(part.snapshot)?.trim();
      const title = snapshot
        ? `Step ${partType === "step-start" ? "started" : "finished"} · ${snapshot.slice(0, 12)}`
        : `Step ${partType === "step-start" ? "started" : "finished"}`;
      this.callbacks.onTool?.({
        sessionId,
        messageId,
        callId: partId,
        tool: "step",
        status: partType === "step-start" ? "running" : "completed",
        title,
      });
      return;
    }

    if (partType !== "tool") {
      return;
    }

    const rawState = isRecord(part.state) ? part.state : undefined;
    const status = rawState && getString(rawState.status);
    const tool = getString(part.tool);
    const callId = getString(part.callID);

    if (!tool || !callId || !status) {
      return;
    }

    if (tool === "question" && status === "error") {
      this.scheduleAsync(() => {
        this.callbacks.onQuestionError?.(sessionId);
      });
      return;
    }

    this.ensureTypingStarted(sessionId);
    const input =
      rawState && isRecord(rawState.input) ? rawState.input : undefined;
    const title = rawState && getString(rawState.title);
    const metadata =
      rawState && isRecord(rawState.metadata) ? rawState.metadata : undefined;

    const processedKey = `${status}:${callId}:${title ?? ""}`;
    if (this.processedToolStates.has(processedKey)) {
      return;
    }
    this.processedToolStates.add(processedKey);

    const preparedTool =
      status === "completed"
        ? this.prepareToolContext(tool, input, title, metadata)
        : {};

    const toolEvent: SummaryToolEvent = {
      sessionId,
      messageId,
      callId,
      tool,
      status,
      input,
      title,
      metadata,
      fileChange: preparedTool.fileChange,
      attachment: preparedTool.attachment,
    };

    this.callbacks.onTool?.(toolEvent);
  }

  private handleMessagePartDelta(event: Event): void {
    const properties = getEventProperties(event);
    if (!properties) {
      return;
    }

    const part = isRecord(properties.part) ? properties.part : undefined;
    const sessionId =
      getString(part?.sessionID) ?? getString(properties.sessionID);
    const messageId =
      getString(part?.messageID) ?? getString(properties.messageID);
    const partId =
      getString(part?.id) ?? getString(properties.partID) ?? "text";
    const partType = getString(part?.type) ?? getString(properties.type);
    const delta = getString(properties.delta);
    const fullTextHint = getString(part?.text);

    if (
      !sessionId ||
      !messageId ||
      !delta ||
      sessionId !== this.currentSessionId
    ) {
      return;
    }

    if (partType && partType !== "text") {
      return;
    }

    if (partType === "text") {
      this.registerKnownTextPart(messageId, partId);
    } else {
      const knownTextIds = this.knownTextPartIds.get(messageId);
      const isKnownTextPart = knownTextIds?.has(partId) ?? false;
      if (this.reasoningMessages.has(messageId) && !isKnownTextPart) {
        return;
      }

      if (!isKnownTextPart) {
        this.registerKnownTextPart(messageId, partId);
      }
    }

    this.registerTextPart(messageId, partId);
    const state = this.getOrCreateTextMessageState(messageId);
    const previous = state.partTexts.get(partId) ?? "";
    const next =
      typeof fullTextHint === "string" &&
      fullTextHint.length > previous.length + delta.length
        ? fullTextHint
        : `${previous}${delta}`;
    state.partTexts.set(partId, next);

    const combined = this.getCombinedMessageText(messageId);
    if (!combined.trim()) {
      return;
    }

    this.ensureTypingStarted(sessionId);
    this.callbacks.onPartial?.(sessionId, messageId, combined);
  }

  private handleQuestionAsked(event: Event): void {
    const properties = getEventProperties(event);
    const sessionId = properties && getString(properties.sessionID);
    const requestId = properties && getString(properties.id);
    const questions = properties?.questions;

    if (
      !sessionId ||
      !requestId ||
      sessionId !== this.currentSessionId ||
      !Array.isArray(questions)
    ) {
      return;
    }

    const normalizedQuestions = questions.filter(isQuestion);
    if (normalizedQuestions.length === 0) {
      return;
    }

    const questionEvent: SummaryQuestionEvent = {
      sessionId,
      requestId,
      questions: normalizedQuestions,
    };

    this.scheduleAsync(() => {
      this.callbacks.onQuestion?.(questionEvent);
    });
  }

  private handlePermissionAsked(event: Event): void {
    const properties = getEventProperties(event);
    if (
      !properties ||
      !isPermissionRequest(properties) ||
      properties.sessionID !== this.currentSessionId
    ) {
      return;
    }

    const permissionEvent: SummaryPermissionEvent = {
      sessionId: properties.sessionID,
      request: properties,
    };

    this.scheduleAsync(() => {
      this.callbacks.onPermission?.(permissionEvent);
    });
  }

  private handleSessionDiff(event: Event): void {
    const properties = getEventProperties(event);
    const sessionId = properties && getString(properties.sessionID);
    const diff = properties?.diff;

    if (
      !sessionId ||
      sessionId !== this.currentSessionId ||
      !Array.isArray(diff)
    ) {
      return;
    }

    const diffs = diff
      .filter(isRecord)
      .map((entry): SummaryFileChange | null => {
        const file = getString(entry.file);
        const additions = getNumber(entry.additions);
        const deletions = getNumber(entry.deletions);

        if (!file || additions === undefined || deletions === undefined) {
          return null;
        }

        return { file, additions, deletions };
      })
      .filter((entry): entry is SummaryFileChange => Boolean(entry));

    const diffEvent: SummarySessionDiffEvent = { sessionId, diffs };
    this.scheduleAsync(() => {
      this.callbacks.onSessionDiff?.(diffEvent);
    });
  }

  private handleSessionStatus(event: Event): void {
    const properties = getEventProperties(event);
    const sessionId = properties && getString(properties.sessionID);
    const status = properties?.status;
    const statusRecord = isRecord(status) ? status : undefined;

    if (
      !sessionId ||
      sessionId !== this.currentSessionId ||
      statusRecord?.type !== "retry"
    ) {
      return;
    }

    const retryInfo: SummarySessionRetryInfo = {
      sessionId,
      attempt: getNumber(statusRecord.attempt),
      message: getString(statusRecord.message)?.trim() || "Unknown retry error",
      next: getNumber(statusRecord.next),
    };

    this.scheduleAsync(() => {
      this.callbacks.onSessionRetry?.(retryInfo);
    });
  }

  private handleSessionCompacted(event: Event): void {
    const properties = getEventProperties(event);
    const sessionId = properties && getString(properties.sessionID);

    if (!sessionId || sessionId !== this.currentSessionId) {
      return;
    }

    const project = this.getCurrentProjectFn();
    if (!project) {
      return;
    }

    this.scheduleAsync(() => {
      this.callbacks.onSessionCompacted?.(sessionId, project.worktree);
    });
  }

  private handleSessionError(event: Event): void {
    const properties = getEventProperties(event);
    const sessionId = properties && getString(properties.sessionID);
    const error = properties?.error;
    const errorRecord = isRecord(error) ? error : undefined;
    const dataRecord = isRecord(errorRecord?.data)
      ? errorRecord.data
      : undefined;
    const message =
      getString(dataRecord?.message) ||
      getString(errorRecord?.message) ||
      getString(errorRecord?.name) ||
      "Unknown session error";

    if (!sessionId || sessionId !== this.currentSessionId) {
      return;
    }

    this.stopTyping("session_error", sessionId);
    this.scheduleAsync(() => {
      this.callbacks.onSessionError?.(sessionId, message);
    });
  }

  private handleSessionIdle(event: Event): void {
    const properties = getEventProperties(event);
    const sessionId = properties && getString(properties.sessionID);
    if (!sessionId || sessionId !== this.currentSessionId) {
      return;
    }

    this.stopTyping("session_idle", sessionId);
    this.scheduleAsync(() => {
      this.callbacks.onSessionIdle?.(sessionId);
    });
  }

  private createTokenEvent(
    sessionId: string,
    messageId: string,
    info: Record<string, unknown>,
    isCompleted: boolean,
  ): SummaryTokenEvent | null {
    const tokensRecord = isRecord(info.tokens) ? info.tokens : undefined;
    if (!tokensRecord) {
      return null;
    }

    const cacheRecord = isRecord(tokensRecord.cache)
      ? tokensRecord.cache
      : undefined;
    const tokens: SummaryTokensInfo = {
      input: getNumber(tokensRecord.input) ?? 0,
      output: getNumber(tokensRecord.output) ?? 0,
      reasoning: getNumber(tokensRecord.reasoning) ?? 0,
      cacheRead: getNumber(cacheRecord?.read) ?? 0,
      cacheWrite: getNumber(cacheRecord?.write) ?? 0,
    };

    return {
      sessionId,
      messageId,
      tokens,
      isCompleted,
    };
  }

  private normalizePathForDisplay(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const project = this.getCurrentProjectFn();
    if (!project?.worktree) {
      return normalizedPath;
    }

    const normalizedWorktree = project.worktree
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    if (!normalizedWorktree) {
      return normalizedPath;
    }

    const pathForCompare =
      process.platform === "win32"
        ? normalizedPath.toLowerCase()
        : normalizedPath;
    const worktreeForCompare =
      process.platform === "win32"
        ? normalizedWorktree.toLowerCase()
        : normalizedWorktree;

    if (pathForCompare === worktreeForCompare) {
      return ".";
    }

    const worktreePrefix = `${worktreeForCompare}/`;
    if (pathForCompare.startsWith(worktreePrefix)) {
      return normalizedPath.slice(normalizedWorktree.length + 1);
    }

    return normalizedPath;
  }

  private buildAttachment(
    displayPath: string,
    content: string,
    operation: "write" | "edit",
  ): SummaryToolAttachment {
    const header =
      operation === "write"
        ? `Write File/Path: ${displayPath}\n\n`
        : `Edit File/Path: ${displayPath}\n\n`;
    const filenamePrefix = operation === "write" ? "write" : "edit";
    const basename = displayPath.split("/").pop() || "file.txt";

    return {
      buffer: Buffer.from(`${header}${content}`, "utf8"),
      filename: `${filenamePrefix}_${basename}.txt`,
      displayPath,
      operation,
    };
  }

  private prepareToolContext(
    tool: string,
    input: Record<string, unknown> | undefined,
    title: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): PreparedToolContext {
    if (tool === "write") {
      const rawPath = getString(input?.filePath);
      const content = getString(input?.content);
      if (!rawPath || content === undefined) {
        return {};
      }

      const displayPath = this.normalizePathForDisplay(rawPath);
      return {
        attachment: this.buildAttachment(displayPath, content, "write"),
        fileChange: {
          file: displayPath,
          additions: countLines(content),
          deletions: 0,
        },
      };
    }

    if (tool === "edit") {
      const filediff = metadata?.filediff;
      const filediffRecord = isRecord(filediff) ? filediff : undefined;
      const rawPath = getString(filediffRecord?.file);
      const diffText = getString(metadata?.diff);
      if (!rawPath || !diffText) {
        return {};
      }

      const displayPath = this.normalizePathForDisplay(rawPath);
      return {
        attachment: this.buildAttachment(
          displayPath,
          formatDiffForAttachment(diffText),
          "edit",
        ),
        fileChange: {
          file: displayPath,
          additions: getNumber(filediffRecord?.additions) ?? 0,
          deletions: getNumber(filediffRecord?.deletions) ?? 0,
        },
      };
    }

    if (tool === "apply_patch") {
      const filediff = metadata?.filediff;
      const filediffRecord = isRecord(filediff) ? filediff : undefined;
      const filePath =
        getString(filediffRecord?.file) ??
        getString(input?.filePath) ??
        getString(input?.path) ??
        (title ? extractFirstUpdatedFileFromTitle(title) : undefined);
      const diffText = getString(metadata?.diff) ?? getString(input?.patchText);
      if (!filePath) {
        return {};
      }

      const displayPath = this.normalizePathForDisplay(filePath);
      const fileChange = filediffRecord
        ? {
            file: displayPath,
            additions: getNumber(filediffRecord.additions) ?? 0,
            deletions: getNumber(filediffRecord.deletions) ?? 0,
          }
        : diffText
          ? {
              file: displayPath,
              ...countDiffChangesFromText(diffText),
            }
          : undefined;

      return {
        attachment: diffText
          ? this.buildAttachment(
              displayPath,
              formatDiffForAttachment(diffText),
              "edit",
            )
          : undefined,
        fileChange,
      };
    }

    return {};
  }

  private ensureTypingStarted(sessionId: string): void {
    if (this.typingActive) {
      return;
    }

    this.typingActive = true;
    this.callbacks.onTypingStart?.(sessionId);
  }

  private stopTyping(
    reason: string,
    sessionId: string | null = this.currentSessionId,
  ): void {
    if (!this.typingActive || !sessionId) {
      this.typingActive = false;
      return;
    }

    this.typingActive = false;
    this.callbacks.onTypingStop?.(sessionId, reason);
  }

  private getOrCreateTextMessageState(messageId: string): TextMessageState {
    const existing = this.textMessageStates.get(messageId);
    if (existing) {
      return existing;
    }

    const state: TextMessageState = {
      orderedPartIds: [],
      partTexts: new Map<string, string>(),
      optimisticUpdateCount: 0,
    };
    this.textMessageStates.set(messageId, state);
    return state;
  }

  private registerKnownTextPart(messageId: string, partId: string): void {
    const existing = this.knownTextPartIds.get(messageId);
    if (existing) {
      existing.add(partId);
      return;
    }

    this.knownTextPartIds.set(messageId, new Set([partId]));
  }

  private registerTextPart(messageId: string, partId: string): void {
    const state = this.getOrCreateTextMessageState(messageId);
    if (!state.orderedPartIds.includes(partId)) {
      state.orderedPartIds.push(partId);
    }
  }

  private setTextPartSnapshot(
    messageId: string,
    partId: string,
    text: string,
  ): boolean {
    const normalized = text;
    const partHash = this.hashString(`${partId}\n${normalized}`);
    const existingHashes = this.partHashes.get(messageId);
    if (existingHashes?.has(partHash)) {
      return false;
    }

    const hashes = existingHashes ?? new Set<string>();
    hashes.add(partHash);
    this.partHashes.set(messageId, hashes);

    this.registerTextPart(messageId, partId);
    this.getOrCreateTextMessageState(messageId).partTexts.set(
      partId,
      normalized,
    );
    return true;
  }

  private setOptimisticTextSnapshot(
    messageId: string,
    partId: string,
    text: string,
  ): boolean {
    const wasUpdated = this.setTextPartSnapshot(messageId, partId, text);
    if (!wasUpdated) {
      return false;
    }

    const state = this.getOrCreateTextMessageState(messageId);
    state.orderedPartIds = [partId];
    state.partTexts = new Map([[partId, text]]);
    return true;
  }

  private getCombinedMessageText(messageId: string): string {
    const state = this.textMessageStates.get(messageId);
    if (!state) {
      return "";
    }

    return state.orderedPartIds
      .map((partId) => state.partTexts.get(partId) ?? "")
      .join("");
  }

  private hashString(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value.charCodeAt(index);
      hash = (hash << 5) - hash + character;
      hash &= hash;
    }

    return hash.toString(36);
  }
}

export const summaryAggregator = new SummaryAggregator();
