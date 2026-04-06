import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  resetConfig,
  ConfigValidationError,
} from "../../src/config.js";

function clearAllConfigKeys(): void {
  const keys = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BOT_OPEN_ID",
    "FEISHU_CONNECTION_TYPE",
    "FEISHU_CARD_CALLBACK_URL",
    "FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN",
    "FEISHU_CARD_CALLBACK_ENCRYPT_KEY",
    "OPENCODE_API_BASE_URL",
    "OPENCODE_API_KEY",
    "SERVICE_PORT",
    "SERVICE_HOST",
    "LOG_LEVEL",
    "THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS",
    "FEISHU_EVENT_DEDUP_TTL_MS",
    "CONTROL_CATALOG_CACHE_TTL_MS",
  ];
  for (const key of keys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearAllConfigKeys();
  resetConfig();
});

afterEach(() => {
  clearAllConfigKeys();
  resetConfig();
});

describe("missing env vars - fast failure", () => {
  it("fails with deterministic error when FEISHU_APP_ID is missing", () => {
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CONNECTION_TYPE = "ws";

    try {
      loadConfig();
      throw new Error("Expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.missingVar).toBe("FEISHU_APP_ID");
      expect(validationErr.message).toContain("FEISHU_APP_ID");
    }
  });

  it("fails with deterministic error when FEISHU_APP_SECRET is missing", () => {
    process.env.FEISHU_APP_ID = "app-id";
    process.env.FEISHU_CONNECTION_TYPE = "ws";

    try {
      loadConfig();
      throw new Error("Expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.missingVar).toBe("FEISHU_APP_SECRET");
      expect(validationErr.message).toContain("FEISHU_APP_SECRET");
    }
  });

  it("fails when both FEISHU_APP_ID and FEISHU_APP_SECRET are missing (reports first)", () => {
    process.env.FEISHU_CONNECTION_TYPE = "ws";

    try {
      loadConfig();
      throw new Error("Expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.missingVar).toBe("FEISHU_APP_ID");
    }
  });

  it("reports FEISHU_CARD_CALLBACK_URL missing before VERIFICATION_TOKEN in webhook mode", () => {
    process.env.FEISHU_APP_ID = "app-id";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CONNECTION_TYPE = "webhook";

    try {
      loadConfig();
      throw new Error("Expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.missingVar).toBe("FEISHU_CARD_CALLBACK_URL");
    }
  });

  it("reports FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN when URL is set", () => {
    process.env.FEISHU_APP_ID = "app-id";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CONNECTION_TYPE = "webhook";
    process.env.FEISHU_CARD_CALLBACK_URL = "https://example.com/callback";

    try {
      loadConfig();
      throw new Error("Expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.missingVar).toBe(
        "FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN",
      );
    }
  });

  it("error messages are deterministic and reproducible", () => {
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CONNECTION_TYPE = "ws";

    const messages: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        loadConfig();
      } catch (err) {
        messages.push((err as ConfigValidationError).message);
      }
    }

    expect(messages.length).toBe(3);
    expect(new Set(messages).size).toBe(1);
  });
});
