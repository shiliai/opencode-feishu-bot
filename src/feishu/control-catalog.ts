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
  private readonly now: () => number;
  private readonly logger: Logger;

  private modelCache?: CacheEntry;
  private agentCache?: CacheEntry;

  constructor(options: ControlCatalogAdapterOptions) {
    this.settingsManager = options.settingsManager;
    this.openCodeClient = options.openCodeClient;
    this.cacheTtlMs = Math.max(1, Math.floor(options.cacheTtlMs));
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

    return deduplicate(models);
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
