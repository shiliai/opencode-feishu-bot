import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  EventDeduplicator,
  createEventDeduplicator,
} from "../../src/feishu/event-deduplicator.js";
import type { AppConfig } from "../../src/config.js";

describe("EventDeduplicator", () => {
  it("accepts the first event and rejects duplicates within the ttl window", () => {
    let now = 1_000;
    const deduplicator = new EventDeduplicator({
      ttlMs: 5_000,
      now: () => now,
    });

    expect(deduplicator.claim("event-1")).toBe(true);
    expect(deduplicator.claim("event-1")).toBe(false);

    now += 5_001;
    expect(deduplicator.claim("event-1")).toBe(true);
  });

  it("prunes expired entries from the snapshot", () => {
    let now = 1_000;
    const deduplicator = new EventDeduplicator({
      ttlMs: 1_000,
      now: () => now,
    });

    deduplicator.claim("event-1");
    deduplicator.claim("event-2");
    expect(deduplicator.getSnapshot()).toEqual({ size: 2, ttlMs: 1000 });

    now += 1_001;
    expect(deduplicator.getSnapshot()).toEqual({ size: 0, ttlMs: 1000 });
  });

  it("hydrates persisted entries and blocks duplicate replay after restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dedup-test-"));
    const persistencePath = join(tempDir, "event-dedup.json");

    try {
      let now = 1_000;
      const firstRun = new EventDeduplicator({
        ttlMs: 5_000,
        now: () => now,
        persistence: { filePath: persistencePath },
      });

      expect(firstRun.claim("event-1")).toBe(true);
      await firstRun.waitForPendingPersistenceWrites();

      const secondRun = new EventDeduplicator({
        ttlMs: 5_000,
        now: () => now,
        persistence: { filePath: persistencePath },
      });
      await secondRun.hydrate();

      expect(secondRun.claim("event-1")).toBe(false);

      now += 5_001;
      expect(secondRun.claim("event-1")).toBe(true);
      await secondRun.waitForPendingPersistenceWrites();

      const persisted = JSON.parse(
        await readFile(persistencePath, "utf-8"),
      ) as { version: number; entries: Array<{ key: string }> };
      expect(persisted.version).toBe(1);
      expect(persisted.entries.some((entry) => entry.key === "event-1")).toBe(
        true,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds a deduplicator from config", () => {
    const config = {
      opencode: { apiUrl: "http://localhost:4096", apiKey: "" },
      feishu: {
        appId: "app-id",
        appSecret: "secret",
        botOpenId: "",
        eventDedupTtlMs: 60000,
        eventDedupPersistPath: ".data/event-dedup.json",
      },
      connectionType: "ws",
      cardCallback: null,
      throttle: {
        statusCardUpdateIntervalMs: 2000,
        statusCardPatchRetryDelayMs: 500,
        statusCardPatchMaxAttempts: 3,
      },
      controlCatalog: {
        cacheTtlMs: 600000,
        modelStatePath: "~/.local/state/opencode/model.json",
      },
      service: { port: 3000, host: "0.0.0.0" },
      logLevel: "info",
    } satisfies AppConfig;

    const deduplicator = createEventDeduplicator(config);
    expect(deduplicator.getSnapshot()).toEqual({ size: 0, ttlMs: 60000 });
  });
});
