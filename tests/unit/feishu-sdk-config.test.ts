import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { createFeishuClients, type FeishuClients } from "../../src/feishu/sdk.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    opencode: { apiUrl: "http://localhost:4096", apiKey: "" },
    feishu: { appId: "test-app-id", appSecret: "test-app-secret", eventDedupTtlMs: 300000 },
    connectionType: "ws",
    cardCallback: null,
    throttle: { statusCardUpdateIntervalMs: 2000 },
    service: { port: 3000, host: "0.0.0.0" },
    logLevel: "info",
    ...overrides,
  };
}

const WEBHOOK_CONFIG = makeConfig({
  connectionType: "webhook",
  cardCallback: {
    callbackUrl: "https://example.com/webhook/card",
    verificationToken: "test-token",
    encryptKey: "",
  },
});

describe("createFeishuClients", () => {
  it("returns client, wsClient, and null cardActionHandler in ws mode", () => {
    const clients: FeishuClients = createFeishuClients(makeConfig());

    expect(clients.client).toBeDefined();
    expect(clients.wsClient).toBeDefined();
    expect(clients.cardActionHandler).toBeNull();
  });

  it("returns cardActionHandler in webhook mode", () => {
    const clients: FeishuClients = createFeishuClients(WEBHOOK_CONFIG);

    expect(clients.client).toBeDefined();
    expect(clients.wsClient).toBeDefined();
    expect(clients.cardActionHandler).not.toBeNull();
  });

  it("returns cardActionHandler in ws mode when card callback config is present", () => {
    const clients = createFeishuClients(
      makeConfig({
        cardCallback: {
          callbackUrl: "https://example.com/webhook/card",
          verificationToken: "test-token",
          encryptKey: "",
        },
      }),
    );

    expect(clients.cardActionHandler).not.toBeNull();
  });

  it("accepts a custom card handler function", () => {
    const handler = () => Promise.resolve({ code: 0 });
    const clients = createFeishuClients(WEBHOOK_CONFIG, handler as never);

    expect(clients.cardActionHandler).not.toBeNull();
  });

  it("creates client with correct appId and appSecret", () => {
    const config = makeConfig({
      feishu: { appId: "my-id", appSecret: "my-secret" },
    });
    const clients = createFeishuClients(config);

    expect(clients.client).toBeDefined();
    expect(clients.client.tokenManager).toBeDefined();
  });
});
