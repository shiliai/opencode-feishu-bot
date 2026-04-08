import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import {
  createFeishuClients,
  type FeishuClients,
} from "../../src/feishu/sdk.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    opencode: { apiUrl: "http://localhost:4096", apiKey: "" },
    workdir: null,
    feishu: {
      appId: "test-app-id",
      appSecret: "test-app-secret",
      botOpenId: "",
      eventDedupTtlMs: 300000,
      eventDedupPersistPath: ".data/event-dedup.json",
    },
    connectionType: "ws",
    cardCallback: null,
    throttle: {
      statusCardUpdateIntervalMs: 2000,
      statusCardPatchRetryDelayMs: 500,
      statusCardPatchMaxAttempts: 3,
    },
    controlCatalog: {
      cacheTtlMs: 600000,
      modelStatePath: "~/.local/state/opencode/model.json",
    },
    service: { port: 3000, host: "0.0.0.0" },
    logLevel: "info",
    assistantName: "OpenCode",
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
      feishu: {
        appId: "my-id",
        appSecret: "my-secret",
        botOpenId: "",
        eventDedupTtlMs: 300000,
        eventDedupPersistPath: ".data/event-dedup.json",
      },
    });
    const clients = createFeishuClients(config);

    expect(clients.client).toBeDefined();
    expect(clients.client.tokenManager).toBeDefined();
  });
});
