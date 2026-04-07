import { DEFAULT_CONTROL_CATALOG_CACHE_TTL_MS } from "../config.js";
import type { FeishuRenderer } from "../feishu/renderer.js";
import type { InteractionManager } from "../interaction/manager.js";
import type { SessionManager } from "../session/manager.js";
import type {
  ModelInfo,
  ProjectInfo,
  SessionInfo,
  SettingsManager,
} from "../settings/manager.js";
import type { Logger } from "../utils/logger.js";
import { buildConfirmCard } from "./cards.js";
import type { FeishuClients } from "./client.js";
import type { ProjectSummary, SessionSummary } from "./control-cards.js";
import {
  buildAgentPickerCard,
  buildHelpCard,
  buildHistoryCard,
  buildModelPickerCard,
  buildProjectPickerCard,
  buildSessionListCard,
  buildStatusCard,
} from "./control-cards.js";
import {
  ControlCatalogAdapter,
  type ControlCatalogProvider,
  type OpenCodeControlCatalogClient,
} from "./control-catalog.js";
import { MessageReader } from "./message-reader.js";

export type ControlCommand =
  | "/help"
  | "/new"
  | "/projects"
  | "/sessions"
  | "/session"
  | "/history"
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
  "/projects",
  "/sessions",
  "/session",
  "/history",
  "/model",
  "/agent",
  "/status",
  "/abort",
]);

const DEFAULT_HISTORY_COUNT = 10;

const ZERO_WIDTH_CHARACTER_PATTERN = /[\u200B-\u200D\uFEFF]/g;

function normalizeCommandInput(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(ZERO_WIDTH_CHARACTER_PATTERN, "")
    .trim();
  if (!normalized) {
    return "";
  }

  const withoutXmlMention = normalized.replace(
    /^(?:<at\b[^>]*>[^<]*<\/at>\s*)+/i,
    "",
  );
  const withoutPlaceholderMention = withoutXmlMention.replace(
    /^(?:@_user_\d+\s*)+/i,
    "",
  );

  if (withoutPlaceholderMention.startsWith("/")) {
    return withoutPlaceholderMention;
  }

  const slashIndex = withoutPlaceholderMention.indexOf("/");
  if (slashIndex <= 0) {
    return withoutPlaceholderMention;
  }

  const prefix = withoutPlaceholderMention.slice(0, slashIndex).trim();
  if (prefix.startsWith("@")) {
    return withoutPlaceholderMention.slice(slashIndex).trimStart();
  }

  return withoutPlaceholderMention;
}

function resolveDirectoryScope(
  currentProject: ProjectInfo | undefined,
  currentSession: SessionInfo | undefined,
): string {
  if (currentProject?.worktree) {
    return currentProject.worktree;
  }

  if (currentSession?.directory) {
    return currentSession.directory;
  }

  return process.cwd();
}

export interface OpenCodeSessionClient {
  create(
    parameters?: Record<string, unknown>,
  ): Promise<{ data?: Record<string, unknown> }>;
  list(parameters?: {
    directory?: string;
    limit?: number;
    roots?: boolean;
  }): Promise<{ data?: unknown; error?: unknown }>;
  status(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
  abort(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
}

export interface OpenCodeProjectClient {
  list(parameters?: {
    directory?: string;
    workspace?: string;
  }): Promise<{ data?: unknown; error?: unknown }>;
}

export interface OpenCodeControlClient extends OpenCodeControlCatalogClient {
  session: OpenCodeSessionClient;
  project: OpenCodeProjectClient;
}

export type ControlRouterSettingsStore = Pick<
  SettingsManager,
  | "getCurrentProject"
  | "setCurrentProject"
  | "getCurrentSession"
  | "setCurrentSession"
  | "getCurrentAgent"
  | "setCurrentAgent"
  | "getCurrentModel"
  | "setCurrentModel"
>;

export type ControlRouterSessionStore = Pick<
  SessionManager,
  "getCurrentSession" | "setCurrentSession" | "clearSession"
>;

export type ControlRouterRenderer = Pick<
  FeishuRenderer,
  "sendCard" | "sendText"
>;

export type ControlRouterInteractionStore = Pick<
  InteractionManager,
  "clearBusy" | "isBusy"
>;

export interface ControlRouterOptions {
  settingsManager: ControlRouterSettingsStore;
  sessionManager: ControlRouterSessionStore;
  renderer: ControlRouterRenderer;
  openCodeClient: OpenCodeControlClient;
  feishuClient?: FeishuClients["client"];
  catalogAdapter?: ControlCatalogProvider;
  catalogCacheTtlMs?: number;
  catalogModelStatePath?: string;
  messageReader?: MessageReader;
  interactionManager: ControlRouterInteractionStore;
  cardActionsEnabled?: boolean;
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
  private readonly openCodeProject: OpenCodeProjectClient;
  private readonly interactionManager: ControlRouterInteractionStore;
  private readonly cardActionsEnabled: boolean;
  private readonly logger: Logger;
  private readonly catalogAdapter: ControlCatalogProvider;
  private readonly messageReader: MessageReader | null;

  constructor(options: ControlRouterOptions) {
    this.settings = options.settingsManager;
    this.sessionManager = options.sessionManager;
    this.renderer = options.renderer;
    this.openCodeSession = options.openCodeClient.session;
    this.openCodeProject = options.openCodeClient.project;
    this.interactionManager = options.interactionManager;
    this.cardActionsEnabled = options.cardActionsEnabled ?? true;
    this.logger = options.logger ?? createNoopLogger();
    this.messageReader =
      options.messageReader ??
      (options.feishuClient
        ? new MessageReader({
            client: options.feishuClient,
            logger: this.logger,
          })
        : null);
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
    const normalizedInput = normalizeCommandInput(text);
    if (!normalizedInput.startsWith("/")) {
      return null;
    }

    const whitespaceIndex = normalizedInput.search(/\s/);
    const commandRaw =
      whitespaceIndex === -1
        ? normalizedInput
        : normalizedInput.slice(0, whitespaceIndex);
    const commandPart = commandRaw.toLowerCase();
    const args =
      whitespaceIndex === -1
        ? undefined
        : normalizedInput.slice(whitespaceIndex).trim();

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
      case "/projects":
        return this.handleProjects(receiveId, args);
      case "/sessions":
        return this.handleSessions(receiveId);
      case "/session":
        return this.handleSession(receiveId, args);
      case "/history":
        return this.handleHistory(receiveId, args);
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
      case "select_project": {
        const projectId =
          typeof value?.projectId === "string" ? value.projectId : null;
        if (projectId) {
          const receiveId =
            typeof event.open_chat_id === "string" ? event.open_chat_id : "";
          await this.handleProjects(receiveId, projectId);
        }
        break;
      }
      case "control_cancel":
        this.interactionManager.clearBusy();
        break;
      case "confirm_write": {
        const operationId =
          typeof value?.operationId === "string" ? value.operationId : null;
        if (operationId === "create_new_session") {
          const receiveId =
            typeof event.open_chat_id === "string" ? event.open_chat_id : "";
          try {
            const result = await this.executeCreateSession();
            if (receiveId && result.message) {
              await this.renderer.sendText(receiveId, result.message);
            }
          } catch (error) {
            this.logger.error(
              "[ControlRouter] Failed to create session from card action",
              error,
            );
            if (receiveId) {
              try {
                await this.renderer.sendText(
                  receiveId,
                  "Failed to create session. Please try again.",
                );
              } catch (sendError) {
                this.logger.error(
                  "[ControlRouter] Failed to send session creation error message",
                  sendError,
                );
              }
            }
          }
        }
        break;
      }
      case "reject_write": {
        const receiveId =
          typeof event.open_chat_id === "string" ? event.open_chat_id : "";
        if (receiveId) {
          await this.renderer.sendText(receiveId, "Operation cancelled");
        }
        break;
      }
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

  private async handleNew(receiveId: string): Promise<ControlCommandResult> {
    if (!this.cardActionsEnabled) {
      this.logger.warn(
        "[ControlRouter] Card callbacks are disabled; /new will create a session immediately",
      );
      const result = await this.executeCreateSession();
      if (result.message) {
        await this.renderer.sendText(receiveId, result.message);
      }
      return result;
    }

    const card = buildConfirmCard({
      operationDescription:
        "This will create a new OpenCode session and reset the current session. Continue?",
      pendingOperationId: "create_new_session",
    });
    try {
      const messageId = await this.renderer.sendCard(receiveId, card);
      if (!messageId) {
        this.logger.error(
          "[ControlRouter] Failed to send /new confirmation card: empty message id",
        );
        await this.renderer.sendText(
          receiveId,
          "Failed to send confirmation card. Please try again.",
        );
        return {
          success: false,
          message: "Failed to send confirmation card",
        };
      }

      return {
        success: true,
        cardMessageId: messageId,
        message: "Confirmation required",
      };
    } catch (error) {
      this.logger.error(
        "[ControlRouter] Failed to send /new confirmation card",
        error,
      );
      try {
        await this.renderer.sendText(
          receiveId,
          "Failed to send confirmation card. Please try again.",
        );
      } catch (sendError) {
        this.logger.error(
          "[ControlRouter] Failed to send /new fallback error message",
          sendError,
        );
      }
      return {
        success: false,
        message: "Failed to send confirmation card",
      };
    }
  }

  private async executeCreateSession(): Promise<ControlCommandResult> {
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
      const directory = resolveDirectoryScope(
        this.settings.getCurrentProject(),
        this.settings.getCurrentSession(),
      );
      const result = await this.openCodeSession.list({
        directory,
        roots: true,
      });
      if (result.error) {
        throw result.error;
      }
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

  private parseProjects(data: unknown): ProjectSummary[] {
    if (!Array.isArray(data)) {
      return [];
    }

    const projects: ProjectSummary[] = [];
    for (const candidate of data) {
      if (!isRecord(candidate)) {
        continue;
      }

      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      const worktree =
        typeof candidate.worktree === "string" ? candidate.worktree.trim() : "";
      const name =
        typeof candidate.name === "string" ? candidate.name.trim() : undefined;

      if (!id || !worktree) {
        continue;
      }

      projects.push({
        id,
        worktree,
        name: name && name.length > 0 ? name : undefined,
      });
    }

    return projects;
  }

  private async listProjects(): Promise<ProjectSummary[]> {
    const result = await this.openCodeProject.list();
    if (result.error) {
      throw result.error;
    }

    return this.parseProjects(result.data);
  }

  private async selectProject(
    projectId: string,
  ): Promise<ProjectSummary | null> {
    const projects = await this.listProjects();
    const selectedProject = projects.find(
      (project) => project.id === projectId,
    );
    if (!selectedProject) {
      return null;
    }

    this.settings.setCurrentProject({
      id: selectedProject.id,
      worktree: selectedProject.worktree,
      name: selectedProject.name,
    });
    this.sessionManager.clearSession();

    return selectedProject;
  }

  private async handleProjects(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    const requestedProjectId = args?.trim();
    if (requestedProjectId) {
      try {
        const selectedProject = await this.selectProject(requestedProjectId);
        if (!selectedProject) {
          const message = `Unknown project: ${requestedProjectId}`;
          if (receiveId) {
            await this.renderer.sendText(receiveId, message);
          }
          return { success: false, message };
        }

        const projectLabel = selectedProject.name ?? selectedProject.worktree;
        const message = `Project switched to: ${projectLabel}`;
        this.logger.info(
          `[ControlRouter] Switched to project: ${selectedProject.id}`,
        );
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }

        return { success: true, message };
      } catch (error) {
        this.logger.error("[ControlRouter] Failed to select project", error);
        const message = "Failed to switch project";
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }
        return { success: false, message };
      }
    }

    try {
      const projects = await this.listProjects();
      if (projects.length === 0) {
        const message = "No projects available.";
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }
        return { success: true, message };
      }

      if (!this.cardActionsEnabled) {
        const listedProjects = projects.slice(0, 20);
        const lines = listedProjects.map((project) => {
          const label = project.name ?? project.worktree;
          return `- ${project.id} — ${label}`;
        });
        const hiddenCount = Math.max(
          0,
          projects.length - listedProjects.length,
        );
        const hiddenNotice =
          hiddenCount > 0 ? `\n…and ${hiddenCount} more projects.` : "";
        const message = `Projects:\n${lines.join("\n")}${hiddenNotice}\n\nUse /projects <id> to select a project.`;
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }
        return { success: true, message: `Listed ${projects.length} projects` };
      }

      const currentProject = this.settings.getCurrentProject();
      const card = buildProjectPickerCard(projects, currentProject?.id);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to list projects", error);
      const message = "Failed to list projects";
      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }
      return { success: false, message };
    }
  }

  private parseHistoryCount(args?: string): number {
    if (!args) {
      return DEFAULT_HISTORY_COUNT;
    }

    const firstToken = args.trim().split(/\s+/, 1)[0];
    const parsedCount = Number.parseInt(firstToken, 10);
    if (!Number.isFinite(parsedCount) || parsedCount <= 0) {
      return DEFAULT_HISTORY_COUNT;
    }

    return parsedCount;
  }

  private async handleHistory(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    if (!this.messageReader) {
      await this.renderer.sendText(receiveId, "Message history is unavailable");
      return { success: false, message: "Message history is unavailable" };
    }

    try {
      const count = this.parseHistoryCount(args);
      const messages = await this.messageReader.getChatMessages({
        chatId: receiveId,
        count,
      });

      if (messages.length === 0) {
        await this.renderer.sendText(receiveId, "No recent messages found");
        return { success: true, message: "No recent messages found" };
      }

      const card = buildHistoryCard(messages);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to read chat history", error);
      await this.renderer.sendText(receiveId, "Failed to read recent messages");
      return { success: false, message: "Failed to read recent messages" };
    }
  }

  private async handleModel(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    if (!args) {
      // Show model picker card
      const models = await this.catalogAdapter.getAvailableModels();
      if (models.length === 0) {
        this.logger.warn(
          "[ControlRouter] Model catalog is empty while handling /model",
        );
      }
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
