import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../utils/logger.js";

export interface WorkdirEntry {
  name: string;
  absolutePath: string;
}

export async function scanWorkdirSubdirs(
  workdirPath: string,
  logger?: Logger,
): Promise<WorkdirEntry[]> {
  try {
    const entries = await readdir(workdirPath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        absolutePath: join(workdirPath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    logger?.warn(
      `[WorkdirScanner] Failed to scan workdir subdirectories: ${workdirPath}`,
      error,
    );
    return [];
  }
}
