import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../src/config.js";
import type { Logger } from "../../src/utils/logger.js";

const CONFIG_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_CONNECTION_TYPE",
  "FEISHU_CARD_CALLBACK_URL",
  "FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN",
  "FEISHU_CARD_CALLBACK_ENCRYPT_KEY",
  "OPENCODE_API_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_WORKDIR",
  "SERVICE_PORT",
  "SERVICE_HOST",
  "LOG_LEVEL",
  "THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS",
  "THROTTLE_STATUS_CARD_PATCH_RETRY_DELAY_MS",
  "THROTTLE_STATUS_CARD_PATCH_MAX_ATTEMPTS",
  "STATUS_CARD_RECENT_UPDATES_COUNT",
  "STATUS_CARD_RECREATE_INTERVAL",
  "FEISHU_EVENT_DEDUP_TTL_MS",
  "FEISHU_EVENT_DEDUP_PERSIST_PATH",
  "CONTROL_CATALOG_CACHE_TTL_MS",
  "CONTROL_CATALOG_MODEL_STATE_PATH",
];

function clearAllConfigKeys(): void {
  for (const key of CONFIG_KEYS) {
    delete process.env[key];
  }
}

const mockConfigError = new ConfigValidationError(
  "FEISHU_APP_ID",
  "Missing required environment variable: FEISHU_APP_ID. Set it in your .env file or environment.",
);

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const loggerForMocks: Logger = mockLogger;

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn(),
  WSClient: vi.fn(),
  EventDispatcher: vi.fn(),
  CardActionHandler: vi.fn(),
  adaptDefault: vi.fn(),
  Domain: { Feishu: "Feishu" },
}));

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/config.js")>(
    "../../src/config.js",
  );
  return {
    ...actual,
    getConfig: () => {
      throw mockConfigError;
    },
    loadConfig: () => {
      throw mockConfigError;
    },
  };
});

vi.mock("../../src/opencode/client.js", () => ({
  createOpenCodeClient: vi.fn().mockReturnValue({}),
  opencodeClient: {},
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: loggerForMocks,
  createLogger: vi.fn().mockReturnValue(loggerForMocks),
}));

describe("startup missing env vars", () => {
  beforeEach(() => {
    clearAllConfigKeys();
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllConfigKeys();
  });

  it("calls process.exit(1) when a required env var is missing", async () => {
    const { startFeishuApp } =
      await import("../../src/app/start-feishu-app.js");

    try {
      await startFeishuApp();
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect((error as Error).message).toBe("process.exit called");
      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1);
    }
  });

  it("logs the missing var name when config validation fails", async () => {
    const { startFeishuApp } =
      await import("../../src/app/start-feishu-app.js");

    try {
      await startFeishuApp();
    } catch {
      // process.exit mock throws — expected
    }

    const errorCalls = mockLogger.error.mock.calls.map((args) =>
      String(args[0]),
    );
    const hasConfigError = errorCalls.some((msg) =>
      msg.includes("FEISHU_APP_ID"),
    );
    expect(hasConfigError).toBe(true);
  });
});
