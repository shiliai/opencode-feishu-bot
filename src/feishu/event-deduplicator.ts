import type { AppConfig } from "../config.js";

export interface EventDeduplicatorOptions {
  now?: () => number;
  ttlMs: number;
}

export interface EventDeduplicatorSnapshot {
  size: number;
  ttlMs: number;
}

export class EventDeduplicator {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, number>();

  constructor(options: EventDeduplicatorOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
  }

  claim(key: string): boolean {
    this.prune();
    const now = this.now();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }

    this.entries.set(key, now + this.ttlMs);
    return true;
  }

  prune(referenceTimeMs: number = this.now()): void {
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= referenceTimeMs) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  getSnapshot(): EventDeduplicatorSnapshot {
    this.prune();
    return {
      size: this.entries.size,
      ttlMs: this.ttlMs,
    };
  }
}

export function createEventDeduplicator(config: Pick<AppConfig, "feishu">): EventDeduplicator {
  return new EventDeduplicator({
    ttlMs: config.feishu.eventDedupTtlMs,
  });
}
