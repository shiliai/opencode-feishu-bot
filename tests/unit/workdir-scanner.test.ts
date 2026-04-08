import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanWorkdirSubdirs } from "../../src/feishu/workdir-scanner.js";

describe("scanWorkdirSubdirs", () => {
  let tempWorkdir = "";

  beforeEach(async () => {
    tempWorkdir = await mkdtemp(join(tmpdir(), "opencode-workdir-"));
  });

  afterEach(async () => {
    if (tempWorkdir) {
      await rm(tempWorkdir, { recursive: true, force: true });
    }
  });

  it("returns sorted immediate subdirectories", async () => {
    await mkdir(join(tempWorkdir, "zeta"));
    await mkdir(join(tempWorkdir, "alpha"));

    await expect(scanWorkdirSubdirs(tempWorkdir)).resolves.toEqual([
      {
        name: "alpha",
        absolutePath: join(tempWorkdir, "alpha"),
      },
      {
        name: "zeta",
        absolutePath: join(tempWorkdir, "zeta"),
      },
    ]);
  });

  it("returns an empty list for an empty directory", async () => {
    await expect(scanWorkdirSubdirs(tempWorkdir)).resolves.toEqual([]);
  });

  it("returns an empty list and logs a warning when the directory is missing", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const missingWorkdir = join(tempWorkdir, "missing");

    await expect(scanWorkdirSubdirs(missingWorkdir, logger)).resolves.toEqual(
      [],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[WorkdirScanner] Failed to scan workdir subdirectories: ${missingWorkdir}`,
      expect.any(Error),
    );
  });

  it("skips symbolic links", async () => {
    const realDirectory = join(tempWorkdir, "real-directory");
    await mkdir(realDirectory);
    await symlink(realDirectory, join(tempWorkdir, "linked-directory"));

    await expect(scanWorkdirSubdirs(tempWorkdir)).resolves.toEqual([
      {
        name: "real-directory",
        absolutePath: realDirectory,
      },
    ]);
  });

  it("skips regular files", async () => {
    const directoryPath = join(tempWorkdir, "project-a");
    await mkdir(directoryPath);
    await writeFile(join(tempWorkdir, "notes.txt"), "ignore me");

    await expect(scanWorkdirSubdirs(tempWorkdir)).resolves.toEqual([
      {
        name: "project-a",
        absolutePath: directoryPath,
      },
    ]);
  });
});
