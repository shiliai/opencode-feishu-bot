import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "../utils/logger.js";

export interface FileStoreOptions {
  tempDirPrefix?: string;
  logger?: Logger;
}

export interface StoredFile {
  localPath: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
}

export class FileStore {
  private activeTempDirs = new Set<string>();
  private readonly tempDirPrefix: string;
  private readonly logger: Logger;

  constructor(options: FileStoreOptions = {}) {
    this.tempDirPrefix = options.tempDirPrefix ?? "feishu-bridge-";
    this.logger = options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  async createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), this.tempDirPrefix));
    this.activeTempDirs.add(dir);
    this.logger.debug(`[FileStore] Created temp dir: ${dir}`);
    return dir;
  }

  async storeFile(
    tempDir: string,
    fileName: string,
    data: Buffer | string,
    mimeType?: string,
  ): Promise<StoredFile> {
    const localPath = join(tempDir, fileName);
    await writeFile(localPath, data);
    const fileSize = Buffer.isBuffer(data)
      ? data.length
      : Buffer.byteLength(data);
    this.logger.debug(
      `[FileStore] Stored file: ${localPath} (${fileSize} bytes)`,
    );
    return { localPath, fileName, fileSize, mimeType };
  }

  async readFile(localPath: string): Promise<Buffer> {
    return readFile(localPath);
  }

  async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      await rm(tempDir, { recursive: true, force: true });
      this.logger.debug(`[FileStore] Cleaned up temp dir: ${tempDir}`);
    } catch (error: unknown) {
      this.logger.warn(
        `[FileStore] Failed to clean up temp dir: ${tempDir}`,
        error,
      );
    } finally {
      this.activeTempDirs.delete(tempDir);
    }
  }

  async cleanupAll(): Promise<void> {
    const dirs = Array.from(this.activeTempDirs);
    await Promise.all(dirs.map((dir) => this.cleanupTempDir(dir)));
  }

  getActiveTempDirs(): string[] {
    return Array.from(this.activeTempDirs);
  }
}
