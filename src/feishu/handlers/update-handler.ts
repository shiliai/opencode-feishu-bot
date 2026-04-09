import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_JSON_PATH = join(__dirname, "..", "..", "..", "package.json");
const FETCH_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 120_000;

function readVersionFromPackageJson(raw: string): string | null {
  try {
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function readCurrentVersion(): string {
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, "utf-8");
    return readVersionFromPackageJson(raw) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function getRemoteVersion(logger: Logger): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", "origin/main:package.json"],
      { timeout: CHECK_TIMEOUT_MS },
    );
    return readVersionFromPackageJson(stdout) ?? null;
  } catch (error) {
    logger.warn("[UpdateHandler] Failed to read remote version", error);
    return null;
  }
}

async function hasRemoteUpdates(logger: Logger): Promise<boolean | null> {
  try {
    await execFileAsync("git", ["fetch", "origin", "main"], {
      timeout: FETCH_TIMEOUT_MS,
    });

    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", "HEAD..origin/main"],
      { timeout: CHECK_TIMEOUT_MS },
    );

    const aheadCount = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(aheadCount) && aheadCount > 0;
  } catch (error) {
    logger.warn("[UpdateHandler] Failed to check for updates", error);
    return null;
  }
}

export interface UpdateResult {
  success: boolean;
  message: string;
  needsRestart: boolean;
}

export async function handleUpdateCommand(
  logger: Logger,
): Promise<UpdateResult> {
  const currentVersion = readCurrentVersion();
  logger.info(`[UpdateHandler] Current version: ${currentVersion}`);

  const hasUpdates = await hasRemoteUpdates(logger);
  if (hasUpdates === null) {
    return {
      success: false,
      message: "Failed to check for updates. See service logs for details.",
      needsRestart: false,
    };
  }

  if (!hasUpdates) {
    return {
      success: true,
      message: `Already up to date (v${currentVersion}). No updates available.`,
      needsRestart: false,
    };
  }

  const remoteVersion = await getRemoteVersion(logger);

  try {
    logger.info("[UpdateHandler] Pulling latest changes...");
    await execFileAsync("git", ["pull", "--ff-only", "origin", "main"], {
      timeout: FETCH_TIMEOUT_MS,
    });

    logger.info("[UpdateHandler] Installing dependencies...");
    await execFileAsync("npm", ["install", "--include=dev"], {
      timeout: INSTALL_TIMEOUT_MS,
    });

    logger.info("[UpdateHandler] Building...");
    await execFileAsync("npm", ["run", "build"], {
      timeout: BUILD_TIMEOUT_MS,
    });

    const newVersion = readCurrentVersion();
    const versionMessage = remoteVersion
      ? `v${currentVersion} → v${newVersion}`
      : `updated to v${newVersion}`;

    return {
      success: true,
      message:
        `Update successful: ${versionMessage}\n` +
        "The service needs to be restarted to apply changes. " +
        "Use systemctl --user restart opencode-feishu-bridge or ask an admin.",
      needsRestart: true,
    };
  } catch (error) {
    logger.error("[UpdateHandler] Update failed", error);
    return {
      success: false,
      message: `Update failed: ${getErrorMessage(error)}`,
      needsRestart: false,
    };
  }
}
