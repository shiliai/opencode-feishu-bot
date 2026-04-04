import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/utils/logger.js";

describe("logger", () => {
  it("writes warn and error logs to stderr with prefixes", () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const logger = createLogger({
      getLevel: () => "warn",
      now: () => new Date("2025-01-01T00:00:00.000Z"),
      stderr,
      stdout,
    });

    logger.info("ignored");
    logger.warn("warned", { code: 1 });
    logger.error(new Error("boom"));

    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledTimes(2);
    expect(stderr.write.mock.calls[0]?.[0]).toContain(
      "[2025-01-01T00:00:00.000Z] [WARN] warned { code: 1 }",
    );
    expect(stderr.write.mock.calls[1]?.[0]).toContain("Error: boom");
  });

  it("falls back to info when an invalid level is configured", () => {
    const stdout = { write: vi.fn() };
    const logger = createLogger({
      getLevel: () => "not-a-level",
      now: () => new Date("2025-01-01T00:00:00.000Z"),
      stdout,
      stderr: { write: vi.fn() },
    });

    logger.info("hello");

    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stdout.write.mock.calls[0]?.[0]).toContain("[INFO] hello");
  });
});
