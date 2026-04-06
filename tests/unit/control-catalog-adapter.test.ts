import { describe, expect, it, vi } from "vitest";
import { ControlCatalogAdapter } from "../../src/feishu/control-catalog.js";

function createMockSettingsManager() {
  return {
    getCurrentProject: vi.fn().mockReturnValue({
      id: "project-1",
      worktree: "/workspace/project",
      name: "Project",
    }),
    getCurrentSession: vi.fn().mockReturnValue({
      id: "session-1",
      title: "Session",
      directory: "/workspace/session",
    }),
  };
}

function createMockOpenCodeClient() {
  return {
    config: {
      providers: vi.fn().mockResolvedValue({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-4o": {},
                "gpt-4.1": {},
              },
            },
            {
              id: "anthropic",
              models: {
                "claude-3-7-sonnet": {},
              },
            },
          ],
          default: {},
        },
      }),
    },
    app: {
      agents: vi.fn().mockResolvedValue({
        data: [
          { name: "build", mode: "primary" },
          { name: "oracle", mode: "all" },
          { name: "hidden", mode: "all", hidden: true },
          { name: "subagent", mode: "subagent" },
        ],
      }),
    },
  };
}

describe("ControlCatalogAdapter", () => {
  it("loads models from OpenCode config providers", async () => {
    const settingsManager = createMockSettingsManager();
    const openCodeClient = createMockOpenCodeClient();
    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 60_000,
    });

    const models = await adapter.getAvailableModels();

    expect(models).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4.1",
      "anthropic/claude-3-7-sonnet",
    ]);
    expect(openCodeClient.config.providers).toHaveBeenCalledWith({
      directory: "/workspace/project",
    });
  });

  it("loads agents from OpenCode app catalog with hidden/mode filtering", async () => {
    const settingsManager = createMockSettingsManager();
    const openCodeClient = createMockOpenCodeClient();
    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 60_000,
    });

    const agents = await adapter.getAvailableAgents();

    expect(agents).toEqual(["build", "oracle"]);
    expect(openCodeClient.app.agents).toHaveBeenCalledWith({
      directory: "/workspace/project",
    });
  });

  it("uses session directory when project scope is not set", async () => {
    const settingsManager = createMockSettingsManager();
    settingsManager.getCurrentProject.mockReturnValue(undefined);
    const openCodeClient = createMockOpenCodeClient();
    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 60_000,
    });

    await adapter.getAvailableAgents();

    expect(openCodeClient.app.agents).toHaveBeenCalledWith({
      directory: "/workspace/session",
    });
  });

  it("reuses cache entries while ttl is valid", async () => {
    const settingsManager = createMockSettingsManager();
    const openCodeClient = createMockOpenCodeClient();
    let now = 1_000;
    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 10_000,
      now: () => now,
    });

    const first = await adapter.getAvailableModels();
    now = 5_000;
    const second = await adapter.getAvailableModels();

    expect(first).toEqual(second);
    expect(openCodeClient.config.providers).toHaveBeenCalledTimes(1);
  });

  it("falls back to stale cache when refresh fails", async () => {
    const settingsManager = createMockSettingsManager();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.config.providers
      .mockResolvedValueOnce({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-4o": {},
              },
            },
          ],
          default: {},
        },
      })
      .mockRejectedValueOnce(new Error("catalog unavailable"));

    let now = 100;
    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 500,
      now: () => now,
    });

    const first = await adapter.getAvailableModels();
    now = 1_000;
    const second = await adapter.getAvailableModels();

    expect(first).toEqual(["openai/gpt-4o"]);
    expect(second).toEqual(["openai/gpt-4o"]);
    expect(openCodeClient.config.providers).toHaveBeenCalledTimes(2);
  });

  it("keeps cache scoped to the resolved directory", async () => {
    const settingsManager = createMockSettingsManager();
    let currentDirectory = "/workspace/project-a";
    settingsManager.getCurrentProject.mockImplementation(() => ({
      id: currentDirectory,
      worktree: currentDirectory,
      name: "Project",
    }));

    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.config.providers.mockImplementation(async (parameters) => {
      const directory = parameters?.directory;
      if (directory === "/workspace/project-b") {
        return {
          data: {
            providers: [{ id: "openai", models: { "gpt-4.1": {} } }],
            default: {},
          },
        };
      }

      return {
        data: {
          providers: [{ id: "openai", models: { "gpt-4o": {} } }],
          default: {},
        },
      };
    });

    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 60_000,
      now: () => 1_000,
    });

    const firstScopeModels = await adapter.getAvailableModels();
    currentDirectory = "/workspace/project-b";
    const secondScopeModels = await adapter.getAvailableModels();

    expect(firstScopeModels).toEqual(["openai/gpt-4o"]);
    expect(secondScopeModels).toEqual(["openai/gpt-4.1"]);
    expect(openCodeClient.config.providers).toHaveBeenNthCalledWith(1, {
      directory: "/workspace/project-a",
    });
    expect(openCodeClient.config.providers).toHaveBeenNthCalledWith(2, {
      directory: "/workspace/project-b",
    });
  });

  it("prioritizes favorites/recent models from OpenCode local state when available", async () => {
    const settingsManager = createMockSettingsManager();
    const openCodeClient = createMockOpenCodeClient();
    const readFileFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        favorite: [
          { providerID: "anthropic", modelID: "claude-3-7-sonnet" },
          { providerID: "openai", modelID: "gpt-4.1" },
        ],
        recent: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "unknown", modelID: "ghost" },
        ],
      }),
    );

    const adapter = new ControlCatalogAdapter({
      settingsManager: settingsManager as never,
      openCodeClient: openCodeClient as never,
      cacheTtlMs: 60_000,
      modelStatePath: "/tmp/opencode/model.json",
      readFileFn,
    });

    const models = await adapter.getAvailableModels();

    expect(readFileFn).toHaveBeenCalledWith(
      "/tmp/opencode/model.json",
      "utf-8",
    );
    expect(models).toEqual([
      "anthropic/claude-3-7-sonnet",
      "openai/gpt-4.1",
      "openai/gpt-4o",
    ]);
  });
});
