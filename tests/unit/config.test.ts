import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  getConfig,
  resetConfig,
  ConfigValidationError,
  DEFAULT_CONTROL_CATALOG_MODEL_STATE_PATH,
  DEFAULT_FEISHU_EVENT_DEDUP_PERSIST_PATH,
} from "../../src/config.js";

const VALID_ENV = {
  FEISHU_APP_ID: "test-app-id",
  FEISHU_APP_SECRET: "test-app-secret",
  FEISHU_BOT_OPEN_ID: "ou_bot_test",
  FEISHU_CONNECTION_TYPE: "ws",
  OPENCODE_API_BASE_URL: "http://localhost:4096",
  SERVICE_PORT: "3000",
  SERVICE_HOST: "0.0.0.0",
  LOG_LEVEL: "info",
};

const WEBHOOK_ENV = {
  ...VALID_ENV,
  FEISHU_CONNECTION_TYPE: "webhook",
  FEISHU_CARD_CALLBACK_URL: "https://example.com/webhook/card",
  FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN: "test-verification-token",
};

const DUAL_INGRESS_ENV = {
  ...VALID_ENV,
  FEISHU_CARD_CALLBACK_URL: "https://example.com/webhook/card",
  FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN: "test-verification-token",
};

function setEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

function clearEnv(keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

function clearAllConfigKeys(): void {
  const allKeys = new Set([
    ...Object.keys(VALID_ENV),
    ...Object.keys(WEBHOOK_ENV),
    "OPENCODE_API_KEY",
    "THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS",
    "CONTROL_CATALOG_CACHE_TTL_MS",
    "CONTROL_CATALOG_MODEL_STATE_PATH",
    "FEISHU_EVENT_DEDUP_PERSIST_PATH",
    "FEISHU_CARD_CALLBACK_ENCRYPT_KEY",
  ]);
  clearEnv([...allKeys]);
}

beforeEach(() => {
  clearAllConfigKeys();
  resetConfig();
});

afterEach(() => {
  clearAllConfigKeys();
  resetConfig();
});

describe("loadConfig", () => {
  it("produces a valid config from WS environment", () => {
    setEnv(VALID_ENV);
    const config = loadConfig();

    expect(config.feishu.appId).toBe("test-app-id");
    expect(config.feishu.appSecret).toBe("test-app-secret");
    expect(config.feishu.botOpenId).toBe("ou_bot_test");
    expect(config.feishu.eventDedupTtlMs).toBe(300000);
    expect(config.feishu.eventDedupPersistPath).toBe(
      DEFAULT_FEISHU_EVENT_DEDUP_PERSIST_PATH,
    );
    expect(config.connectionType).toBe("ws");
    expect(config.opencode.apiUrl).toBe("http://localhost:4096");
    expect(config.opencode.apiKey).toBe("");
    expect(config.service.port).toBe(3000);
    expect(config.service.host).toBe("0.0.0.0");
    expect(config.logLevel).toBe("info");
    expect(config.cardCallback).toBeNull();
    expect(config.throttle.statusCardUpdateIntervalMs).toBe(2000);
    expect(config.controlCatalog.cacheTtlMs).toBe(600000);
    expect(config.controlCatalog.modelStatePath).toBe(
      DEFAULT_CONTROL_CATALOG_MODEL_STATE_PATH,
    );
  });

  it("produces a valid config from webhook environment", () => {
    setEnv(WEBHOOK_ENV);
    const config = loadConfig();

    expect(config.connectionType).toBe("webhook");
    expect(config.cardCallback).not.toBeNull();
    expect(config.cardCallback!.callbackUrl).toBe(
      "https://example.com/webhook/card",
    );
    expect(config.cardCallback!.verificationToken).toBe(
      "test-verification-token",
    );
    expect(config.cardCallback!.encryptKey).toBe("");
  });

  it("allows dual ingress card callback settings in ws mode", () => {
    setEnv(DUAL_INGRESS_ENV);
    const config = loadConfig();

    expect(config.connectionType).toBe("ws");
    expect(config.cardCallback).not.toBeNull();
    expect(config.cardCallback!.callbackUrl).toBe(
      "https://example.com/webhook/card",
    );
  });

  it("defaults connection type to ws when FEISHU_CONNECTION_TYPE is unset", () => {
    const { FEISHU_CONNECTION_TYPE: _, ...without } = VALID_ENV;
    setEnv(without);
    const config = loadConfig();

    expect(config.connectionType).toBe("ws");
  });

  it("defaults opencode API URL when unset", () => {
    const { OPENCODE_API_BASE_URL: _, ...without } = VALID_ENV;
    setEnv(without);
    const config = loadConfig();

    expect(config.opencode.apiUrl).toBe("http://localhost:4096");
  });

  it("defaults service port when unset", () => {
    const { SERVICE_PORT: _, ...without } = VALID_ENV;
    setEnv(without);
    const config = loadConfig();

    expect(config.service.port).toBe(3000);
  });

  it("defaults service host when unset", () => {
    const { SERVICE_HOST: _, ...without } = VALID_ENV;
    setEnv(without);
    const config = loadConfig();

    expect(config.service.host).toBe("0.0.0.0");
  });

  it("defaults log level when unset", () => {
    const { LOG_LEVEL: _, ...without } = VALID_ENV;
    setEnv(without);
    const config = loadConfig();

    expect(config.logLevel).toBe("info");
  });

  it("reads optional OPENCODE_API_KEY", () => {
    setEnv({ ...VALID_ENV, OPENCODE_API_KEY: "test-key" });
    const config = loadConfig();

    expect(config.opencode.apiKey).toBe("test-key");
  });

  it("reads optional THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS", () => {
    setEnv({ ...VALID_ENV, THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS: "5000" });
    const config = loadConfig();

    expect(config.throttle.statusCardUpdateIntervalMs).toBe(5000);
  });

  it("reads optional FEISHU_EVENT_DEDUP_TTL_MS", () => {
    setEnv({ ...VALID_ENV, FEISHU_EVENT_DEDUP_TTL_MS: "60000" });
    const config = loadConfig();

    expect(config.feishu.eventDedupTtlMs).toBe(60000);
  });

  it("reads optional FEISHU_EVENT_DEDUP_PERSIST_PATH", () => {
    setEnv({
      ...VALID_ENV,
      FEISHU_EVENT_DEDUP_PERSIST_PATH: "/tmp/feishu-event-dedup.json",
    });
    const config = loadConfig();

    expect(config.feishu.eventDedupPersistPath).toBe(
      "/tmp/feishu-event-dedup.json",
    );
  });

  it("reads optional CONTROL_CATALOG_CACHE_TTL_MS", () => {
    setEnv({ ...VALID_ENV, CONTROL_CATALOG_CACHE_TTL_MS: "120000" });
    const config = loadConfig();

    expect(config.controlCatalog.cacheTtlMs).toBe(120000);
  });

  it("reads optional CONTROL_CATALOG_MODEL_STATE_PATH", () => {
    setEnv({
      ...VALID_ENV,
      CONTROL_CATALOG_MODEL_STATE_PATH: "/tmp/opencode/model.json",
    });
    const config = loadConfig();

    expect(config.controlCatalog.modelStatePath).toBe(
      "/tmp/opencode/model.json",
    );
  });

  it("falls back to default for invalid throttle value", () => {
    setEnv({ ...VALID_ENV, THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS: "abc" });
    const config = loadConfig();

    expect(config.throttle.statusCardUpdateIntervalMs).toBe(2000);
  });

  it("falls back to default for negative throttle value", () => {
    setEnv({
      ...VALID_ENV,
      THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS: "-100",
    });
    const config = loadConfig();

    expect(config.throttle.statusCardUpdateIntervalMs).toBe(2000);
  });

  it("falls back to default for invalid dedup ttl", () => {
    setEnv({ ...VALID_ENV, FEISHU_EVENT_DEDUP_TTL_MS: "abc" });
    const config = loadConfig();

    expect(config.feishu.eventDedupTtlMs).toBe(300000);
  });

  it("falls back to default for invalid catalog cache ttl", () => {
    setEnv({ ...VALID_ENV, CONTROL_CATALOG_CACHE_TTL_MS: "abc" });
    const config = loadConfig();

    expect(config.controlCatalog.cacheTtlMs).toBe(600000);
  });

  it("reads optional FEISHU_CARD_CALLBACK_ENCRYPT_KEY in webhook mode", () => {
    setEnv({
      ...WEBHOOK_ENV,
      FEISHU_CARD_CALLBACK_ENCRYPT_KEY: "test-encrypt-key",
    });
    const config = loadConfig();

    expect(config.cardCallback!.encryptKey).toBe("test-encrypt-key");
  });

  it("normalizes connection type case-insensitively", () => {
    setEnv({ ...VALID_ENV, FEISHU_CONNECTION_TYPE: "WS" });
    expect(loadConfig().connectionType).toBe("ws");

    clearAllConfigKeys();
    setEnv({ ...WEBHOOK_ENV, FEISHU_CONNECTION_TYPE: "Webhook" });
    expect(loadConfig().connectionType).toBe("webhook");
  });
});

describe("loadConfig - validation errors", () => {
  it("throws for missing FEISHU_APP_ID", () => {
    const { FEISHU_APP_ID: _, ...without } = VALID_ENV;
    setEnv(without);

    expect(() => loadConfig()).toThrow(ConfigValidationError);
    expect(() => loadConfig()).toThrow(/FEISHU_APP_ID/);
  });

  it("throws for missing FEISHU_APP_SECRET", () => {
    const { FEISHU_APP_SECRET: _, ...without } = VALID_ENV;
    setEnv(without);

    expect(() => loadConfig()).toThrow(ConfigValidationError);
    expect(() => loadConfig()).toThrow(/FEISHU_APP_SECRET/);
  });

  it("throws for invalid FEISHU_CONNECTION_TYPE", () => {
    setEnv({ ...VALID_ENV, FEISHU_CONNECTION_TYPE: "sse" });

    expect(() => loadConfig()).toThrow(ConfigValidationError);
    expect(() => loadConfig()).toThrow(/Invalid FEISHU_CONNECTION_TYPE/);
  });

  it("throws for empty FEISHU_CONNECTION_TYPE that is not ws/webhook", () => {
    setEnv({ ...VALID_ENV, FEISHU_CONNECTION_TYPE: "  " });

    expect(() => loadConfig()).toThrow(ConfigValidationError);
  });

  it("throws for missing FEISHU_CARD_CALLBACK_URL in webhook mode", () => {
    const { FEISHU_CARD_CALLBACK_URL: _, ...without } = WEBHOOK_ENV;
    setEnv(without);

    expect(() => loadConfig()).toThrow(ConfigValidationError);
    expect(() => loadConfig()).toThrow(/FEISHU_CARD_CALLBACK_URL/);
  });

  it("throws for missing FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN in webhook mode", () => {
    const { FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN: _, ...without } =
      WEBHOOK_ENV;
    setEnv(without);

    expect(() => loadConfig()).toThrow(ConfigValidationError);
    expect(() => loadConfig()).toThrow(
      /FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN/,
    );
  });
});

describe("ConfigValidationError", () => {
  it("captures the missing variable name", () => {
    try {
      loadConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).missingVar).toBe("FEISHU_APP_ID");
      expect((err as ConfigValidationError).name).toBe("ConfigValidationError");
      return;
    }
    throw new Error("Expected ConfigValidationError");
  });
});

describe("getConfig caching", () => {
  it("returns the same instance on repeated calls", () => {
    setEnv(VALID_ENV);
    const first = getConfig();
    const second = getConfig();

    expect(first).toBe(second);
  });

  it("returns a fresh instance after resetConfig", () => {
    setEnv(VALID_ENV);
    const first = getConfig();
    resetConfig();
    const second = getConfig();

    expect(first).not.toBe(second);
    expect(second.feishu.appId).toBe("test-app-id");
  });
});
