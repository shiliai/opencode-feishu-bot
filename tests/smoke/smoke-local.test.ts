import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CONFIG_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
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
  "THROTTLE_STATUS_CARD_PATCH_RETRY_DELAY_MS",
  "THROTTLE_STATUS_CARD_PATCH_MAX_ATTEMPTS",
  "FEISHU_EVENT_DEDUP_TTL_MS",
];

function clearAllConfigKeys(): void {
  for (const key of CONFIG_KEYS) {
    delete process.env[key];
  }
}

function fetchHealthz(port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const http = require("node:http");
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: 2000 },
      (res: { statusCode: number; on: (ev: string, cb: (chunk?: Buffer) => void) => void }) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => { resolve({ statusCode: res.statusCode, body }); });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn().mockReturnValue({
    im: {
      message: { create: vi.fn().mockResolvedValue({ data: { message_id: "mock" } }) },
      resource: { get: vi.fn() },
      file: { create: vi.fn() },
    },
  }),
  WSClient: vi.fn().mockReturnValue({
    start: vi.fn().mockResolvedValue(undefined),
  }),
  EventDispatcher: vi.fn().mockReturnValue({
    register: vi.fn().mockReturnValue({}),
  }),
  CardActionHandler: vi.fn(),
  adaptDefault: vi.fn(),
  Domain: { Feishu: "Feishu" },
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn().mockReturnValue({
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "mock-session" } }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      abort: vi.fn().mockResolvedValue({ data: {} }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
    },
    question: {
      reply: vi.fn().mockResolvedValue(undefined),
    },
    permission: {
      reply: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

describe("smoke:local — healthz and graceful shutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearAllConfigKeys();

    process.env.FEISHU_APP_ID = "smoke-test-app-id";
    process.env.FEISHU_APP_SECRET = "smoke-test-secret";
    process.env.FEISHU_CONNECTION_TYPE = "ws";
    process.env.SERVICE_PORT = "39876";
    process.env.SERVICE_HOST = "127.0.0.1";
    process.env.OPENCODE_API_BASE_URL = "http://localhost:19999";
    process.env.LOG_LEVEL = "error";

    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    clearAllConfigKeys();
  });

  it("starts HTTP server, responds to /healthz with 200, and shuts down on SIGTERM", async () => {
    const { startFeishuApp, getActualServicePort } = await import("../../src/app/start-feishu-app.js");

    await startFeishuApp();

    const port = getActualServicePort();
    expect(port).not.toBeNull();
    expect(port!).toBeGreaterThan(0);

    const response = await fetchHealthz(port!);
    expect(response.statusCode).toBe(200);

    const parsed = JSON.parse(response.body);
    expect(parsed.status).toBe("ok");

    process.kill(process.pid, "SIGTERM");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 10000);
});
