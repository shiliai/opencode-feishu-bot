import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { providersMock, mockLogger } = vi.hoisted(() => ({
  providersMock: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: {
      providers: providersMock,
    },
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: mockLogger,
}));

async function loadContextLimitModule() {
  vi.resetModules();
  return import("../../src/model/context-limit.js");
}

describe("getModelContextLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T00:00:00.000Z"));
    providersMock.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the default limit when provider or model is missing", async () => {
    const { getModelContextLimit } = await loadContextLimitModule();

    await expect(getModelContextLimit(null, "gpt-5")).resolves.toBe(200_000);
    await expect(getModelContextLimit("openai", null)).resolves.toBe(200_000);
    expect(providersMock).not.toHaveBeenCalled();
  });

  it("fetches and caches model limits from provider config", async () => {
    providersMock.mockResolvedValue({
      data: {
        providers: [
          {
            id: "openai",
            models: {
              "gpt-5": {
                limit: { context: 400_000 },
              },
            },
          },
        ],
      },
      error: undefined,
    });
    const { getModelContextLimit } = await loadContextLimitModule();

    await expect(getModelContextLimit("openai", "gpt-5")).resolves.toBe(
      400_000,
    );
    await expect(getModelContextLimit("openai", "gpt-5")).resolves.toBe(
      400_000,
    );
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the cache after the ttl expires for uncached models", async () => {
    providersMock
      .mockResolvedValueOnce({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-5": {
                  limit: { context: 400_000 },
                },
              },
            },
          ],
        },
        error: undefined,
      })
      .mockResolvedValueOnce({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-5": {
                  limit: { context: 400_000 },
                },
                "gpt-5-mini": {
                  limit: { context: 500_000 },
                },
              },
            },
          ],
        },
        error: undefined,
      });
    const { getModelContextLimit } = await loadContextLimitModule();

    await expect(getModelContextLimit("openai", "gpt-5")).resolves.toBe(
      400_000,
    );
    expect(providersMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-04-08T00:11:00.000Z"));
    await expect(getModelContextLimit("openai", "gpt-5-mini")).resolves.toBe(
      500_000,
    );
    expect(providersMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default limit when the model is unavailable", async () => {
    providersMock.mockResolvedValue({
      data: {
        providers: [
          {
            id: "anthropic",
            models: {
              claude: {
                limit: { context: 200_000 },
              },
            },
          },
        ],
      },
      error: undefined,
    });
    const { getModelContextLimit } = await loadContextLimitModule();

    await expect(getModelContextLimit("openai", "gpt-5")).resolves.toBe(
      200_000,
    );
    expect(providersMock).toHaveBeenCalledTimes(1);
  });
});
