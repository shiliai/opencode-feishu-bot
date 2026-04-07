import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type { Logger } from "../utils/logger.js";

export interface EventDeduplicatorFileSystem {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  writeFile: typeof writeFile;
}

export interface EventDeduplicatorPersistenceOptions {
  filePath: string;
  fileSystem?: EventDeduplicatorFileSystem;
}

export interface EventDeduplicatorOptions {
  now?: () => number;
  ttlMs: number;
  logger?: Logger;
  persistence?: EventDeduplicatorPersistenceOptions;
}

export interface EventDeduplicatorSnapshot {
  size: number;
  ttlMs: number;
}

interface PersistedDedupEntry {
  key: string;
  expiresAt: number;
}

interface PersistedDedupPayload {
  version: 1;
  entries: PersistedDedupEntry[];
}

const PERSISTED_DEDUP_VERSION = 1;

function createNoopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedDedupPayload(
  value: unknown,
): value is PersistedDedupPayload {
  if (
    !isRecord(value) ||
    value.version !== PERSISTED_DEDUP_VERSION ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }

  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.key === "string" &&
      typeof entry.expiresAt === "number" &&
      Number.isFinite(entry.expiresAt),
  );
}

export class EventDeduplicator {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly fileSystem: EventDeduplicatorFileSystem;
  private readonly persistenceFilePath: string | null;
  private readonly entries = new Map<string, number>();

  private writeSequence = 0;
  private persistenceHydrated = false;
  private persistenceWriteQueue: Promise<void> = Promise.resolve();

  constructor(options: EventDeduplicatorOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.logger = options.logger ?? createNoopLogger();
    this.fileSystem = options.persistence?.fileSystem ?? {
      mkdir,
      readFile,
      rename,
      writeFile,
    };
    this.persistenceFilePath = options.persistence?.filePath ?? null;
  }

  async hydrate(): Promise<void> {
    if (!this.persistenceFilePath || this.persistenceHydrated) {
      return;
    }

    try {
      const content = await this.fileSystem.readFile(
        this.persistenceFilePath,
        "utf-8",
      );
      const parsed = JSON.parse(content) as unknown;
      if (!isPersistedDedupPayload(parsed)) {
        this.logger.warn(
          `[EventDeduplicator] Ignoring invalid persisted dedup payload at ${this.persistenceFilePath}`,
        );
      } else {
        this.entries.clear();
        const referenceTime = this.now();
        for (const entry of parsed.entries) {
          if (entry.expiresAt > referenceTime) {
            this.entries.set(entry.key, entry.expiresAt);
          }
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        this.logger.warn(
          `[EventDeduplicator] Failed to hydrate persisted dedup state from ${this.persistenceFilePath}`,
          error,
        );
      }
    }

    this.persistenceHydrated = true;
    this.prune();
  }

  async waitForPendingPersistenceWrites(): Promise<void> {
    await this.persistenceWriteQueue;
  }

  claim(key: string): boolean {
    this.prune();
    const now = this.now();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }

    this.entries.set(key, now + this.ttlMs);
    this.persistEntries();
    return true;
  }

  prune(referenceTimeMs: number = this.now()): void {
    let changed = false;
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= referenceTimeMs) {
        this.entries.delete(key);
        changed = true;
      }
    }

    if (changed) {
      this.persistEntries();
    }
  }

  clear(): void {
    if (this.entries.size === 0) {
      return;
    }

    this.entries.clear();
    this.persistEntries();
  }

  getSnapshot(): EventDeduplicatorSnapshot {
    this.prune();
    return {
      size: this.entries.size,
      ttlMs: this.ttlMs,
    };
  }

  private persistEntries(): void {
    if (!this.persistenceFilePath) {
      return;
    }

    const payload: PersistedDedupPayload = {
      version: PERSISTED_DEDUP_VERSION,
      entries: Array.from(this.entries.entries()).map(([key, expiresAt]) => ({
        key,
        expiresAt,
      })),
    };
    const writeId = ++this.writeSequence;

    this.persistenceWriteQueue = this.persistenceWriteQueue
      .catch(() => undefined)
      .then(async () => {
        const targetPath = this.persistenceFilePath as string;
        const directory = path.dirname(targetPath);
        const tempPath = `${targetPath}.${writeId}.tmp`;
        try {
          await this.fileSystem.mkdir(directory, { recursive: true });
          await this.fileSystem.writeFile(
            tempPath,
            JSON.stringify(payload),
            "utf-8",
          );
          await this.fileSystem.rename(tempPath, targetPath);
        } catch (error) {
          this.logger.warn(
            `[EventDeduplicator] Failed to persist dedup state to ${targetPath}`,
            error,
          );
        }
      });
  }
}

export function createEventDeduplicator(
  config: Pick<AppConfig, "feishu">,
): EventDeduplicator {
  return new EventDeduplicator({
    ttlMs: config.feishu.eventDedupTtlMs,
    persistence: {
      filePath: config.feishu.eventDedupPersistPath,
    },
  });
}
