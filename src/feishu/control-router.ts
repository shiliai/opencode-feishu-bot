import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_CONTROL_CATALOG_CACHE_TTL_MS } from "../config.js";
import type { FeishuRenderer } from "../feishu/renderer.js";
import type { InteractionManager } from "../interaction/manager.js";
import { getModelContextLimit } from "../model/context-limit.js";
import type { SessionManager } from "../session/manager.js";
import type {
  ModelInfo,
  ProjectInfo,
  SessionInfo,
  SettingsManager,
} from "../settings/manager.js";
import type { Logger } from "../utils/logger.js";
import { APP_VERSION } from "../version.js";
import { buildConfirmCard } from "./cards.js";
import type { FeishuClients } from "./client.js";
import type {
  ProjectPickerEntry,
  ProjectSummary,
  SessionSummary,
} from "./control-cards.js";
import {
  buildAgentPickerCard,
  buildHelpCard,
  buildHistoryCard,
  buildModelListCard,
  buildModelPickerCard,
  buildModelProviderCard,
  buildProjectPickerCard,
  buildSessionListCard,
  buildStatusCard,
  getPathLeaf,
} from "./control-cards.js";
import {
  ControlCatalogAdapter,
  type ControlCatalogProvider,
  type OpenCodeControlCatalogClient,
} from "./control-catalog.js";
import { MessageReader } from "./message-reader.js";
import {
  parseSelectionAction,
  type SelectionAction,
} from "./selection-card/index.js";
import type { StatusStore } from "./status-store.js";
import { scanWorkdirSubdirs, type WorkdirEntry } from "./workdir-scanner.js";
import { InMemoryTaskStore } from "../scheduled-task/store.js";
import { ScheduledTaskRuntime } from "../scheduled-task/runtime.js";

export type ControlCommand =
  | "/help"
  | "/new"
  | "/projects"
  | "/sessions"
  | "/session"
  | "/history"
  | "/model"
  | "/agent"
  | "/task"
  | "/tasklist"
  | "/status"
  | "/version"
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
  "/project",
  "/sessions",
  "/session",
  "/history",
  "/model",
  "/models",
  "/agent",
  "/task",
  "/tasklist",
  "/status",
  "/version",
  "/abort",
]);

const DEFAULT_HISTORY_COUNT = 10;
const STATUS_CONTEXT_HISTORY_LIMIT = 50;

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

function isDirectChildDirectory(
  parentDirectory: string,
  candidateDirectory: string,
): boolean {
  const relativePath = relative(parentDirectory, candidateDirectory);
  if (!relativePath || relativePath === "." || isAbsolute(relativePath)) {
    return false;
  }

  const segments = relativePath
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0);
  return segments.length === 1 && segments[0] !== "..";
}

export interface OpenCodeSessionClient {
  create(
    parameters?: Record<string, unknown>,
  ): Promise<{ data?: Record<string, unknown>; error?: unknown }>;
  get(parameters: {
    sessionID: string;
    directory?: string;
  }): Promise<{ data?: unknown; error?: unknown }>;
  list(parameters?: {
    directory?: string;
    limit?: number;
    roots?: boolean;
  }): Promise<{ data?: unknown; error?: unknown }>;
  status(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
  abort(parameters?: Record<string, unknown>): Promise<{ data?: unknown }>;
  messages(parameters: {
    sessionID: string;
    directory?: string;
    limit?: number;
  }): Promise<{ data?: unknown; error?: unknown }>;
  prompt(parameters: Record<string, unknown>): Promise<unknown>;
}

export interface OpenCodeGlobalClient {
  health(): Promise<{ data?: unknown; error?: unknown }>;
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
  global: OpenCodeGlobalClient;
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
  statusStore?: StatusStore;
  cardActionsEnabled?: boolean;
  workdir?: string | null;
  logger?: Logger;
}

function createNoopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getMessageContextUsed(message: unknown): number | null {
  if (!isRecord(message) || !isRecord(message.info)) {
    return null;
  }

  const info = message.info;
  if (getTrimmedString(info.role) !== "assistant" || info.summary === true) {
    return null;
  }

  const tokens = isRecord(info.tokens) ? info.tokens : null;
  if (!tokens) {
    return null;
  }

  const input = getNumber(tokens.input) ?? 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : null;
  const cacheRead = getNumber(cache?.read) ?? 0;
  return input + cacheRead;
}

type CardActionToastType = "info" | "success" | "warning" | "error";

export interface CardActionResponse {
  toast?: {
    type: CardActionToastType;
    content: string;
  };
}

function getCardActionPayload(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(event.event) ? event.event : event;
}

function getCardActionValue(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const payload = getCardActionPayload(event);
  const actionRecord = isRecord(payload.action) ? payload.action : null;
  return actionRecord && isRecord(actionRecord.value)
    ? actionRecord.value
    : null;
}

function getCardActionReceiveId(event: Record<string, unknown>): string {
  const payload = getCardActionPayload(event);
  const context = isRecord(payload.context) ? payload.context : null;

  return typeof payload.open_chat_id === "string"
    ? payload.open_chat_id
    : typeof context?.open_chat_id === "string"
      ? context.open_chat_id
      : "";
}

function buildCardActionToast(
  content: string | undefined,
  type: CardActionToastType,
): CardActionResponse {
  if (!content) {
    return {};
  }

  return {
    toast: {
      type,
      content,
    },
  };
}

export class ControlRouter {
  private readonly settings: ControlRouterSettingsStore;
  private readonly sessionManager: ControlRouterSessionStore;
  private readonly renderer: ControlRouterRenderer;
  private readonly openCodeSession: OpenCodeSessionClient;
  private readonly openCodeProject: OpenCodeProjectClient;
  private readonly openCodeGlobal: OpenCodeGlobalClient;
  private readonly interactionManager: ControlRouterInteractionStore;
  private readonly statusStore: StatusStore | null;
  private readonly cardActionsEnabled: boolean;
  private readonly workdir: string | null;
  private readonly logger: Logger;
  private readonly catalogAdapter: ControlCatalogProvider;
  private readonly messageReader: MessageReader | null;

  constructor(options: ControlRouterOptions) {
    this.settings = options.settingsManager;
    this.sessionManager = options.sessionManager;
    this.renderer = options.renderer;
    this.openCodeSession = options.openCodeClient.session;
    this.openCodeProject = options.openCodeClient.project;
    this.openCodeGlobal = options.openCodeClient.global;
    this.interactionManager = options.interactionManager;
    this.statusStore = options.statusStore ?? null;
    this.cardActionsEnabled = options.cardActionsEnabled ?? true;
    this.workdir = options.workdir ?? null;
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
    const normalizedCommandPart =
      commandPart === "/models"
        ? "/model"
        : commandPart === "/project"
          ? "/projects"
          : commandPart;
    const args =
      whitespaceIndex === -1
        ? undefined
        : normalizedInput.slice(whitespaceIndex).trim();

    if (!SUPPORTED_COMMANDS.has(commandPart)) {
      return null;
    }

    return {
      command: normalizedCommandPart as ControlCommand,
      args: args || undefined,
    };
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
      case "/task":
        return this.handleTask(receiveId, args);
      case "/tasklist":
        return this.handleTasklist(receiveId);
      case "/status":
        return this.handleStatus(receiveId);
      case "/version":
        return this.handleVersion(receiveId);
      case "/abort":
        return this.handleAbort(receiveId);
    }
  }

  async handleCardAction(
    event: Record<string, unknown>,
  ): Promise<CardActionResponse> {
    const value = getCardActionValue(event);
    if (!value) {
      return {};
    }

    const selectionAction = parseSelectionAction(value);
    const action = typeof value?.action === "string" ? value.action : null;

    if (!selectionAction && !action) {
      return {};
    }

    try {
      if (selectionAction) {
        return await this.handleSelectionAction(selectionAction, event);
      }

      switch (action) {
        case "select_session": {
          const sessionId =
            typeof value?.sessionId === "string" ? value.sessionId : null;
          if (!sessionId) {
            return {};
          }

          const result = await this.handleSession(
            getCardActionReceiveId(event),
            sessionId,
          );
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }
        case "select_model": {
          const modelName =
            typeof value?.modelName === "string" ? value.modelName : null;
          if (!modelName) {
            return {};
          }

          const result = await this.handleModel(
            getCardActionReceiveId(event),
            modelName,
          );
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }
        case "select_agent": {
          const agentName =
            typeof value?.agentName === "string" ? value.agentName : null;
          if (!agentName) {
            return {};
          }

          const result = await this.handleAgent(
            getCardActionReceiveId(event),
            agentName,
          );
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }
        case "select_project": {
          const projectId =
            typeof value?.projectId === "string" ? value.projectId : null;
          if (!projectId) {
            return {};
          }

          const result = await this.handleProjects(
            getCardActionReceiveId(event),
            projectId,
          );
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }
        case "discover_project": {
          const directory = getTrimmedString(value?.directory);
          if (!directory) {
            return {};
          }

          const result = await this.discoverProject(
            getCardActionReceiveId(event),
            directory,
          );
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }
        case "control_cancel":
          this.interactionManager.clearBusy();
          return buildCardActionToast("Operation cancelled", "info");
        case "confirm_write": {
          const operationId =
            typeof value?.operationId === "string" ? value.operationId : null;
          if (operationId !== "create_new_session") {
            return {};
          }

          const receiveId = getCardActionReceiveId(event);
          try {
            const result = await this.executeCreateSession();
            if (receiveId && result.message) {
              await this.renderer.sendText(receiveId, result.message);
            }

            return buildCardActionToast(
              result.message,
              result.success ? "success" : "error",
            );
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

            return buildCardActionToast(
              "Failed to create session. Please try again.",
              "error",
            );
          }
        }
        case "reject_write": {
          const receiveId = getCardActionReceiveId(event);
          if (receiveId) {
            await this.renderer.sendText(receiveId, "Operation cancelled");
          }
          return buildCardActionToast("Operation cancelled", "info");
        }
        default:
          return {};
      }
    } catch (error) {
      this.logger.error(
        "[ControlRouter] Failed to handle control card action",
        {
          action,
          error,
        },
      );
      return buildCardActionToast(
        "Failed to apply selection. Please try again.",
        "error",
      );
    }
  }

  private async handleSelectionAction(
    action: SelectionAction,
    event: Record<string, unknown>,
  ): Promise<CardActionResponse> {
    const receiveId = getCardActionReceiveId(event);

    switch (action.action) {
      case "selection_pick": {
        switch (action.command) {
          case "model": {
            const level =
              typeof action.context?.level === "string"
                ? action.context.level
                : "provider";

            if (level === "provider") {
              const result = await this.handleModelPickerPage(receiveId, 0, {
                level: "model",
                provider: action.value,
              });
              return buildCardActionToast(
                result.message,
                result.success ? "success" : "error",
              );
            }

            const fullModelName =
              level === "flat"
                ? action.value
                : (() => {
                    const provider =
                      typeof action.context?.provider === "string"
                        ? action.context.provider
                        : "";
                    return provider
                      ? `${provider}/${action.value}`
                      : action.value;
                  })();

            const result = await this.handleModel(receiveId, fullModelName);
            return buildCardActionToast(
              result.message,
              result.success ? "success" : "error",
            );
          }
          case "session": {
            const result = await this.handleSession(receiveId, action.value);
            return buildCardActionToast(
              result.message,
              result.success ? "success" : "error",
            );
          }
          case "project": {
            const result = isAbsolute(action.value)
              ? await this.discoverProject(receiveId, action.value)
              : await this.handleProjects(receiveId, action.value);
            return buildCardActionToast(
              result.message,
              result.success ? "success" : "error",
            );
          }
          case "agent": {
            const result = await this.handleAgent(receiveId, action.value);
            return buildCardActionToast(
              result.message,
              result.success ? "success" : "error",
            );
          }
          default:
            return {};
        }
      }
      case "selection_cancel":
        return buildCardActionToast("Cancelled", "info");
      case "selection_back":
      case "selection_page": {
        const page = action.action === "selection_page" ? action.page : 0;

        if (action.command === "model") {
          const result = await this.handleModelPickerPage(
            receiveId,
            page,
            action.action === "selection_back"
              ? { level: "provider" }
              : action.context,
          );
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }

        if (action.command === "session") {
          const result = await this.handleSessionPickerPage(receiveId, page);
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }

        if (action.command === "project") {
          const result = await this.handleProjectPickerPage(receiveId, page);
          return buildCardActionToast(
            result.message,
            result.success ? "success" : "error",
          );
        }

        return {};
      }
    }
  }

  private async handleSessionPickerPage(
    receiveId: string,
    page: number,
  ): Promise<ControlCommandResult> {
    if (!receiveId) {
      return { success: false, message: "Unable to reopen session picker" };
    }

    const sessions = await this.listSessionSummaries();
    const card = buildSessionListCard(sessions, page);
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async sendSessionPreview(
    receiveId: string,
    sessionId: string,
    directory: string,
  ): Promise<void> {
    const { loadSessionPreview, formatSessionPreview } =
      await import("../session/session-history.js");
    const previewMessages = await loadSessionPreview(
      this.openCodeSession,
      sessionId,
      directory,
      6,
      this.logger,
    );
    if (previewMessages.length === 0) {
      return;
    }

    const previewContent = formatSessionPreview(previewMessages);
    const card: import("@larksuiteoapi/node-sdk").InteractiveCard = {
      header: {
        title: { tag: "plain_text", content: "📋 Session Preview" },
        template: "blue",
      },
      elements: [{ tag: "markdown", content: previewContent }],
    };
    await this.renderer.sendCard(receiveId, card);
  }

  private getCurrentProjectPickerId(
    projectEntries: ProjectPickerEntry[],
  ): string | undefined {
    const currentProject = this.settings.getCurrentProject();
    if (!currentProject) {
      return undefined;
    }

    return (
      projectEntries.find(
        (project) =>
          project.id &&
          resolve(project.worktree) === resolve(currentProject.worktree),
      )?.id ?? currentProject.id
    );
  }

  private async handleProjectPickerPage(
    receiveId: string,
    page: number,
  ): Promise<ControlCommandResult> {
    if (!receiveId) {
      return { success: false, message: "Unable to reopen project picker" };
    }

    const projectEntries = await this.listProjectPickerEntries();
    const card = buildProjectPickerCard(
      projectEntries,
      this.getCurrentProjectPickerId(projectEntries),
      page,
    );
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async handleModelPickerPage(
    receiveId: string,
    page: number,
    context?: Record<string, unknown>,
  ): Promise<ControlCommandResult> {
    if (!receiveId) {
      return { success: false, message: "Unable to reopen model picker" };
    }

    const level =
      typeof context?.level === "string" ? context.level : "provider";
    const models = await this.catalogAdapter.getAvailableModels();

    if (level === "provider") {
      const providers = this.groupModelsByProvider(models);
      const card = buildModelProviderCard(providers, page);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    }

    if (level === "flat") {
      const card = buildModelPickerCard(models, page);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    }

    const providerName =
      typeof context?.provider === "string" ? context.provider : "";
    if (!providerName) {
      const providers = this.groupModelsByProvider(models);
      const card = buildModelProviderCard(providers, page);
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    }

    const card = buildModelListCard(
      providerName,
      this.getProviderModels(models, providerName),
      page,
    );
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async listSessionSummaries(): Promise<SessionSummary[]> {
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
    const summaries: SessionSummary[] = [];

    for (const candidate of sessions) {
      if (!isRecord(candidate)) {
        continue;
      }

      const id = getTrimmedString(candidate.id);
      if (!id) {
        continue;
      }

      summaries.push({
        ...candidate,
        id,
        title: getTrimmedString(candidate.title) ?? undefined,
        createdAt: getTrimmedString(candidate.createdAt) ?? undefined,
        messageCount: getNumber(candidate.messageCount) ?? undefined,
      });
    }

    return summaries;
  }

  private async handleHelp(receiveId: string): Promise<ControlCommandResult> {
    const card = buildHelpCard();
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async handleNew(receiveId: string): Promise<ControlCommandResult> {
    if (this.interactionManager.isBusy()) {
      const message =
        "A session is currently active. Use /abort first or wait for it to finish.";
      await this.renderer.sendText(receiveId, message);
      return { success: false, message };
    }

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
      const directory = resolveDirectoryScope(
        this.settings.getCurrentProject(),
        this.sessionManager.getCurrentSession() ?? undefined,
      );
      const result = await this.openCodeSession.create({ directory });
      if (result.error) {
        throw result.error;
      }

      const sessionInfo = this.parseSessionInfo(result.data, directory);
      if (!sessionInfo) {
        return { success: false, message: "Failed to create session" };
      }

      this.sessionManager.setCurrentSession(sessionInfo);
      this.logger.info(
        `[ControlRouter] Created new session: ${sessionInfo.id}`,
      );

      const message =
        sessionInfo.title !== sessionInfo.id
          ? `New session selected: ${sessionInfo.title} (${sessionInfo.id})`
          : `New session selected: ${sessionInfo.id}`;

      return {
        success: true,
        message,
      };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to create session", error);
      return { success: false, message: "Failed to create session" };
    }
  }

  private async handleSessions(
    receiveId: string,
  ): Promise<ControlCommandResult> {
    try {
      const summaries = await this.listSessionSummaries();
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
    try {
      const directory = resolveDirectoryScope(
        this.settings.getCurrentProject(),
        this.sessionManager.getCurrentSession() ?? undefined,
      );
      const result = await this.openCodeSession.get({
        sessionID: sessionId,
        directory,
      });
      if (result.error) {
        throw result.error;
      }

      const sessionInfo = this.parseSessionInfo(result.data, directory);
      if (!sessionInfo) {
        const message = `Unknown session: ${sessionId}`;
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }
        return { success: false, message };
      }

      this.sessionManager.setCurrentSession(sessionInfo);
      this.logger.info(
        `[ControlRouter] Switched to session: ${sessionInfo.id}`,
      );

      const { loadContextFromHistory } =
        await import("../session/session-history.js");
      const historyContext = await loadContextFromHistory(
        this.openCodeSession,
        sessionId,
        directory,
        this.logger,
      );

      const titlePart =
        sessionInfo.title !== sessionInfo.id
          ? `${sessionInfo.title} (${sessionInfo.id})`
          : sessionInfo.id;
      const contextParts: string[] = [
        `📝 Messages: ${historyContext.messageCount}`,
      ];
      if (historyContext.maxTokensUsed > 0) {
        const tk =
          historyContext.maxTokensUsed >= 1000
            ? `${(historyContext.maxTokensUsed / 1000).toFixed(1)}k`
            : `${historyContext.maxTokensUsed}`;
        contextParts.push(`📊 Context: ${tk} tokens`);
      }
      if (historyContext.totalCost > 0) {
        contextParts.push(`💰 Cost: $${historyContext.totalCost.toFixed(4)}`);
      }
      const message = `Session selected: ${titlePart}\n${contextParts.join(" · ")}`;

      this.sendSessionPreview(receiveId, sessionId, directory).catch(
        (err: unknown) => {
          this.logger.warn(
            "[ControlRouter] Failed to send session preview",
            err,
          );
        },
      );

      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }
      return { success: true, message };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to select session", error);
      const message = "Failed to switch session";
      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }
      return { success: false, message };
    }
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

  private mergeProjectEntries(
    projects: ProjectSummary[],
    workdirEntries: WorkdirEntry[],
  ): ProjectPickerEntry[] {
    const entries: ProjectPickerEntry[] = [];
    const matchedProjectIds = new Set<string>();
    const projectsByWorktree = new Map<string, ProjectSummary>();

    for (const project of projects) {
      projectsByWorktree.set(resolve(project.worktree), project);
    }

    for (const workdirEntry of workdirEntries) {
      const matchedProject = projectsByWorktree.get(
        resolve(workdirEntry.absolutePath),
      );
      if (matchedProject) {
        entries.push(matchedProject);
        matchedProjectIds.add(matchedProject.id);
        continue;
      }

      entries.push({
        worktree: workdirEntry.absolutePath,
        name: workdirEntry.name,
        isNew: true,
      });
    }

    for (const project of projects) {
      if (matchedProjectIds.has(project.id)) {
        continue;
      }

      entries.push(project);
    }

    return entries;
  }

  private async listProjectPickerEntries(): Promise<ProjectPickerEntry[]> {
    const projects = await this.listProjects();
    if (!this.workdir) {
      return projects;
    }

    const workdirEntries = await scanWorkdirSubdirs(this.workdir, this.logger);
    return this.mergeProjectEntries(projects, workdirEntries);
  }

  private validateDiscoverProjectDirectory(
    directory: string,
  ): { valid: true; directory: string } | { valid: false; message: string } {
    if (!this.workdir) {
      return {
        valid: false,
        message:
          "Project discovery is unavailable because OPENCODE_WORKDIR is not configured.",
      };
    }

    if (!isAbsolute(directory)) {
      return {
        valid: false,
        message: "Project discovery requires an absolute path.",
      };
    }

    const normalizedWorkdir = resolve(this.workdir);
    const normalizedDirectory = resolve(directory);
    if (!isDirectChildDirectory(normalizedWorkdir, normalizedDirectory)) {
      return {
        valid: false,
        message: `Project discovery is limited to immediate subdirectories of ${normalizedWorkdir}.`,
      };
    }

    return { valid: true, directory: normalizedDirectory };
  }

  private async discoverProject(
    receiveId: string,
    directory: string,
  ): Promise<ControlCommandResult> {
    const validation = this.validateDiscoverProjectDirectory(directory);
    if (!validation.valid) {
      this.logger.warn(
        `[ControlRouter] Rejected project discovery request for directory: ${directory}`,
      );
      if (receiveId) {
        await this.renderer.sendText(receiveId, validation.message);
      }
      return { success: false, message: validation.message };
    }

    const normalizedDirectory = validation.directory;
    try {
      const result = await this.openCodeSession.create({
        directory: normalizedDirectory,
      });
      if (result.error) {
        throw result.error;
      }

      const sessionInfo = this.parseSessionInfo(
        result.data,
        normalizedDirectory,
      );
      const discoveredDirectory = sessionInfo?.directory ?? normalizedDirectory;
      const projectName = getPathLeaf(discoveredDirectory);
      this.settings.setCurrentProject({
        id: "discovered",
        worktree: discoveredDirectory,
        name: projectName,
      });
      this.sessionManager.clearSession();
      this.logger.info(
        `[ControlRouter] Discovered project via session.create: ${discoveredDirectory}`,
      );

      const message =
        `Project discovered: ${projectName}\n\n` +
        "Active session cleared. Use /sessions or /new for this project.";
      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }

      return { success: true, message };
    } catch (error) {
      this.logger.error("[ControlRouter] Failed to discover project", error);
      const message = "Failed to discover project";
      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }
      return { success: false, message };
    }
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
        const message =
          `Project selected: ${projectLabel}\n\n` +
          "Active session cleared. Use /sessions or /new for this project.";
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
      const projectEntries = await this.listProjectPickerEntries();
      if (projectEntries.length === 0) {
        const message = "No projects available.";
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }
        return { success: true, message };
      }

      if (!this.cardActionsEnabled) {
        const listedProjects = projectEntries.slice(0, 20);
        const lines = listedProjects.map((project) => {
          if (project.isNew || !project.id) {
            return `- [new] ${project.name ?? getPathLeaf(project.worktree)} — ${project.worktree}`;
          }

          const label = project.name ?? project.worktree;
          return `- ${project.id} — ${label}`;
        });
        const hiddenCount = Math.max(
          0,
          projectEntries.length - listedProjects.length,
        );
        const hiddenNotice =
          hiddenCount > 0 ? `\n…and ${hiddenCount} more projects.` : "";
        const selectionHelp = projectEntries.some((project) => project.isNew)
          ? "Use /projects <id> to select a known project. New workdir directories require the interactive picker to discover."
          : "Use /projects <id> to select a project.";
        const message = `Projects:\n${lines.join("\n")}${hiddenNotice}\n\n${selectionHelp}`;
        if (receiveId) {
          await this.renderer.sendText(receiveId, message);
        }
        return {
          success: true,
          message: `Listed ${projectEntries.length} projects`,
        };
      }

      const card = buildProjectPickerCard(
        projectEntries,
        this.getCurrentProjectPickerId(projectEntries),
      );
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
      const models = await this.catalogAdapter.getAvailableModels();
      if (models.length === 0) {
        this.logger.warn(
          "[ControlRouter] Model catalog is empty while handling /model",
        );
      }
      const card = buildModelProviderCard(this.groupModelsByProvider(models));
      const messageId = await this.renderer.sendCard(receiveId, card);
      return { success: true, cardMessageId: messageId ?? undefined };
    }

    const modelName = args.trim();
    const selectedModel = await this.resolveModelSelection(modelName);
    if (!selectedModel) {
      const message =
        "Unknown model. Use provider/model (for example openai/gpt-4o) or a unique bare model name from the catalog.";
      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }
      return {
        success: false,
        message,
      };
    }

    const selectedModelName = `${selectedModel.providerID}/${selectedModel.modelID}`;
    this.settings.setCurrentModel(selectedModel);
    this.logger.info(`[ControlRouter] Switched to model: ${selectedModelName}`);
    const message = `Model selected: ${selectedModelName}`;
    if (receiveId) {
      await this.renderer.sendText(receiveId, message);
    }
    return {
      success: true,
      message,
    };
  }

  private getProviderModels(models: string[], providerName: string): string[] {
    if (!providerName) {
      return [];
    }

    return models
      .filter((model) => model.startsWith(`${providerName}/`))
      .map((model) => model.slice(providerName.length + 1));
  }

  private groupModelsByProvider(
    models: string[],
  ): Array<{ name: string; modelCount: number }> {
    const providerMap = new Map<string, number>();

    for (const model of models) {
      const separator = model.indexOf("/");
      const provider = separator > 0 ? model.slice(0, separator) : "other";
      providerMap.set(provider, (providerMap.get(provider) ?? 0) + 1);
    }

    return Array.from(providerMap.entries())
      .map(([name, modelCount]) => ({ name, modelCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async resolveAgentSelection(
    agentName: string,
  ): Promise<string | null> {
    const requestedAgent = agentName.trim();
    if (!requestedAgent) {
      return null;
    }

    const availableAgents = await this.catalogAdapter.getAvailableAgents();
    const exactMatch = availableAgents.find(
      (candidate) => candidate === requestedAgent,
    );
    if (exactMatch) {
      return exactMatch;
    }

    const caseInsensitiveMatches = availableAgents.filter(
      (candidate) => candidate.toLowerCase() === requestedAgent.toLowerCase(),
    );
    return caseInsensitiveMatches.length === 1
      ? caseInsensitiveMatches[0]
      : null;
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

    const selectedAgent = await this.resolveAgentSelection(args);
    if (!selectedAgent) {
      const message =
        "Unknown agent. Use /agent to pick an available agent from the current catalog.";
      if (receiveId) {
        await this.renderer.sendText(receiveId, message);
      }
      return {
        success: false,
        message,
      };
    }

    this.settings.setCurrentAgent(selectedAgent);
    this.logger.info(`[ControlRouter] Switched to agent: ${selectedAgent}`);
    const message = `Agent selected: ${selectedAgent}`;
    if (receiveId) {
      await this.renderer.sendText(receiveId, message);
    }
    return { success: true, message };
  }

  private async handleStatus(receiveId: string): Promise<ControlCommandResult> {
    const currentProject = this.settings.getCurrentProject();
    const currentSession = this.sessionManager.getCurrentSession() ?? undefined;
    const fallbackModel = this.settings.getCurrentModel();
    const fallbackAgent = this.settings.getCurrentAgent();
    const directory = resolveDirectoryScope(currentProject, currentSession);
    const turnState = currentSession
      ? this.statusStore?.get(currentSession.id)
      : undefined;

    let healthDisplay: string | null = null;
    let versionDisplay: string | null = null;
    try {
      const healthResponse = await this.openCodeGlobal.health();
      if (healthResponse.error) {
        throw healthResponse.error;
      }

      const data = isRecord(healthResponse.data) ? healthResponse.data : null;
      if (data) {
        if (typeof data.healthy === "boolean") {
          healthDisplay = data.healthy ? "healthy" : "unhealthy";
        }
        versionDisplay = getTrimmedString(data.version);
      }
    } catch (error) {
      this.logger.warn(
        "[ControlRouter] Failed to fetch OpenCode health for /status",
        error,
      );
    }

    let latestModelDisplay: string | null = null;
    let latestAgentDisplay: string | null = null;
    let latestProviderID: string | null = null;
    let latestModelID: string | null = null;
    let contextUsed: number | null = null;

    if (currentSession) {
      try {
        const messagesResponse = await this.openCodeSession.messages({
          sessionID: currentSession.id,
          directory,
          limit: STATUS_CONTEXT_HISTORY_LIMIT,
        });
        if (messagesResponse.error) {
          throw messagesResponse.error;
        }

        const messages = Array.isArray(messagesResponse.data)
          ? messagesResponse.data
          : [];
        const latestMessage = messages[0];
        const info =
          isRecord(latestMessage) && isRecord(latestMessage.info)
            ? latestMessage.info
            : null;
        latestProviderID = info ? getTrimmedString(info.providerID) : null;
        latestModelID = info ? getTrimmedString(info.modelID) : null;
        const agentName = info ? getTrimmedString(info.agent) : null;

        if (latestProviderID && latestModelID) {
          latestModelDisplay = `${latestProviderID}/${latestModelID}`;
        }
        if (agentName) {
          latestAgentDisplay = agentName;
        }

        for (const message of messages) {
          const messageContextUsed = getMessageContextUsed(message);
          if (messageContextUsed == null) {
            continue;
          }

          contextUsed =
            contextUsed == null
              ? messageContextUsed
              : Math.max(contextUsed, messageContextUsed);
        }
      } catch (error) {
        this.logger.warn(
          `[ControlRouter] Failed to fetch latest OpenCode session message for /status: session=${currentSession.id}`,
          error,
        );
      }
    }

    if (turnState?.latestTokens) {
      const turnContextUsed =
        turnState.latestTokens.input + turnState.latestTokens.cacheRead;
      contextUsed =
        contextUsed == null
          ? turnContextUsed
          : Math.max(contextUsed, turnContextUsed);
    }

    const modelDisplay = fallbackModel
      ? `${fallbackModel.providerID}/${fallbackModel.modelID}`
      : latestModelDisplay;
    const agentDisplay = fallbackAgent ?? latestAgentDisplay;
    const contextProviderID = fallbackModel?.providerID ?? latestProviderID;
    const contextModelID = fallbackModel?.modelID ?? latestModelID;
    let contextLimit: number | null = null;

    if (contextUsed != null) {
      try {
        contextLimit = await getModelContextLimit(
          contextProviderID,
          contextModelID,
        );
      } catch (error) {
        this.logger.warn(
          `[ControlRouter] Failed to fetch model context limit for /status: provider=${contextProviderID ?? "unknown"} model=${contextModelID ?? "unknown"}`,
          error,
        );
      }
    }

    let state = this.interactionManager.isBusy() ? "busy" : "idle";
    try {
      const statusResponse = await this.openCodeSession.status({ directory });
      const statusMap = isRecord(statusResponse.data)
        ? statusResponse.data
        : null;
      const sessionStatus =
        currentSession && statusMap ? statusMap[currentSession.id] : undefined;
      const statusRecord = isRecord(sessionStatus) ? sessionStatus : null;
      const serverState = statusRecord
        ? getTrimmedString(statusRecord.type)
        : null;
      if (serverState) {
        state = serverState;
      }
    } catch (error) {
      this.logger.warn(
        `[ControlRouter] Failed to fetch OpenCode session status for /status: directory=${directory}`,
        error,
      );
    }

    const projectDisplay =
      currentProject?.name ?? currentProject?.worktree ?? null;

    const card = buildStatusCard({
      health: healthDisplay,
      version: versionDisplay,
      project: projectDisplay,
      directory,
      session: currentSession?.id ?? null,
      model: modelDisplay,
      sessionTitle: currentSession?.title ?? null,
      agent: agentDisplay,
      state,
      contextUsed,
      contextLimit,
    });
    const messageId = await this.renderer.sendCard(receiveId, card);
    return { success: true, cardMessageId: messageId ?? undefined };
  }

  private async handleVersion(
    receiveId: string,
  ): Promise<ControlCommandResult> {
    const messageIds = await this.renderer.sendText(
      receiveId,
      `opencode-feishu-bridge v${APP_VERSION}`,
    );
    return {
      success: true,
      cardMessageId: messageIds[0] ?? undefined,
    };
  }

  private async handleUpdate(receiveId: string): Promise<ControlCommandResult> {
    const { handleUpdateCommand } =
      await import("./handlers/update-handler.js");
    const result = await handleUpdateCommand(this.logger);

    if (receiveId) {
      await this.renderer.sendText(receiveId, result.message);
    }

    return {
      success: result.success,
      message: result.message,
    };
  }

  private taskStore:
    | import("../scheduled-task/store.js").InMemoryTaskStore
    | null = null;
  private taskRuntime:
    | import("../scheduled-task/runtime.js").ScheduledTaskRuntime
    | null = null;

  private ensureTaskInfrastructure(): void {
    if (this.taskStore && this.taskRuntime) {
      return;
    }

    this.taskStore = new InMemoryTaskStore();
    const store = this.taskStore;
    const logger = this.logger;
    const sessionClient = this.openCodeSession;
    this.taskRuntime = new ScheduledTaskRuntime(
      store,
      {
        async executeTask(
          task: import("../scheduled-task/types.js").ScheduledTask,
        ) {
          const { executeTask } = await import("../scheduled-task/executor.js");
          return executeTask({ sessionClient, logger }, task);
        },
        onTaskUpdate(
          taskId: string,
          updates: Partial<import("../scheduled-task/types.js").ScheduledTask>,
        ) {
          store.updateTask(taskId, updates);
        },
      },
      logger,
    );
    this.taskRuntime.start();
  }

  private async handleTask(
    receiveId: string,
    args?: string,
  ): Promise<ControlCommandResult> {
    this.ensureTaskInfrastructure();

    if (!args) {
      const message = [
        "**Scheduled Task — Usage**",
        "",
        "`/task <schedule>, <prompt>`",
        "",
        "**Examples:**",
        "• `/task every 30m, check build status`",
        "• `/task daily at 9:00, run tests and report`",
        "• `/task hourly, review open PRs`",
        "• `/task weekdays 10:00, generate standup summary`",
        "",
        "Use `/tasklist` to view and manage scheduled tasks.",
      ].join("\n");
      await this.renderer.sendText(receiveId, message);
      return { success: false, message };
    }

    const separatorIdx = args.indexOf(",");
    let scheduleText: string;
    let prompt: string;

    if (separatorIdx > 0) {
      scheduleText = args.slice(0, separatorIdx).trim();
      prompt = args.slice(separatorIdx + 1).trim();
    } else {
      const match = args.match(
        /^((?:every|daily|hourly|weekly|weekdays|at)\s+[\d\w\s]+?)[,\s]+(.+)/i,
      );
      if (match) {
        scheduleText = match[1].trim();
        prompt = match[2].trim();
      } else {
        scheduleText = args.trim();
        prompt = args.trim();
      }
    }

    return this.createScheduledTask(receiveId, scheduleText, prompt);
  }

  private async createScheduledTask(
    receiveId: string,
    scheduleText: string,
    prompt: string,
  ): Promise<ControlCommandResult> {
    const { getConfig } = await import("../config.js");
    const TASK_LIMIT = getConfig().scheduledTaskLimit;
    const currentTasks = this.taskStore!.listTasks();
    if (currentTasks.length >= TASK_LIMIT) {
      const message = `Task limit reached (${TASK_LIMIT}). Remove tasks with /tasklist first.`;
      await this.renderer.sendText(receiveId, message);
      return { success: false, message };
    }

    const { parseSchedule } =
      await import("../scheduled-task/schedule-parser.js");
    const { validateCronMinGap } =
      await import("../scheduled-task/next-run.js");

    const parsed = parseSchedule(scheduleText);

    if (
      parsed.kind === "cron" &&
      parsed.cron &&
      !validateCronMinGap(parsed.cron)
    ) {
      const message = "Schedule interval too short. Minimum is 5 minutes.";
      await this.renderer.sendText(receiveId, message);
      return { success: false, message };
    }

    const project = this.settings.getCurrentProject();
    const model = this.settings.getCurrentModel();

    if (!project) {
      const message = "No project selected. Use /projects first.";
      await this.renderer.sendText(receiveId, message);
      return { success: false, message };
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task: import("../scheduled-task/types.js").ScheduledTask = {
      id: taskId,
      projectId: project.id,
      projectWorktree: project.worktree,
      model: model ?? { providerID: "openai", modelID: "gpt-4o" },
      kind: parsed.kind,
      cron: parsed.cron,
      runAt: parsed.runAt,
      scheduleText,
      scheduleSummary: parsed.summary,
      timezone,
      prompt,
      createdAt: new Date().toISOString(),
      nextRunAt: parsed.nextRunAt,
      lastRunAt: null,
      runCount: 0,
      lastStatus: null,
      lastError: null,
    };

    this.taskStore!.addTask(task);
    this.taskRuntime!.scheduleTask(taskId);

    const nextRunStr = parsed.nextRunAt
      ? new Date(parsed.nextRunAt).toLocaleString()
      : "N/A";
    const message = `Task created: ${parsed.summary}\nPrompt: ${prompt}\nNext run: ${nextRunStr}`;
    await this.renderer.sendText(receiveId, message);
    return { success: true, message };
  }

  private async handleTasklist(
    receiveId: string,
  ): Promise<ControlCommandResult> {
    this.ensureTaskInfrastructure();

    const tasks = this.taskStore!.listTasks();

    if (tasks.length === 0) {
      const message = "No scheduled tasks. Use /task to create one.";
      await this.renderer.sendText(receiveId, message);
      return { success: true, message };
    }

    const { formatTaskListItem } = await import("../scheduled-task/display.js");
    const lines = tasks.map((task) => formatTaskListItem(task));
    const content = lines.join("\n\n");

    const card: import("@larksuiteoapi/node-sdk").InteractiveCard = {
      header: {
        title: { tag: "plain_text", content: "📅 Scheduled Tasks" },
        template: "blue",
      },
      elements: [{ tag: "markdown", content }],
    };
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

  private parseSessionInfo(
    data: unknown,
    fallbackDirectory: string,
  ): SessionInfo | null {
    if (!isRecord(data)) {
      return null;
    }

    const id = getTrimmedString(data.id);
    if (!id) {
      return null;
    }

    return {
      id,
      title: getTrimmedString(data.title) ?? id,
      directory: getTrimmedString(data.directory) ?? fallbackDirectory,
    };
  }
}
