import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileAsyncMock, readFileSyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");

  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

  return {
    ...actual,
    readFileSync: readFileSyncMock,
  };
});

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("handleUpdateCommand", () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset();
    readFileSyncMock.mockReset();
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it("returns an up-to-date message when origin/main has no newer commits", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: "0.1.0" }));
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0\n", stderr: "" });

    const { handleUpdateCommand } =
      await import("../../src/feishu/handlers/update-handler.js");

    await expect(handleUpdateCommand(logger)).resolves.toEqual({
      success: true,
      message: "Already up to date (v0.1.0). No updates available.",
      needsRestart: false,
    });

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["fetch", "origin", "main"],
      { timeout: 30000 },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["rev-list", "--count", "HEAD..origin/main"],
      { timeout: 10000 },
    );
  });

  it("pulls, installs, and builds when a newer version is available", async () => {
    readFileSyncMock
      .mockReturnValueOnce(JSON.stringify({ version: "0.1.0" }))
      .mockReturnValueOnce(JSON.stringify({ version: "0.1.1" }));
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "2\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ version: "0.1.1" }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "Updating files", stderr: "" })
      .mockResolvedValueOnce({ stdout: "installed", stderr: "" })
      .mockResolvedValueOnce({ stdout: "built", stderr: "" });

    const { handleUpdateCommand } =
      await import("../../src/feishu/handlers/update-handler.js");

    await expect(handleUpdateCommand(logger)).resolves.toEqual({
      success: true,
      message:
        "Update successful: v0.1.0 → v0.1.1\n" +
        "The service needs to be restarted to apply changes. " +
        "Use systemctl --user restart opencode-feishu-bridge or ask an admin.",
      needsRestart: true,
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      "git",
      ["show", "origin/main:package.json"],
      { timeout: 10000 },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      "git",
      ["pull", "--ff-only", "origin", "main"],
      { timeout: 30000 },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      5,
      "npm",
      ["install", "--include=dev"],
      { timeout: 120000 },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      6,
      "npm",
      ["run", "build"],
      { timeout: 120000 },
    );
  });

  it("returns a failure result when the update commands fail", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: "0.1.0" }));
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "1\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ version: "0.1.1" }),
        stderr: "",
      })
      .mockRejectedValueOnce(new Error("git pull failed"));

    const { handleUpdateCommand } =
      await import("../../src/feishu/handlers/update-handler.js");

    await expect(handleUpdateCommand(logger)).resolves.toEqual({
      success: false,
      message: "Update failed: git pull failed",
      needsRestart: false,
    });

    expect(logger.error).toHaveBeenCalledWith(
      "[UpdateHandler] Update failed",
      expect.any(Error),
    );
  });
});
