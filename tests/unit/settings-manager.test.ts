import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SettingsManager,
  type Logger,
  type SessionDirectoryCacheInfo,
} from "../../src/settings/manager.js";

const tempDirectories: string[] = [];

function createSilentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function createSettingsFilePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-feishu-settings-"));
  tempDirectories.push(directory);
  return path.join(directory, "settings.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SettingsManager", () => {
  it("persists and reloads transport-neutral settings", async () => {
    const settingsFilePath = await createSettingsFilePath();
    const logger = createSilentLogger();
    const manager = new SettingsManager({ logger, settingsFilePath });
    const cache: SessionDirectoryCacheInfo = {
      version: 1,
      lastSyncedUpdatedAt: 123,
      directories: [{ worktree: "/workspace", lastUpdated: 456 }],
    };

    manager.setCurrentProject({ id: "project-1", worktree: "/workspace", name: "Bridge" });
    manager.setCurrentSession({ id: "session-1", title: "Main", directory: "/workspace" });
    manager.setCurrentAgent("builder");
    manager.setCurrentModel({ providerID: "openai", modelID: "gpt-5", variant: "fast" });
    manager.setStatusMessageId("status-42");
    await manager.setSessionDirectoryCache(cache);
    await manager.waitForPendingWrites();

    expect(JSON.parse(await readFile(settingsFilePath, "utf-8"))).toEqual({
      currentAgent: "builder",
      currentModel: { providerID: "openai", modelID: "gpt-5", variant: "fast" },
      currentProject: { id: "project-1", worktree: "/workspace", name: "Bridge" },
      currentSession: { id: "session-1", title: "Main", directory: "/workspace" },
      sessionDirectoryCache: cache,
      statusMessageId: "status-42",
    });

    const reloaded = new SettingsManager({ logger, settingsFilePath });
    await reloaded.loadSettings();

    expect(reloaded.getCurrentProject()).toEqual({
      id: "project-1",
      worktree: "/workspace",
      name: "Bridge",
    });
    expect(reloaded.getCurrentSession()).toEqual({
      id: "session-1",
      title: "Main",
      directory: "/workspace",
    });
    expect(reloaded.getCurrentAgent()).toBe("builder");
    expect(reloaded.getCurrentModel()).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "fast",
    });
    expect(reloaded.getStatusMessageId()).toBe("status-42");
    expect(reloaded.getSessionDirectoryCache()).toEqual(cache);
  });

  it("drops Telegram-only legacy fields when loading persisted settings", async () => {
    const settingsFilePath = await createSettingsFilePath();
    const logger = createSilentLogger();

    await writeFile(
      settingsFilePath,
      JSON.stringify({
        currentSession: { id: "session-1", title: "Migrated", directory: "/workspace" },
        pinnedMessageId: 99,
        scheduledTasks: [{ id: "legacy-task" }],
        serverProcess: { pid: 42 },
        statusMessageId: "status-1",
      }),
      "utf-8",
    );

    const manager = new SettingsManager({ logger, settingsFilePath });
    await manager.loadSettings();

    expect(manager.getSettingsSnapshot()).toEqual({
      currentSession: { id: "session-1", title: "Migrated", directory: "/workspace" },
      statusMessageId: "status-1",
    });
  });

  it("serializes queued writes and keeps the latest value", async () => {
    const settingsFilePath = await createSettingsFilePath();
    const manager = new SettingsManager({
      logger: createSilentLogger(),
      settingsFilePath,
    });

    manager.setCurrentAgent("alpha");
    manager.setCurrentAgent("beta");
    manager.clearCurrentAgent();
    manager.setCurrentAgent("gamma");
    await manager.waitForPendingWrites();

    expect(JSON.parse(await readFile(settingsFilePath, "utf-8"))).toEqual({
      currentAgent: "gamma",
    });
  });
});
