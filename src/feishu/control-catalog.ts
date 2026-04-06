import { readFile } from "node:fs/promises";
import type { Logger } from "../utils/logger.js";
import type {
  SettingsManager,
  SessionInfo,
  ProjectInfo,
} from "../settings/manager.js";

export interface OpenCodeAppCatalogClient {
  agents(parameters?: {
    directory?: string;
    workspace?: string;
  }): Promise<{ data?: unknown }>;
}

export interface OpenCodeConfigCatalogClient {
  providers(parameters?: {
    directory?: string;
    workspace?: string;
  }): Promise<{ data?: unknown }>;
}

export interface OpenCodeControlCatalogClient {
  app: OpenCodeAppCatalogClient;
  config: OpenCodeConfigCatalogClient;
}

export interface ControlCatalogProvider {
  getAvailableModels(): Promise<string[]>;
  getAvailableAgents(): Promise<string[]>;
}

export interface ControlCatalogAdapterOptions {
  settingsManager: Pick<
    SettingsManager,
    "getCurrentProject" | "getCurrentSession"
  >;
  openCodeClient: OpenCodeControlCatalogClient;
  cacheTtlMs: number;
  modelStatePath?: string;
  readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
  now?: () => number;
  logger?: Logger;
}

interface CacheEntry {
  expiresAt: number;
  values: string[];
}

function createNoopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deduplicate(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }

  return output;
}

function normalizeModelIdentifier(candidate: unknown): string | null {
  if (typeof candidate === "string") {
    const normalized = candidate.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (!isRecord(candidate)) {
    return null;
  }

  const providerId =
    typeof candidate.providerID === "string"
      ? candidate.providerID.trim()
      : typeof candidate.provider === "string"
        ? candidate.provider.trim()
        : "";
  const modelId =
    typeof candidate.modelID === "string"
      ? candidate.modelID.trim()
      : typeof candidate.model === "string"
        ? candidate.model.trim()
        : "";

  if (providerId && modelId) {
    return `${providerId}/${modelId}`;
  }

  const id =
    typeof candidate.id === "string"
      ? candidate.id.trim()
      : typeof candidate.name === "string"
        ? candidate.name.trim()
        : "";
  return id || null;
}

function extractPreferredModels(data: unknown): string[] {
  const candidates: unknown[] = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  }

  if (isRecord(data)) {
    for (const key of [
      "favorite",
      "favorites",
      "recent",
      "models",
      "history",
    ]) {
      const value = data[key];
      if (Array.isArray(value)) {
        candidates.push(...value);
      }
    }

    for (const key of ["lastUsed", "current"]) {
      const value = data[key];
      if (value !== undefined) {
        candidates.push(value);
      }
    }
  }

  return deduplicate(
    candidates
      .map((candidate) => normalizeModelIdentifier(candidate))
      .filter((candidate): candidate is string => candidate !== null),
  );
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

export class ControlCatalogAdapter implements ControlCatalogProvider {
  private readonly settingsManager: Pick<
    SettingsManager,
    "getCurrentProject" | "getCurrentSession"
  >;
  private readonly openCodeClient: OpenCodeControlCatalogClient;
  private readonly cacheTtlMs: number;
  private readonly modelStatePath: string | null;
  private readonly readFileFn: (
    path: string,
    encoding: BufferEncoding,
  ) => Promise<string>;
  private readonly now: () => number;
  private readonly logger: Logger;

  private modelCache?: CacheEntry;
  private agentCache?: CacheEntry;

  constructor(options: ControlCatalogAdapterOptions) {
    this.settingsManager = options.settingsManager;
    this.openCodeClient = options.openCodeClient;
    this.cacheTtlMs = Math.max(1, Math.floor(options.cacheTtlMs));
    this.modelStatePath =
      typeof options.modelStatePath === "string" &&
      options.modelStatePath.trim().length > 0
        ? options.modelStatePath
        : null;
    this.readFileFn = options.readFileFn ?? readFile;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? createNoopLogger();
  }

  async getAvailableModels(): Promise<string[]> {
    return this.resolveWithCache({
      cache: this.modelCache,
      updateCache: (entry) => {
        this.modelCache = entry;
      },
      fetchCatalog: () => this.fetchModels(),
      kind: "model",
    });
  }

  async getAvailableAgents(): Promise<string[]> {
    return this.resolveWithCache({
      cache: this.agentCache,
      updateCache: (entry) => {
        this.agentCache = entry;
      },
      fetchCatalog: () => this.fetchAgents(),
      kind: "agent",
    });
  }

  private async resolveWithCache(options: {
    cache: CacheEntry | undefined;
    updateCache: (entry: CacheEntry) => void;
    fetchCatalog: () => Promise<string[]>;
    kind: "model" | "agent";
  }): Promise<string[]> {
    const now = this.now();
    if (options.cache && options.cache.expiresAt > now) {
      return [...options.cache.values];
    }

    try {
      const values = await options.fetchCatalog();
      options.updateCache({
        values,
        expiresAt: now + this.cacheTtlMs,
      });
      return [...values];
    } catch (error) {
      if (options.cache) {
        this.logger.warn(
          `[ControlCatalogAdapter] Falling back to stale ${options.kind} catalog cache`,
          error,
        );
        return [...options.cache.values];
      }

      this.logger.warn(
        `[ControlCatalogAdapter] Failed to load ${options.kind} catalog`,
        error,
      );
      return [];
    }
  }

  private async fetchModels(): Promise<string[]> {
    const directory = resolveDirectoryScope(
      this.settingsManager.getCurrentProject(),
      this.settingsManager.getCurrentSession(),
    );
    const response = await this.openCodeClient.config.providers({ directory });

    const providers = this.extractProviders(response.data);
    const models: string[] = [];

    for (const provider of providers) {
      if (!isRecord(provider)) {
        continue;
      }

      const providerId =
        typeof provider.id === "string" ? provider.id.trim() : "";
      const modelRecord = isRecord(provider.models)
        ? provider.models
        : undefined;
      if (!providerId || !modelRecord) {
        continue;
      }

      for (const modelId of Object.keys(modelRecord)) {
        if (!modelId) {
          continue;
        }
        models.push(`${providerId}/${modelId}`);
      }
    }

    const catalogModels = deduplicate(models);
    if (!this.modelStatePath) {
      return catalogModels;
    }

    const preferredModels = await this.loadPreferredModels();
    if (preferredModels.length === 0) {
      return catalogModels;
    }

    const catalogSet = new Set(catalogModels);
    const preferredAvailable = preferredModels.filter((model) =>
      catalogSet.has(model),
    );
    if (preferredAvailable.length === 0) {
      return catalogModels;
    }

    const preferredSet = new Set(preferredAvailable);
    const remainder = catalogModels.filter((model) => !preferredSet.has(model));
    return [...preferredAvailable, ...remainder];
  }

  private async loadPreferredModels(): Promise<string[]> {
    if (!this.modelStatePath) {
      return [];
    }

    try {
      const content = await this.readFileFn(this.modelStatePath, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      return extractPreferredModels(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      this.logger.warn(
        `[ControlCatalogAdapter] Failed to load model state from ${this.modelStatePath}`,
        error,
      );
      return [];
    }
  }

  private extractProviders(data: unknown): unknown[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (isRecord(data) && Array.isArray(data.providers)) {
      return data.providers;
    }

    return [];
  }

  private async fetchAgents(): Promise<string[]> {
    const directory = resolveDirectoryScope(
      this.settingsManager.getCurrentProject(),
      this.settingsManager.getCurrentSession(),
    );
    const response = await this.openCodeClient.app.agents({ directory });
    const data = response.data;
    if (!Array.isArray(data)) {
      return [];
    }

    const agents: string[] = [];
    for (const candidate of data) {
      if (!isRecord(candidate)) {
        continue;
      }

      const name =
        typeof candidate.name === "string" ? candidate.name.trim() : "";
      const mode = typeof candidate.mode === "string" ? candidate.mode : "";
      const hidden = candidate.hidden === true;

      if (!name || hidden) {
        continue;
      }

      if (mode !== "primary" && mode !== "all") {
        continue;
      }

      agents.push(name);
    }

    return deduplicate(agents);
  }
}
