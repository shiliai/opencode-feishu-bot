import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager, type Logger } from "../../src/settings/manager.js";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-feishu-corrupt-"));
  tempDirectories.push(directory);
  return path.join(directory, "settings.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SettingsManager corrupt JSON recovery", () => {
  it("falls back to empty settings and logs a warning", async () => {
    const settingsFilePath = await createSettingsFilePath();
    const logger = createSilentLogger();
    await writeFile(settingsFilePath, "{not-valid-json", "utf-8");

    const manager = new SettingsManager({ logger, settingsFilePath });

    await expect(manager.loadSettings()).resolves.toBeUndefined();
    expect(manager.getSettingsSnapshot()).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
