import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createOpencodeClientMock } = vi.hoisted(() => ({
  createOpencodeClientMock: vi.fn((config: unknown) => ({
    config,
    event: { subscribe: vi.fn() },
  })),
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

const REQUIRED_ENV = {
  FEISHU_APP_ID: "test-app-id",
  FEISHU_APP_SECRET: "test-app-secret",
};

function clearEnv(): void {
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.OPENCODE_API_BASE_URL;
  delete process.env.OPENCODE_API_KEY;
}

describe("opencode client", () => {
  beforeEach(() => {
    clearEnv();
    process.env.FEISHU_APP_ID = REQUIRED_ENV.FEISHU_APP_ID;
    process.env.FEISHU_APP_SECRET = REQUIRED_ENV.FEISHU_APP_SECRET;
    createOpencodeClientMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.resetModules();
  });

  it("builds client config without Authorization when API key is absent", async () => {
    const module = await import("../../src/opencode/client.js");

    expect(
      module.buildOpenCodeClientConfig({ apiKey: "", apiUrl: "http://localhost:4096" }),
    ).toEqual({
      baseUrl: "http://localhost:4096",
      headers: undefined,
    });
  });

  it("builds client config with bearer authorization when API key is present", async () => {
    const module = await import("../../src/opencode/client.js");

    expect(
      module.buildOpenCodeClientConfig({
        apiKey: "secret-key",
        apiUrl: "http://localhost:4096",
      }),
    ).toEqual({
      baseUrl: "http://localhost:4096",
      headers: {
        Authorization: "Bearer secret-key",
      },
    });
  });

  it("creates the singleton client from environment-backed config", async () => {
    process.env.OPENCODE_API_BASE_URL = "http://opencode.example";
    process.env.OPENCODE_API_KEY = "env-key";

    const module = await import("../../src/opencode/client.js");

    expect(createOpencodeClientMock).toHaveBeenCalledTimes(1);
    expect(createOpencodeClientMock).toHaveBeenCalledWith({
      baseUrl: "http://opencode.example",
      headers: {
        Authorization: "Bearer env-key",
      },
    });
    expect(module.opencodeClient).toEqual({
      config: {
        baseUrl: "http://opencode.example",
        headers: { Authorization: "Bearer env-key" },
      },
      event: { subscribe: expect.any(Function) },
    });
  });
});
