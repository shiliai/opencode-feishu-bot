import type { FeishuMessageReceiveEvent } from "../event-router.js";
import { parseFeishuPromptEvent } from "../message-events.js";
import type { ResponsePipelineTurnContext } from "../status-store.js";
import type { GuardDecision } from "../../interaction/types.js";
import { InteractionManager } from "../../interaction/manager.js";
import type { SettingsManager } from "../../settings/manager.js";
import type { Logger } from "../../utils/logger.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import {
  resolvePromptSession,
  type OpenCodeSessionClient,
  type SessionResolutionDependencies,
  type SessionResolutionResult,
} from "./session-resolution.js";

export type PromptIngressResult =
  | ({ kind: "dispatched"; text: string } & ResponsePipelineTurnContext)
  | { kind: "blocked"; reason: string; guardDecision?: GuardDecision }
  | { kind: "unsupported"; messageType: string }
  | { kind: "no-project" }
  | { kind: "session-reset"; previousDirectory: string; currentDirectory: string }
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
  status(parameters?: {
    directory?: string;
  }): Promise<{ data: Record<string, { type: string }> | undefined; error: unknown }>;
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

export interface PromptIngressDependencies {
  settings: SettingsManager;
  interactionManager: InteractionManager;
  openCodeSession: OpenCodeSessionClient;
  openCodeSessionStatus: OpenCodeSessionStatusClient;
  openCodePromptAsync: OpenCodePromptAsyncClient;
  botOpenId?: string | null;
  logger?: Logger;
  scheduleAsync?: (task: () => void) => void;
}

export async function isOpenCodeSessionBusy(
  client: OpenCodeSessionStatusClient,
  directory: string,
  logger?: Logger,
): Promise<boolean> {
  try {
    const { data, error } = await client.status({ directory });
    if (error || !data) {
      (logger ?? defaultLogger).warn(
        `[PromptIngress] session.status() API error for directory=${directory}, fail-open (treating as not busy)`,
        error,
      );
      return false;
    }

    for (const status of Object.values(data)) {
      if (status.type === "busy" || status.type === "retry") {
        return true;
      }
    }

    return false;
  } catch (error) {
    (logger ?? defaultLogger).warn(
      `[PromptIngress] session.status() threw for directory=${directory}, fail-open (treating as not busy)`,
      error,
    );
    return false;
  }
}

export class PromptIngressHandler {
  private readonly settings: SettingsManager;
  private readonly interactionManager: InteractionManager;
  private readonly openCodeSession: OpenCodeSessionClient;
  private readonly openCodeSessionStatus: OpenCodeSessionStatusClient;
  private readonly openCodePromptAsync: OpenCodePromptAsyncClient;
  private readonly botOpenId: string | null;
  private readonly logger: Logger;
  private readonly scheduleAsync: (task: () => void) => void;

  constructor(dependencies: PromptIngressDependencies) {
    this.settings = dependencies.settings;
    this.interactionManager = dependencies.interactionManager;
    this.openCodeSession = dependencies.openCodeSession;
    this.openCodeSessionStatus = dependencies.openCodeSessionStatus;
    this.openCodePromptAsync = dependencies.openCodePromptAsync;
    this.botOpenId = dependencies.botOpenId ?? null;
    this.logger = dependencies.logger ?? defaultLogger;
    this.scheduleAsync = dependencies.scheduleAsync ?? ((task) => setImmediate(task));
  }

  async handleMessageEvent(
    event: FeishuMessageReceiveEvent,
  ): Promise<PromptIngressResult> {
    const parsed = parseFeishuPromptEvent(event, { botOpenId: this.botOpenId });

    if (!parsed) {
      return this.classifyUnparsedEvent(event);
    }

    return this.handlePromptInput({
      messageId: parsed.messageId,
      chatId: parsed.chatId,
      text: parsed.text,
      parts: [{ type: "text", text: parsed.text }],
    });
  }

  async handlePromptInput(input: PromptIngressInput): Promise<PromptIngressResult> {
    return this.handlePromptDispatch(input);
  }

  private classifyUnparsedEvent(event: FeishuMessageReceiveEvent): PromptIngressResult {
    const rawEvent =
      typeof event.event === "object" && event.event !== null && !Array.isArray(event.event)
        ? (event.event as Record<string, unknown>)
        : null;
    const rawMessage =
      rawEvent && typeof rawEvent.message === "object" && rawEvent.message !== null
        ? (rawEvent.message as Record<string, unknown>)
        : null;
    const messageType = typeof rawMessage?.message_type === "string" ? rawMessage.message_type : null;
    const chatType = typeof rawMessage?.chat_type === "string" ? rawMessage.chat_type : null;

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

  private async handlePromptDispatch(
    input: PromptIngressInput,
  ): Promise<PromptIngressResult> {
    const guardDecision = this.interactionManager.resolveGuardDecision({
      text: input.text,
      type: "text",
    });

    if (!guardDecision.allow) {
      this.logger.info(
        `[PromptIngress] Blocked by interaction guard: reason=${guardDecision.reason}, busy=${guardDecision.busy}`,
      );
      return {
        kind: "blocked",
        reason: guardDecision.reason ?? "guard_blocked",
        guardDecision,
      };
    }

    const sessionDeps: SessionResolutionDependencies = {
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
      };
    }

    if (resolution.kind === "no-project") {
      return { kind: "no-project" };
    }

    if (resolution.kind === "session-reset") {
      return {
        kind: "session-reset",
        previousDirectory: resolution.previousDirectory,
        currentDirectory: resolution.currentDirectory,
      };
    }

    const busy = await isOpenCodeSessionBusy(
      this.openCodeSessionStatus,
      resolution.directory,
      this.logger,
    );

    if (busy) {
      this.logger.info(
        `[PromptIngress] Blocked: OpenCode session is busy for directory=${resolution.directory}`,
      );
      return {
        kind: "blocked",
        reason: "session_busy",
      };
    }

    const model = this.settings.getCurrentModel();
    const agent = this.settings.getCurrentAgent();

    this.interactionManager.startBusy({ messageId: input.messageId });

    this.scheduleAsync(async () => {
      try {
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
          parts: input.parts ?? [{ type: "text", text: input.text }],
        };

        if (model) {
          promptParams.model = { providerID: model.providerID, modelID: model.modelID };
        }
        if (agent) {
          promptParams.agent = agent;
        }
        if (model?.variant) {
          promptParams.variant = model.variant;
        }

        await this.openCodePromptAsync.promptAsync(promptParams);

        this.logger.info(
          `[PromptIngress] Prompt dispatched: session=${resolution.sessionInfo.id}, directory=${resolution.directory}`,
        );
      } catch (error) {
        this.logger.error(
          `[PromptIngress] Async prompt error for session=${resolution.sessionInfo.id}`,
          error,
        );
        this.interactionManager.clearBusy();
      }
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
