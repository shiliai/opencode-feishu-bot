import { describe, expect, it, vi } from "vitest";
import { ControlRouter } from "../../src/feishu/control-router.js";
import type { ControlRouterOptions } from "../../src/feishu/control-router.js";

function createMockSettings() {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    setCurrentProject: vi.fn(),
    getCurrentSession: vi.fn().mockReturnValue(undefined),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
    getCurrentAgent: vi.fn().mockReturnValue(undefined),
    setCurrentAgent: vi.fn(),
    clearCurrentAgent: vi.fn(),
    getCurrentModel: vi.fn().mockReturnValue(undefined),
    setCurrentModel: vi.fn(),
    clearCurrentModel: vi.fn(),
    getStatusMessageId: vi.fn().mockReturnValue(undefined),
    setStatusMessageId: vi.fn(),
    clearStatusMessageId: vi.fn(),
    getSettingsSnapshot: vi.fn().mockReturnValue({}),
    getSettingsFilePath: vi.fn().mockReturnValue("/tmp/settings.json"),
    waitForPendingWrites: vi.fn().mockResolvedValue(undefined),
    loadSettings: vi.fn().mockResolvedValue(undefined),
    __resetSettingsForTests: vi.fn(),
    getSessionDirectoryCache: vi.fn().mockReturnValue(undefined),
    setSessionDirectoryCache: vi.fn().mockResolvedValue(undefined),
    clearSessionDirectoryCache: vi.fn(),
  };
}

function createMockSessionManager() {
  return {
    getCurrentSession: vi.fn().mockReturnValue(null),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
  };
}

function createMockRenderer() {
  return {
    sendCard: vi.fn().mockResolvedValue("msg-123"),
    sendText: vi.fn().mockResolvedValue([]),
    sendPost: vi.fn().mockResolvedValue(undefined),
    replyPost: vi.fn().mockResolvedValue(undefined),
    updateCard: vi.fn().mockResolvedValue(undefined),
    renderStatusCard: vi.fn().mockResolvedValue(undefined),
    updateStatusCard: vi.fn().mockResolvedValue(undefined),
    renderQuestionCard: vi.fn().mockResolvedValue(undefined),
    renderPermissionCard: vi.fn().mockResolvedValue(undefined),
    renderControlCard: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockOpenCodeClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "new-session-1" } }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
    app: {
      agents: vi.fn().mockResolvedValue({ data: [] }),
    },
    config: {
      providers: vi
        .fn()
        .mockResolvedValue({ data: { providers: [], default: {} } }),
    },
    project: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    global: {
      health: vi.fn().mockResolvedValue({
        data: { healthy: true, version: "1.3.17" },
      }),
    },
  };
}

function createMockInteractionManager() {
  return {
    start: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    getSnapshot: vi.fn().mockReturnValue(null),
    isActive: vi.fn().mockReturnValue(false),
    isExpired: vi.fn().mockReturnValue(false),
    transition: vi.fn(),
    clear: vi.fn(),
    startBusy: vi.fn(),
    clearBusy: vi.fn(),
    isBusy: vi.fn().mockReturnValue(false),
    getBusyState: vi.fn().mockReturnValue(null),
    resolveGuardDecision: vi.fn().mockReturnValue({ allow: true }),
  };
}

function createRouter(
  overrides?: Partial<ControlRouterOptions>,
): ControlRouter {
  const settings = createMockSettings();
  const sessionManager = createMockSessionManager();
  const renderer = createMockRenderer();
  const openCodeClient = createMockOpenCodeClient();
  const interactionManager = createMockInteractionManager();

  return new ControlRouter({
    settingsManager: settings,
    sessionManager,
    renderer,
    openCodeClient,
    interactionManager,
    ...overrides,
  });
}

describe("ControlRouter — unsupported commands", () => {
  it("unknown command /foo returns unsupported response", async () => {
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings });

    const result = await router.handleCommand("chat-1", "/foo");

    expect(result.success).toBe(false);
    expect(result.message).toBe("Unsupported command");
  });

  it("unknown command /bar returns unsupported response", async () => {
    const router = createRouter();

    const result = await router.handleCommand("chat-1", "/bar");

    expect(result.success).toBe(false);
    expect(result.message).toBe("Unsupported command");
  });

  it("unknown commands do NOT mutate settings state", async () => {
    const settings = createMockSettings();
    const sessionManager = createMockSessionManager();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({
      settingsManager: settings,
      sessionManager,
      openCodeClient,
    });

    await router.handleCommand("chat-1", "/foo");
    await router.handleCommand("chat-1", "/baz");
    await router.handleCommand("chat-1", "/random");

    expect(settings.setCurrentSession).not.toHaveBeenCalled();
    expect(settings.setCurrentModel).not.toHaveBeenCalled();
    expect(settings.setCurrentAgent).not.toHaveBeenCalled();
    expect(sessionManager.setCurrentSession).not.toHaveBeenCalled();
    expect(openCodeClient.session.create).not.toHaveBeenCalled();
    expect(openCodeClient.session.abort).not.toHaveBeenCalled();
  });

  it("empty command text returns unsupported response", async () => {
    const router = createRouter();

    const result = await router.handleCommand("chat-1", "");

    expect(result.success).toBe(false);
    expect(result.message).toBe("Unsupported command");
  });

  it("non-command text (no leading /) returns unsupported response", async () => {
    const router = createRouter();

    const result = await router.handleCommand("chat-1", "hello world");

    expect(result.success).toBe(false);
    expect(result.message).toBe("Unsupported command");
  });

  it("whitespace-only text returns unsupported response", async () => {
    const router = createRouter();

    const result = await router.handleCommand("chat-1", "   ");

    expect(result.success).toBe(false);
  });

  it("parseCommand returns null for unknown commands", () => {
    const router = createRouter();

    expect(router.parseCommand("/unknown")).toBeNull();
    expect(router.parseCommand("/delete")).toBeNull();
    expect(router.parseCommand("/reset")).toBeNull();
    expect(router.parseCommand("help")).toBeNull();
    expect(router.parseCommand("")).toBeNull();
    expect(router.parseCommand("   ")).toBeNull();
    expect(router.parseCommand("random text")).toBeNull();
  });

  it("parseCommand returns null for commands outside bounded set", () => {
    const router = createRouter();
    const extraCommands = [
      "/login",
      "/logout",
      "/config",
      "/debug",
      "/restart",
      "/version",
    ];

    for (const cmd of extraCommands) {
      expect(router.parseCommand(cmd)).toBeNull();
    }
  });

  it("parseCommand normalizes /models to /model", () => {
    const router = createRouter();

    expect(router.parseCommand("/models")).toEqual({ command: "/model" });
    expect(router.parseCommand("/models gpt-5.4")).toEqual({
      command: "/model",
      args: "gpt-5.4",
    });
  });

  it("parseCommand accepts slash commands with leading mention wrappers", () => {
    const router = createRouter();

    expect(router.parseCommand("@_user_1 /history")).toEqual({
      command: "/history",
    });
    expect(
      router.parseCommand('<at user_id="ou_bot">OpenCode Bot</at> /history 20'),
    ).toEqual({ command: "/history", args: "20" });
    expect(router.parseCommand("@OpenCode Bot/history")).toEqual({
      command: "/history",
    });
    expect(router.parseCommand("\u200b/history")).toEqual({
      command: "/history",
    });
  });

  it("parseCommand accepts /projects with and without args", () => {
    const router = createRouter();

    expect(router.parseCommand("/projects")).toEqual({
      command: "/projects",
    });
    expect(router.parseCommand("/projects project-1")).toEqual({
      command: "/projects",
      args: "project-1",
    });
  });
});
