import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { logger as defaultLogger, type Logger } from "../utils/logger.js";

export interface ProjectInfo {
  id: string;
  worktree: string;
  name?: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
}

export interface ModelInfo {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface SessionDirectoryCacheInfo {
  version: 1;
  lastSyncedUpdatedAt: number;
  directories: Array<{
    worktree: string;
    lastUpdated: number;
  }>;
}

export interface Settings {
  currentProject?: ProjectInfo;
  currentSession?: SessionInfo;
  currentAgent?: string;
  currentModel?: ModelInfo;
  statusMessageId?: string;
  sessionDirectoryCache?: SessionDirectoryCacheInfo;
}

export interface SettingsFileSystem {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  writeFile: typeof writeFile;
}

export interface SettingsManagerOptions {
  fileSystem?: SettingsFileSystem;
  logger?: Logger;
  settingsFilePath?: string;
}

const DEFAULT_SETTINGS_FILE_PATH = path.join(
  process.cwd(),
  ".data",
  "settings.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneProjectInfo(
  project: ProjectInfo | undefined,
): ProjectInfo | undefined {
  return project ? { ...project } : undefined;
}

function cloneSessionInfo(
  session: SessionInfo | undefined,
): SessionInfo | undefined {
  return session ? { ...session } : undefined;
}

function cloneModelInfo(model: ModelInfo | undefined): ModelInfo | undefined {
  return model ? { ...model } : undefined;
}

function cloneSessionDirectoryCache(
  cache: SessionDirectoryCacheInfo | undefined,
): SessionDirectoryCacheInfo | undefined {
  if (!cache) {
    return undefined;
  }

  return {
    version: 1,
    lastSyncedUpdatedAt: cache.lastSyncedUpdatedAt,
    directories: cache.directories.map((directory) => ({ ...directory })),
  };
}

function cloneSettings(settings: Settings): Settings {
  return {
    currentProject: cloneProjectInfo(settings.currentProject),
    currentSession: cloneSessionInfo(settings.currentSession),
    currentAgent: settings.currentAgent,
    currentModel: cloneModelInfo(settings.currentModel),
    statusMessageId: settings.statusMessageId,
    sessionDirectoryCache: cloneSessionDirectoryCache(
      settings.sessionDirectoryCache,
    ),
  };
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.worktree === "string" &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function isSessionInfo(value: unknown): value is SessionInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.directory === "string"
  );
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    isRecord(value) &&
    typeof value.providerID === "string" &&
    typeof value.modelID === "string" &&
    (value.variant === undefined || typeof value.variant === "string")
  );
}

function isSessionDirectoryCacheInfo(
  value: unknown,
): value is SessionDirectoryCacheInfo {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.lastSyncedUpdatedAt === "number" &&
    Array.isArray(value.directories) &&
    value.directories.every(
      (directory) =>
        isRecord(directory) &&
        typeof directory.worktree === "string" &&
        typeof directory.lastUpdated === "number",
    )
  );
}

function sanitizeSettings(raw: unknown): Settings {
  if (!isRecord(raw)) {
    return {};
  }

  const sanitized: Settings = {};

  if (isProjectInfo(raw.currentProject)) {
    sanitized.currentProject = cloneProjectInfo(raw.currentProject);
  }

  if (isSessionInfo(raw.currentSession)) {
    sanitized.currentSession = cloneSessionInfo(raw.currentSession);
  }

  if (typeof raw.currentAgent === "string") {
    sanitized.currentAgent = raw.currentAgent;
  }

  if (isModelInfo(raw.currentModel)) {
    sanitized.currentModel = cloneModelInfo(raw.currentModel);
  }

  if (typeof raw.statusMessageId === "string") {
    sanitized.statusMessageId = raw.statusMessageId;
  }

  if (isSessionDirectoryCacheInfo(raw.sessionDirectoryCache)) {
    sanitized.sessionDirectoryCache = cloneSessionDirectoryCache(
      raw.sessionDirectoryCache,
    );
  }

  return sanitized;
}

export class SettingsManager {
  private currentSettings: Settings = {};
  private readonly chatSessions = new Map<string, SessionInfo>();
  private readonly chatStatusMessageIds = new Map<string, string>();
  private settingsWriteQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;
  private readonly fileSystem: SettingsFileSystem;
  private readonly logger: Logger;
  private readonly settingsFilePath: string;

  constructor(options: SettingsManagerOptions = {}) {
    this.fileSystem = options.fileSystem ?? {
      mkdir,
      readFile,
      rename,
      writeFile,
    };
    this.logger = options.logger ?? defaultLogger;
    this.settingsFilePath =
      options.settingsFilePath ??
      process.env.OPENCODE_FEISHU_SETTINGS_FILE_PATH ??
      DEFAULT_SETTINGS_FILE_PATH;
  }

  getSettingsFilePath(): string {
    return this.settingsFilePath;
  }

  getSettingsSnapshot(): Settings {
    return cloneSettings(this.currentSettings);
  }

  async waitForPendingWrites(): Promise<void> {
    await this.settingsWriteQueue;
  }

  __resetSettingsForTests(): void {
    this.currentSettings = {};
    this.__resetChatStateForTests();
    this.settingsWriteQueue = Promise.resolve();
    this.writeSequence = 0;
  }

  __resetChatStateForTests(): void {
    this.chatSessions.clear();
    this.chatStatusMessageIds.clear();
  }

  private async readSettingsFile(): Promise<Settings> {
    try {
      const content = await this.fileSystem.readFile(
        this.settingsFilePath,
        "utf-8",
      );
      return sanitizeSettings(JSON.parse(content) as unknown);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {};
      }

      if (error instanceof SyntaxError) {
        this.logger.warn(
          `[SettingsManager] Corrupt settings JSON at ${this.settingsFilePath}, falling back to empty settings`,
          error,
        );
        return {};
      }

      this.logger.error(
        `[SettingsManager] Error reading settings file ${this.settingsFilePath}`,
        error,
      );
      return {};
    }
  }

  private writeSettingsFile(settings: Settings): Promise<void> {
    const snapshot = cloneSettings(settings);
    const writeId = ++this.writeSequence;

    this.settingsWriteQueue = this.settingsWriteQueue
      .catch(() => undefined)
      .then(async () => {
        const directory = path.dirname(this.settingsFilePath);
        const temporaryFilePath = `${this.settingsFilePath}.${writeId}.tmp`;

        try {
          await this.fileSystem.mkdir(directory, { recursive: true });
          await this.fileSystem.writeFile(
            temporaryFilePath,
            JSON.stringify(snapshot, null, 2),
            "utf-8",
          );
          await this.fileSystem.rename(
            temporaryFilePath,
            this.settingsFilePath,
          );
        } catch (error) {
          this.logger.error(
            `[SettingsManager] Error writing settings file ${this.settingsFilePath}`,
            error,
          );
        }
      });

    return this.settingsWriteQueue;
  }

  async loadSettings(): Promise<void> {
    await this.waitForPendingWrites();
    this.currentSettings = await this.readSettingsFile();
  }

  getCurrentProject(): ProjectInfo | undefined {
    return cloneProjectInfo(this.currentSettings.currentProject);
  }

  setCurrentProject(projectInfo: ProjectInfo): void {
    this.currentSettings.currentProject = cloneProjectInfo(projectInfo);
    void this.writeSettingsFile(this.currentSettings);
  }

  clearProject(): void {
    this.currentSettings.currentProject = undefined;
    void this.writeSettingsFile(this.currentSettings);
  }

  getCurrentSession(): SessionInfo | undefined {
    return cloneSessionInfo(this.currentSettings.currentSession);
  }

  setCurrentSession(sessionInfo: SessionInfo): void {
    this.currentSettings.currentSession = cloneSessionInfo(sessionInfo);
    void this.writeSettingsFile(this.currentSettings);
  }

  clearSession(): void {
    this.currentSettings.currentSession = undefined;
    void this.writeSettingsFile(this.currentSettings);
  }

  getChatSession(chatId: string): SessionInfo | undefined {
    return cloneSessionInfo(this.chatSessions.get(chatId));
  }

  setChatSession(chatId: string, session: SessionInfo): void {
    const clonedSession = cloneSessionInfo(session);
    if (clonedSession) {
      this.chatSessions.set(chatId, clonedSession);
    }
  }

  clearChatSession(chatId: string): void {
    this.chatSessions.delete(chatId);
  }

  getCurrentAgent(): string | undefined {
    return this.currentSettings.currentAgent;
  }

  setCurrentAgent(agentName: string): void {
    this.currentSettings.currentAgent = agentName;
    void this.writeSettingsFile(this.currentSettings);
  }

  clearCurrentAgent(): void {
    this.currentSettings.currentAgent = undefined;
    void this.writeSettingsFile(this.currentSettings);
  }

  getCurrentModel(): ModelInfo | undefined {
    return cloneModelInfo(this.currentSettings.currentModel);
  }

  setCurrentModel(modelInfo: ModelInfo): void {
    this.currentSettings.currentModel = cloneModelInfo(modelInfo);
    void this.writeSettingsFile(this.currentSettings);
  }

  clearCurrentModel(): void {
    this.currentSettings.currentModel = undefined;
    void this.writeSettingsFile(this.currentSettings);
  }

  getStatusMessageId(): string | undefined {
    return this.currentSettings.statusMessageId;
  }

  setStatusMessageId(messageId: string): void {
    this.currentSettings.statusMessageId = messageId;
    void this.writeSettingsFile(this.currentSettings);
  }

  clearStatusMessageId(): void {
    this.currentSettings.statusMessageId = undefined;
    void this.writeSettingsFile(this.currentSettings);
  }

  getChatStatusMessageId(chatId: string): string | undefined {
    return this.chatStatusMessageIds.get(chatId);
  }

  setChatStatusMessageId(chatId: string, messageId: string): void {
    this.chatStatusMessageIds.set(chatId, messageId);
  }

  clearChatStatusMessageId(chatId: string): void {
    this.chatStatusMessageIds.delete(chatId);
  }

  getSessionDirectoryCache(): SessionDirectoryCacheInfo | undefined {
    return cloneSessionDirectoryCache(
      this.currentSettings.sessionDirectoryCache,
    );
  }

  setSessionDirectoryCache(cache: SessionDirectoryCacheInfo): Promise<void> {
    this.currentSettings.sessionDirectoryCache =
      cloneSessionDirectoryCache(cache);
    return this.writeSettingsFile(this.currentSettings);
  }

  clearSessionDirectoryCache(): void {
    this.currentSettings.sessionDirectoryCache = undefined;
    void this.writeSettingsFile(this.currentSettings);
  }
}

export const settingsManager = new SettingsManager();

export function getSettingsFilePath(): string {
  return settingsManager.getSettingsFilePath();
}

export async function loadSettings(): Promise<void> {
  return settingsManager.loadSettings();
}

export function getCurrentProject(): ProjectInfo | undefined {
  return settingsManager.getCurrentProject();
}

export function setCurrentProject(projectInfo: ProjectInfo): void {
  settingsManager.setCurrentProject(projectInfo);
}

export function clearProject(): void {
  settingsManager.clearProject();
}

export function getCurrentSession(): SessionInfo | undefined {
  return settingsManager.getCurrentSession();
}

export function setCurrentSession(sessionInfo: SessionInfo): void {
  settingsManager.setCurrentSession(sessionInfo);
}

export function clearSession(): void {
  settingsManager.clearSession();
}

export function getChatSession(chatId: string): SessionInfo | undefined {
  return settingsManager.getChatSession(chatId);
}

export function setChatSession(chatId: string, sessionInfo: SessionInfo): void {
  settingsManager.setChatSession(chatId, sessionInfo);
}

export function clearChatSession(chatId: string): void {
  settingsManager.clearChatSession(chatId);
}

export function getCurrentAgent(): string | undefined {
  return settingsManager.getCurrentAgent();
}

export function setCurrentAgent(agentName: string): void {
  settingsManager.setCurrentAgent(agentName);
}

export function clearCurrentAgent(): void {
  settingsManager.clearCurrentAgent();
}

export function getCurrentModel(): ModelInfo | undefined {
  return settingsManager.getCurrentModel();
}

export function setCurrentModel(modelInfo: ModelInfo): void {
  settingsManager.setCurrentModel(modelInfo);
}

export function clearCurrentModel(): void {
  settingsManager.clearCurrentModel();
}

export function getStatusMessageId(): string | undefined {
  return settingsManager.getStatusMessageId();
}

export function setStatusMessageId(messageId: string): void {
  settingsManager.setStatusMessageId(messageId);
}

export function clearStatusMessageId(): void {
  settingsManager.clearStatusMessageId();
}

export function getChatStatusMessageId(chatId: string): string | undefined {
  return settingsManager.getChatStatusMessageId(chatId);
}

export function setChatStatusMessageId(
  chatId: string,
  messageId: string,
): void {
  settingsManager.setChatStatusMessageId(chatId, messageId);
}

export function clearChatStatusMessageId(chatId: string): void {
  settingsManager.clearChatStatusMessageId(chatId);
}

export function getSessionDirectoryCache():
  | SessionDirectoryCacheInfo
  | undefined {
  return settingsManager.getSessionDirectoryCache();
}

export function setSessionDirectoryCache(
  cache: SessionDirectoryCacheInfo,
): Promise<void> {
  return settingsManager.setSessionDirectoryCache(cache);
}

export function clearSessionDirectoryCache(): void {
  settingsManager.clearSessionDirectoryCache();
}

export async function waitForPendingSettingsWrites(): Promise<void> {
  return settingsManager.waitForPendingWrites();
}

export function __resetSettingsForTests(): void {
  settingsManager.__resetSettingsForTests();
}

export function __resetChatStateForTests(): void {
  settingsManager.__resetChatStateForTests();
}
