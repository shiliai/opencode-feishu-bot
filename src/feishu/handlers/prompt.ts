import type { InteractionManager } from "../../interaction/manager.js";
import type { GuardDecision } from "../../interaction/types.js";
import type { SettingsManager } from "../../settings/manager.js";
import type { Logger } from "../../utils/logger.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import type { FeishuMessageReceiveEvent } from "../event-router.js";
import {
  normalizeFeishuEvent,
  parseFeishuPromptEvent,
} from "../message-events.js";
import type { ChatMessage, MessageReader } from "../message-reader.js";
import type { ResponsePipelineTurnContext } from "../status-store.js";
import {
  type OpenCodeSessionClient,
  resolvePromptSession,
  type SessionResolutionDependencies,
  type SessionResolutionResult,
} from "./session-resolution.js";

export type PromptIngressResult =
  | ({ kind: "dispatched"; text: string } & ResponsePipelineTurnContext)
  | ({
      kind: "appended";
      text: string;
      followUpSummary: string;
    } & ResponsePipelineTurnContext)
  | {
      kind: "blocked";
      reason: string;
      guardDecision?: GuardDecision;
      receiveId?: string;
    }
  | { kind: "unsupported"; messageType: string }
  | { kind: "no-project"; receiveId?: string }
  | {
      kind: "session-reset";
      previousDirectory: string;
      currentDirectory: string;
    }
  | { kind: "ignored-no-mention" };

export type PromptTextPart = {
  type: "text";
  text: string;
};

export type PromptFilePart = {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
};

export type PromptPartInput = PromptTextPart | PromptFilePart;

export interface PromptIngressInput {
  messageId: string;
  chatId: string;
  text: string;
  parts?: PromptPartInput[];
}

export interface OpenCodeSessionStatusClient {
  status(parameters?: { directory?: string }): Promise<{
    data: Record<string, { type: string }> | undefined;
    error: unknown;
  }>;
}

export interface OpenCodePromptAsyncClient {
  promptAsync(parameters: {
    sessionID: string;
    directory?: string;
    parts?: PromptPartInput[];
    model?: { providerID: string; modelID: string };
    agent?: string;
    variant?: string;
  }): Promise<unknown>;
}

export interface OpenCodeSessionMessagePart {
  type: string;
  mime?: string;
  url?: string;
}

export interface OpenCodeSessionMessageRecord {
  info?: {
    id?: string;
    role?: string;
  };
  parts?: OpenCodeSessionMessagePart[];
}

interface PoisonedSessionHistoryInspection {
  offenderCount: number;
  firstOffender?: {
    messageId?: string;
    mime?: string;
    urlScheme?: string;
  };
}

export interface OpenCodeSessionMessagesClient {
  messages(parameters: { sessionID: string; directory?: string }): Promise<{
    data: OpenCodeSessionMessageRecord[] | undefined;
    error: unknown;
  }>;
}

export interface PromptIngressDependencies {
  settings: SettingsManager;
  interactionManager: InteractionManager;
  openCodeSession: OpenCodeSessionClient;
  openCodeSessionStatus: OpenCodeSessionStatusClient;
  openCodeSessionMessages?: OpenCodeSessionMessagesClient;
  openCodePromptAsync: OpenCodePromptAsyncClient;
  messageReader?: MessageReader;
  botOpenId?: string | null;
  logger?: Logger;
  scheduleAsync?: (task: () => void) => void;
}

type ReadyPromptSessionResolution = Extract<
  SessionResolutionResult,
  { kind: "session-ready" }
>;

interface OpenCodeBusyState {
  anyBusy: boolean;
  currentSessionBusy: boolean;
}

const HISTORY_CONTEXT_PREFIX =
  "Recent chat context (oldest to newest, excluding the current message):";
const FOLLOW_UP_SUMMARY_MAX_CHARS = 80;

function summarizeMessageTypes(messages: ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.messageType, (counts.get(message.messageType) ?? 0) + 1);
  }

  return JSON.stringify(Object.fromEntries(counts));
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

export async function isOpenCodeSessionBusy(
  client: OpenCodeSessionStatusClient,
  directory: string,
  logger?: Logger,
): Promise<boolean> {
  const busyState = await getOpenCodeBusyState(client, directory, null, logger);
  return busyState.anyBusy;
}

async function getOpenCodeBusyState(
  client: OpenCodeSessionStatusClient,
  directory: string,
  sessionId: string | null,
  logger?: Logger,
): Promise<OpenCodeBusyState> {
  try {
    const { data, error } = await client.status({ directory });
    if (error || !data) {
      (logger ?? defaultLogger).warn(
        `[PromptIngress] session.status() API error for directory=${directory}, fail-open (treating as not busy)`,
        error,
      );
      return { anyBusy: false, currentSessionBusy: false };
    }

    let anyBusy = false;
    let currentSessionBusy = false;
    for (const [statusSessionId, status] of Object.entries(data)) {
      if (status.type === "busy" || status.type === "retry") {
        anyBusy = true;
        if (sessionId && statusSessionId === sessionId) {
          currentSessionBusy = true;
        }
      }
    }

    return { anyBusy, currentSessionBusy };
  } catch (error) {
    (logger ?? defaultLogger).warn(
      `[PromptIngress] session.status() threw for directory=${directory}, fail-open (treating as not busy)`,
      error,
    );
    return { anyBusy: false, currentSessionBusy: false };
  }
}

export class PromptIngressHandler {
  private readonly settings: SettingsManager;
  private readonly interactionManager: InteractionManager;
  private readonly openCodeSession: OpenCodeSessionClient;
  private readonly openCodeSessionStatus: OpenCodeSessionStatusClient;
  private readonly openCodeSessionMessages: OpenCodeSessionMessagesClient | null;
  private readonly openCodePromptAsync: OpenCodePromptAsyncClient;
  private readonly messageReader: MessageReader | null;
  private readonly botOpenId: string | null;
  private readonly logger: Logger;
  private readonly scheduleAsync: (task: () => void) => void;

  constructor(dependencies: PromptIngressDependencies) {
    this.settings = dependencies.settings;
    this.interactionManager = dependencies.interactionManager;
    this.openCodeSession = dependencies.openCodeSession;
    this.openCodeSessionStatus = dependencies.openCodeSessionStatus;
    this.openCodeSessionMessages = dependencies.openCodeSessionMessages ?? null;
    this.openCodePromptAsync = dependencies.openCodePromptAsync;
    this.messageReader = dependencies.messageReader ?? null;
    this.botOpenId = dependencies.botOpenId ?? null;
    this.logger = dependencies.logger ?? defaultLogger;
    this.scheduleAsync =
      dependencies.scheduleAsync ?? ((task) => setImmediate(task));
  }

  private getBasePromptParts(input: PromptIngressInput): PromptPartInput[] {
    return [...(input.parts ?? [{ type: "text", text: input.text }])];
  }

  private buildFollowUpSummary(input: PromptIngressInput): string {
    const baseParts = this.getBasePromptParts(input);
    const textContent = normalizeInlineText(
      baseParts
        .filter((part): part is PromptTextPart => part.type === "text")
        .map((part) => part.text)
        .join(" "),
    );
    const fileCount = baseParts.filter((part) => part.type === "file").length;

    const preview = textContent
      ? truncateInlineText(textContent, FOLLOW_UP_SUMMARY_MAX_CHARS)
      : undefined;
    const fileSuffix =
      fileCount > 0 ? ` (+${fileCount} file${fileCount === 1 ? "" : "s"})` : "";

    if (preview) {
      return `📥 Follow-up added: ${preview}${fileSuffix}`;
    }

    if (fileCount > 0) {
      return `📥 Follow-up added${fileSuffix}`;
    }

    return "📥 Follow-up added";
  }

  private formatHistorySender(message: ChatMessage): string {
    if (message.senderId.trim().length > 0) {
      return `${message.senderType}:${message.senderId}`;
    }

    return message.senderType;
  }

  private createHistoryContextPart(
    messages: ChatMessage[],
  ): PromptTextPart | null {
    const historyLines = messages
      .filter((message) => message.content.trim().length > 0)
      .reverse()
      .map(
        (message) =>
          `- ${this.formatHistorySender(message)}: ${message.content.trim()}`,
      );

    if (historyLines.length === 0) {
      return null;
    }

    return {
      type: "text",
      text: `${HISTORY_CONTEXT_PREFIX}\n${historyLines.join("\n")}`,
    };
  }

  private async buildPromptParts(
    input: PromptIngressInput,
  ): Promise<PromptPartInput[]> {
    const baseParts = this.getBasePromptParts(input);
    if (!this.messageReader) {
      return baseParts;
    }

    try {
      const historyMessages = await this.messageReader.getChatMessages({
        chatId: input.chatId,
      });
      const filteredHistoryMessages = historyMessages.filter(
        (message) => message.messageId !== input.messageId,
      );
      const historyPart = this.createHistoryContextPart(
        filteredHistoryMessages,
      );

      if (!historyPart) {
        this.logger.debug(
          `[PromptIngress] History context empty after filtering: chatId=${input.chatId}, fetched=${historyMessages.length}, included=${filteredHistoryMessages.length}, messageTypes=${summarizeMessageTypes(filteredHistoryMessages)}`,
        );
        return baseParts;
      }

      this.logger.debug(
        `[PromptIngress] History context prepared: chatId=${input.chatId}, fetched=${historyMessages.length}, included=${filteredHistoryMessages.length}, messageTypes=${summarizeMessageTypes(filteredHistoryMessages)}, historyChars=${historyPart.text.length}`,
      );

      return [historyPart, ...baseParts];
    } catch (error) {
      this.logger.warn(
        `[PromptIngress] Failed to load chat history for chat=${input.chatId}, continuing without history context`,
        error,
      );
      return baseParts;
    }
  }

  private async resolvePromptParts(
    input: PromptIngressInput,
    includeHistory: boolean,
  ): Promise<PromptPartInput[]> {
    return includeHistory
      ? this.buildPromptParts(input)
      : this.getBasePromptParts(input);
  }

  private hasFileParts(input: PromptIngressInput): boolean {
    return (input.parts ?? []).some((part) => part.type === "file");
  }

  private isPoisonedHistoryFilePart(
    message: OpenCodeSessionMessageRecord,
    part: OpenCodeSessionMessagePart,
  ): boolean {
    if (message.info?.role !== "user" || part.type !== "file") {
      return false;
    }

    if (part.mime === "application/octet-stream") {
      return true;
    }

    return (
      typeof part.url === "string" &&
      part.url.startsWith("data:application/octet-stream;")
    );
  }

  private async inspectPoisonedFileHistory(
    sessionID: string,
    directory: string,
  ): Promise<PoisonedSessionHistoryInspection | null> {
    if (!this.openCodeSessionMessages) {
      return null;
    }

    try {
      const { data, error } = await this.openCodeSessionMessages.messages({
        sessionID,
        directory,
      });
      if (error || !data) {
        this.logger.warn(
          `[PromptIngress] Failed to inspect session history for session=${sessionID}, continuing without poisoned-history reset`,
          error,
        );
        return null;
      }

      const offenders = data.flatMap((message) =>
        (message.parts ?? [])
          .filter((part) => this.isPoisonedHistoryFilePart(message, part))
          .map((part) => ({
            messageId: message.info?.id,
            mime: part.mime,
            urlScheme:
              typeof part.url === "string"
                ? part.url.slice(
                    0,
                    part.url.indexOf(",") > 0 ? part.url.indexOf(",") : 40,
                  )
                : undefined,
          })),
      );

      if (offenders.length === 0) {
        return null;
      }

      return {
        offenderCount: offenders.length,
        firstOffender: offenders[0],
      };
    } catch (error) {
      this.logger.warn(
        `[PromptIngress] Error while inspecting session history for session=${sessionID}, continuing without poisoned-history reset`,
        error,
      );
      return null;
    }
  }

  async handleMessageEvent(
    event: FeishuMessageReceiveEvent,
  ): Promise<PromptIngressResult> {
    const parsed = parseFeishuPromptEvent(event, { botOpenId: this.botOpenId });

    if (!parsed) {
      const classification = this.classifyUnparsedEvent(event);
      this.logger.debug(
        `[PromptIngress] Unparsed event classified: kind=${classification.kind}` +
          (classification.kind === "unsupported"
            ? `, messageType=${(classification as { kind: "unsupported"; messageType: string }).messageType}`
            : ""),
      );
      return classification;
    }

    return this.handlePromptInput({
      messageId: parsed.messageId,
      chatId: parsed.chatId,
      text: parsed.text,
      parts: [{ type: "text", text: parsed.text }],
    });
  }

  async handlePromptInput(
    input: PromptIngressInput,
  ): Promise<PromptIngressResult> {
    return this.handlePromptDispatch(input);
  }

  private classifyUnparsedEvent(
    event: FeishuMessageReceiveEvent,
  ): PromptIngressResult {
    const normalized = normalizeFeishuEvent(event);
    const rawMessage = normalized.message;

    const messageType =
      typeof rawMessage?.message_type === "string"
        ? rawMessage.message_type
        : null;
    const chatType =
      typeof rawMessage?.chat_type === "string" ? rawMessage.chat_type : null;

    if (chatType === "group" && messageType === "text") {
      return { kind: "ignored-no-mention" };
    }

    if (chatType === "group" && messageType === "post") {
      return { kind: "ignored-no-mention" };
    }

    if (messageType) {
      return { kind: "unsupported", messageType };
    }

    if (chatType === "group") {
      return { kind: "ignored-no-mention" };
    }

    return { kind: "unsupported", messageType: messageType ?? "unknown" };
  }

  private schedulePromptDispatch(
    input: PromptIngressInput,
    resolution: ReadyPromptSessionResolution,
    options: {
      includeHistory: boolean;
      includeModelSettings: boolean;
      clearBusyOnError: boolean;
      mode: "dispatched" | "appended";
    },
  ): void {
    this.scheduleAsync(async () => {
      try {
        const parts = await this.resolvePromptParts(
          input,
          options.includeHistory,
        );
        const historyIncluded = parts.some(
          (part) =>
            part.type === "text" &&
            part.text.startsWith(HISTORY_CONTEXT_PREFIX),
        );

        const fileParts = parts.filter(
          (p): p is Extract<PromptPartInput, { type: "file" }> =>
            p.type === "file",
        );
        if (fileParts.length > 0) {
          for (const fp of fileParts) {
            this.logger.debug(
              `[PromptIngress] HOP-4 prompt file part: mime=${fp.mime}, filename=${fp.filename ?? "N/A"}, urlScheme=${fp.url.slice(0, 40)}..., urlLength=${fp.url.length}`,
            );
          }
        }

        const promptParams: {
          sessionID: string;
          directory: string;
          parts: PromptPartInput[];
          model?: { providerID: string; modelID: string };
          agent?: string;
          variant?: string;
        } = {
          sessionID: resolution.sessionInfo.id,
          directory: resolution.directory,
          parts,
        };

        if (options.includeModelSettings) {
          const model = this.settings.getCurrentModel();
          const agent = this.settings.getCurrentAgent();

          if (model) {
            promptParams.model = {
              providerID: model.providerID,
              modelID: model.modelID,
            };
          }
          if (agent) {
            promptParams.agent = agent;
          }
          if (model?.variant) {
            promptParams.variant = model.variant;
          }
        }

        this.logger.info(
          `[PromptIngress] ${options.mode === "appended" ? "Appending follow-up" : "Dispatching prompt"}: sourceMessageId=${input.messageId}, chatId=${input.chatId}, session=${resolution.sessionInfo.id}, directory=${resolution.directory}, historyIncluded=${historyIncluded}, totalParts=${parts.length}, fileParts=${fileParts.length}, includeModelSettings=${options.includeModelSettings}`,
        );

        await this.openCodePromptAsync.promptAsync(promptParams);

        this.logger.info(
          `[PromptIngress] ${options.mode === "appended" ? "Follow-up appended" : "Prompt dispatched"}: sourceMessageId=${input.messageId}, session=${resolution.sessionInfo.id}, directory=${resolution.directory}, fileParts=${fileParts.length}`,
        );
      } catch (error) {
        this.logger.error(
          `[PromptIngress] Async ${options.mode === "appended" ? "append" : "prompt"} error: sourceMessageId=${input.messageId}, chatId=${input.chatId}, session=${resolution.sessionInfo.id}, directory=${resolution.directory}`,
          error,
        );
        if (options.clearBusyOnError) {
          this.interactionManager.clearBusy(input.chatId);
        }
      }
    });
  }

  private async handlePromptDispatch(
    input: PromptIngressInput,
  ): Promise<PromptIngressResult> {
    const guardDecision = this.interactionManager.resolveGuardDecision(
      input.chatId,
      {
        text: input.text,
        type: "text",
      },
    );

    if (!guardDecision.allow) {
      this.logger.info(
        `[PromptIngress] Blocked by interaction guard: reason=${guardDecision.reason}, busy=${guardDecision.busy}`,
      );
      return {
        kind: "blocked",
        reason: guardDecision.reason ?? "guard_blocked",
        guardDecision,
        receiveId: input.chatId,
      };
    }

    const sessionDeps: SessionResolutionDependencies = {
      chatId: input.chatId,
      settings: this.settings,
      openCodeSession: this.openCodeSession,
      logger: this.logger,
    };

    let resolution: SessionResolutionResult;
    try {
      resolution = await resolvePromptSession(sessionDeps);
    } catch (error) {
      this.logger.error("[PromptIngress] Session resolution failed", error);
      return {
        kind: "blocked",
        reason: "session_creation_failed",
        receiveId: input.chatId,
      };
    }

    if (resolution.kind === "no-project") {
      return { kind: "no-project", receiveId: input.chatId };
    }

    if (resolution.kind === "session-reset") {
      return {
        kind: "session-reset",
        previousDirectory: resolution.previousDirectory,
        currentDirectory: resolution.currentDirectory,
      };
    }

    const poisonedHistoryInspection = this.hasFileParts(input)
      ? await this.inspectPoisonedFileHistory(
          resolution.sessionInfo.id,
          resolution.directory,
        )
      : null;

    if (poisonedHistoryInspection) {
      this.logger.warn(
        `[PromptIngress] Resetting poisoned session before file prompt: session=${resolution.sessionInfo.id}, offenderCount=${poisonedHistoryInspection.offenderCount}, firstOffenderMessage=${poisonedHistoryInspection.firstOffender?.messageId ?? "unknown"}, firstOffenderMime=${poisonedHistoryInspection.firstOffender?.mime ?? "unknown"}, firstOffenderUrlScheme=${poisonedHistoryInspection.firstOffender?.urlScheme ?? "unknown"}`,
      );
      const previousSessionId = resolution.sessionInfo.id;
      this.settings.clearChatSession(input.chatId);
      this.settings.clearChatStatusMessageId(input.chatId);

      try {
        resolution = await resolvePromptSession(sessionDeps);
      } catch (error) {
        this.logger.error(
          "[PromptIngress] Session recreation failed after poisoned-history reset",
          error,
        );
        return {
          kind: "blocked",
          reason: "session_creation_failed",
          receiveId: input.chatId,
        };
      }

      if (resolution.kind === "no-project") {
        return { kind: "no-project", receiveId: input.chatId };
      }

      if (resolution.kind === "session-reset") {
        return {
          kind: "session-reset",
          previousDirectory: resolution.previousDirectory,
          currentDirectory: resolution.currentDirectory,
        };
      }

      this.logger.info(
        `[PromptIngress] Recreated session after poisoned-history reset: previousSession=${previousSessionId}, newSession=${resolution.sessionInfo.id}, directory=${resolution.directory}`,
      );
    }

    const busyState = await getOpenCodeBusyState(
      this.openCodeSessionStatus,
      resolution.directory,
      resolution.sessionInfo.id,
      this.logger,
    );

    if (busyState.currentSessionBusy) {
      this.logger.info(
        `[PromptIngress] Appending follow-up to busy session: session=${resolution.sessionInfo.id}, directory=${resolution.directory}`,
      );
      this.schedulePromptDispatch(input, resolution, {
        includeHistory: false,
        includeModelSettings: false,
        clearBusyOnError: false,
        mode: "appended",
      });
      return {
        kind: "appended",
        sessionId: resolution.sessionInfo.id,
        directory: resolution.directory,
        receiveId: input.chatId,
        sourceMessageId: input.messageId,
        text: input.text,
        followUpSummary: this.buildFollowUpSummary(input),
      };
    }

    if (busyState.anyBusy) {
      this.logger.info(
        `[PromptIngress] Blocked: another OpenCode session is busy for directory=${resolution.directory}`,
      );
      return {
        kind: "blocked",
        reason: "session_busy",
        receiveId: input.chatId,
      };
    }

    this.interactionManager.startBusy(input.chatId, {
      messageId: input.messageId,
    });

    this.schedulePromptDispatch(input, resolution, {
      includeHistory: true,
      includeModelSettings: true,
      clearBusyOnError: true,
      mode: "dispatched",
    });

    return {
      kind: "dispatched",
      sessionId: resolution.sessionInfo.id,
      directory: resolution.directory,
      receiveId: input.chatId,
      sourceMessageId: input.messageId,
      text: input.text,
    };
  }
}
