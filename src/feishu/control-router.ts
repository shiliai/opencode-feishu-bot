import type { Logger } from "../utils/logger.js";
import type {
  SettingsManager,
  SessionInfo,
  ModelInfo,
} from "../settings/manager.js";
import type { SessionManager } from "../session/manager.js";
import type { FeishuRenderer } from "../feishu/renderer.js";
import type { InteractionManager } from "../interaction/manager.js";
import { DEFAULT_CONTROL_CATALOG_CACHE_TTL_MS } from "../config.js";
import {
  buildHelpCard,
  buildSessionListCard,
  buildModelPickerCard,
  buildAgentPickerCard,
  buildStatusCard,
} from "./control-cards.js";
import type { SessionSummary } from "./control-cards.js";
import {
  ControlCatalogAdapter,
  type ControlCatalogProvider,
  type OpenCodeControlCatalogClient,
} from "./control-catalog.js";

export type ControlCommand =
  | "/help"
  | "/new"
  | "/sessions"
  | "/session"
  | "/model"
  | "/agent"
  | "/status"
  | "/abort";

export interface ControlCommandResult {
  success: boolean;
  message?: string;
  cardMessageId?: string;
}

const SUPPORTED_COMMANDS = new Set<string>([
  "/help",
  "/new",
  "/sessions",
  "/session",
  "/model",
  "/agent",
  "/status",
  "/abort",
]);

export interface OpenCodeSessionClient {
  create(
    parameters?: Record<string, unknown>,
  ): Promise<{ data?: Record<string, unknown> }>;
  list(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
  status(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
  abort(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
}

export interface OpenCodeControlClient extends OpenCodeControlCatalogClient {
  session: OpenCodeSessionClient;
}

export type ControlRouterSettingsStore = Pick<
  SettingsManager,
  | "getCurrentProject"
  | "getCurrentSession"
  | "setCurrentSession"
  | "getCurrentAgent"
  | "setCurrentAgent"
  | "getCurrentModel"
  | "setCurrentModel"
>;

export type ControlRouterSessionStore = Pick<
  SessionManager,
  "getCurrentSession" | "setCurrentSession"
>;

export type ControlRouterRenderer = Pick<FeishuRenderer, "sendCard">;

export type ControlRouterInteractionStore = Pick<
  InteractionManager,
  "clearBusy" | "isBusy"
>;

export interface ControlRouterOptions {
  settingsManager: ControlRouterSettingsStore;
  sessionManager: ControlRouterSessionStore;
  renderer: ControlRouterRenderer;
  openCodeClient: OpenCodeControlClient;
  catalogAdapter?: ControlCatalogProvider;
  catalogCacheTtlMs?: number;
  catalogModelStatePath?: string;
  interactionManager: ControlRouterInteractionStore;
  logger?: Logger;
}

function createNoopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlRouter {
  private readonly settings: ControlRouterSettingsStore;
  private readonly sessionManager: ControlRouterSessionStore;
  private readonly renderer: ControlRouterRenderer;
  private readonly openCodeSession: OpenCodeSessionClient;
  private readonly interactionManager: ControlRouterInteractionStore;
  private readonly logger: Logger;
  private readonly catalogAdapter: ControlCatalogProvider;

  constructor(options: ControlRouterOptions) {
    this.settings = options.settingsManager;
    this.sessionManager = options.sessionManager;
    this.renderer = options.renderer;
    this.openCodeSession = options.openCodeClient.session;
    this.interactionManager = options.interactionManager;
    this.logger = options.logger ?? createNoopLogger();
    this.catalogAdapter =
      options.catalogAdapter ??
      new ControlCatalogAdapter({
        settingsManager: this.settings,
        openCodeClient: options.openCodeClient,
        cacheTtlMs:
          options.catalogCacheTtlMs ?? DEFAULT_CONTROL_CATALOG_CACHE_TTL_MS,
        modelStatePath: options.catalogModelStatePath,
        logger: this.logger,
      });
  }

  parseCommand(
    text: string,
  ): { command: ControlCommand; args?: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }

    const normalized = trimmed.toLowerCase();
    const spaceIndex = normalized.indexOf(" ");
    const commandPart =
      spaceIndex === -1 ? normalized : normalized.slice(0, spaceIndex);
    const args =
      spaceIndex === -1
        ? undefined
        : text
            .trim()
            .slice(spaceIndex + 1)
            .trim();

    if (!SUPPORTED_COMMANDS.has(commandPart)) {
      return null;
    }

    return { command: commandPart as ControlCommand, args: args || undefined };
  }

  async handleCommand(
    receiveId: string,
    text: string,
  ): Promise<ControlCommandResult> {
    const parsed = this.parseCommand(text);
    if (!parsed) {
      return { success: false, message: "Unsupported command" };
    }

    const { command, args } = parsed;

    switch (command) {
      case "/help":
        return this.handleHelp(receiveId);
      case "/new":
        return this.handleNew(receiveId);
      case "/sessions":
        return this.handleSessions(receiveId);
      case "/session":
        return this.handleSession(receiveId, args);
      case "/model":
        return this.handleModel(receiveId, args);
      case "/agent":
        return this.handleAgent(receiveId, args);
      case "/status":
        return this.handleStatus(receiveId);
      case "/abort":
        return this.handleAbort(receiveId);
    }
  }

  async handleCardAction(
    event: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    const actionRecord = isRecord(event.action) ? event.action : null;
    const value =
      actionRecord && isRecord(actionRecord.value) ? actionRecord.value : null;
    const action = typeof value?.action === "string" ? value.action : null;

    switch (action) {
      case "select_session": {
        const sessionId =
          typeof value?.sessionId === "string" ? value.sessionId : null;
        if (sessionId) {
          await this.handleSession("", sessionId);
        }
        break;
      }
      case "select_model": {
        const modelName =
          typeof value?.modelName === "string" ? value.modelName : null;
        if (modelName) {
          await this.handleModel("", modelName);
        }
        break;
      }
      case "select_agent": {
        const agentName =
          typeof value?.agentName === "string" ? value.agentName : null;
        if (agentName) {
          await this.handleAgent("", agentName);
        }
        break;
      }
      case "control_cancel":
        this.interactionManager.clearBusy();
        break;
      default:
        break;
    }

    return {};
  }

  private async handleHelp(receiveId: string): Promise<ControlCommandResult> {
    const card = buildHelpCard();
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async handleNew(_receiveId: string): Promise<ControlCommandResult> {
    try {
      const result = await this.openCodeSession.create({});
      const sessionData = result.data;
      if (
        !sessionData ||
        typeof sessionData !== "object" ||
        !("id" in sessionData)
      ) {
        return { success: false, message: "Failed to create session" };
      }

      const sessionId = String(sessionData.id);
      const sessionInfo: SessionInfo = {
        id: sessionId,
        title: "New session",
        directory: process.cwd(),
      };
      this.settings.setCurrentSession(sessionInfo);
      this.logger.info(`[ControlRouter] Created new session: ${sessionId}`);
      return { success: true, message: `Session created: ${sessionId}` };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to create session", error);
      return { success: false, message: "Failed to create session" };
    }
  }

  private async handleSessions(
    receiveId: string,
  ): Promise<ControlCommandResult> {
    try {
      const result = await this.openCodeSession.list({});
      const sessions = Array.isArray(result.data) ? result.data : [];
      const summaries: SessionSummary[] = sessions.map((s: unknown) => {
        const record = s as Record<string, unknown>;
        return {
          id: String(record.id ?? ""),
          title: record.title ? String(record.title) : undefined,
          ...record,
        };
      });
      const card = buildSessionListCard(summaries);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to list sessions", error);
      return { success: false, message: "Failed to list sessions" };
    }
  }

  private async handleSession(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    if (!args) {
      // No session ID provided — show session list as picker
      return this.handleSessions(receiveId);
    }

    // Switch to the specified session
    const sessionId = args.trim();
    const currentSession = this.sessionManager.getCurrentSession();
    if (currentSession) {
      this.sessionManager.setCurrentSession({
        ...currentSession,
        id: sessionId,
        title: currentSession.title,
        directory: currentSession.directory,
      });
    } else {
      this.sessionManager.setCurrentSession({
        id: sessionId,
        title: sessionId,
        directory: process.cwd(),
      });
    }
    this.logger.info(`[ControlRouter] Switched to session: ${sessionId}`);
    return { success: true, message: `Switched to session: ${sessionId}` };
  }

  private async handleModel(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    if (!args) {
      // Show model picker card
      const models = await this.catalogAdapter.getAvailableModels();
      const card = buildModelPickerCard(models);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    }

    const modelName = args.trim();
    const selectedModel = await this.resolveModelSelection(modelName);
    if (!selectedModel) {
      return {
        success: false,
        message:
          "Unknown model. Use provider/model (for example openai/gpt-4o) or a unique bare model name from the catalog.",
      };
    }

    const selectedModelName = `${selectedModel.providerID}/${selectedModel.modelID}`;
    this.settings.setCurrentModel(selectedModel);
    this.logger.info(`[ControlRouter] Switched to model: ${selectedModelName}`);
    return {
      success: true,
      message: `Model switched to: ${selectedModelName}`,
    };
  }

  private async handleAgent(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    if (!args) {
      // Show agent picker card
      const agents = await this.catalogAdapter.getAvailableAgents();
      const card = buildAgentPickerCard(agents);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    }

    const agentName = args.trim();
    this.settings.setCurrentAgent(agentName);
    this.logger.info(`[ControlRouter] Switched to agent: ${agentName}`);
    return { success: true, message: `Agent switched to: ${agentName}` };
  }

  private async handleStatus(receiveId: string): Promise<ControlCommandResult> {
    const currentSession = this.sessionManager.getCurrentSession();
    const currentModel = this.settings.getCurrentModel();
    const currentAgent = this.settings.getCurrentAgent();

    const modelDisplay = currentModel
      ? `${currentModel.providerID}/${currentModel.modelID}`
      : null;

    const state = this.interactionManager.isBusy() ? "busy" : "idle";

    const card = buildStatusCard({
      session: currentSession?.id ?? null,
      model: modelDisplay,
      agent: currentAgent ?? null,
      state,
    });
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async handleAbort(_receiveId: string): Promise<ControlCommandResult> {
    const currentSession = this.sessionManager.getCurrentSession();
    if (!currentSession) {
      return { success: false, message: "No active session to abort" };
    }

    try {
      await this.openCodeSession.abort({ sessionID: currentSession.id });
      this.interactionManager.clearBusy();
      this.logger.info(`[ControlRouter] Aborted session: ${currentSession.id}`);
      return {
        success: true,
        message: `Session aborted: ${currentSession.id}`,
      };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to abort session", error);
      return { success: false, message: "Failed to abort session" };
    }
  }

  private parseModelSelection(modelName: string): ModelInfo | null {
    const separator = modelName.indexOf("/");
    if (separator <= 0 || separator >= modelName.length - 1) {
      return null;
    }

    return {
      providerID: modelName.slice(0, separator),
      modelID: modelName.slice(separator + 1),
    };
  }

  private async resolveModelSelection(
    modelName: string,
  ): Promise<ModelInfo | null> {
    const explicitModel = this.parseModelSelection(modelName);
    if (explicitModel) {
      return explicitModel;
    }

    const availableModels = await this.catalogAdapter.getAvailableModels();
    const suffixMatches = availableModels.filter((candidate) => {
      const separator = candidate.indexOf("/");
      return separator > 0 && candidate.slice(separator + 1) === modelName;
    });

    if (suffixMatches.length !== 1) {
      return null;
    }

    return this.parseModelSelection(suffixMatches[0]);
  }
}
