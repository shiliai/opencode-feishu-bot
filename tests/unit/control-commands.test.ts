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
      list: vi
        .fn()
        .mockResolvedValue({ data: [{ id: "sess-1", title: "Test Session" }] }),
      status: vi
        .fn()
        .mockResolvedValue({ data: { "sess-1": { type: "idle" } } }),
      abort: vi.fn().mockResolvedValue({ data: true }),
    },
    app: {
      agents: vi.fn().mockResolvedValue({
        data: [{ name: "build", mode: "primary" }],
      }),
    },
    config: {
      providers: vi.fn().mockResolvedValue({
        data: {
          providers: [{ id: "openai", models: { "gpt-4": {} } }],
          default: {},
        },
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

describe("ControlRouter — command dispatch", () => {
  it("/help renders help card", async () => {
    const renderer = createMockRenderer();
    const router = createRouter({ renderer });

    const result = await router.handleCommand("chat-1", "/help");

    expect(result.success).toBe(true);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("OpenCode Commands");
  });

  it("/new creates session and updates settings", async () => {
    const settings = createMockSettings();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ settingsManager: settings, openCodeClient });

    const result = await router.handleCommand("chat-1", "/new");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.create).toHaveBeenCalledWith({});
    expect(settings.setCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-session-1" }),
    );
  });

  it("/new returns failure when session creation returns no data", async () => {
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.session.create.mockResolvedValue({ data: undefined });
    const router = createRouter({ openCodeClient });

    const result = await router.handleCommand("chat-1", "/new");

    expect(result.success).toBe(false);
  });

  it("/sessions lists sessions as a card", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/sessions");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.list).toHaveBeenCalledWith({});
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Sessions");
  });

  it("/session <id> switches to specified session", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.getCurrentSession.mockReturnValue({
      id: "old-session",
      title: "Old",
      directory: "/workspace",
    });
    const router = createRouter({ sessionManager });

    const result = await router.handleCommand("chat-1", "/session sess-42");

    expect(result.success).toBe(true);
    expect(result.message).toContain("sess-42");
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sess-42" }),
    );
  });

  it("/model <name> updates model in settings", async () => {
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings });

    const result = await router.handleCommand("chat-1", "/model gpt-4");

    expect(result.success).toBe(true);
    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4",
    });
  });

  it("/model <provider/model> stores provider and model separately", async () => {
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings });

    const result = await router.handleCommand(
      "chat-1",
      "/model openai/gpt-4.1",
    );

    expect(result.success).toBe(true);
    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
  });

  it("/model <name> returns failure when bare model name is ambiguous", async () => {
    const settings = createMockSettings();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.config.providers.mockResolvedValue({
      data: {
        providers: [
          { id: "openai", models: { "gpt-4o": {} } },
          { id: "anthropic", models: { "gpt-4o": {} } },
        ],
        default: {},
      },
    });

    const router = createRouter({ settingsManager: settings, openCodeClient });
    const result = await router.handleCommand("chat-1", "/model gpt-4o");

    expect(result.success).toBe(false);
    expect(result.message).toContain("provider/model");
    expect(settings.setCurrentModel).not.toHaveBeenCalled();
  });

  it("/model <name> returns failure when bare model name is unknown", async () => {
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings });

    const result = await router.handleCommand("chat-1", "/model not-real");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown model");
    expect(settings.setCurrentModel).not.toHaveBeenCalled();
  });

  it("/agent <name> updates agent in settings", async () => {
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings });

    const result = await router.handleCommand("chat-1", "/agent build");

    expect(result.success).toBe(true);
    expect(settings.setCurrentAgent).toHaveBeenCalledWith("build");
  });

  it("/status renders current status card", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    settings.getCurrentModel.mockReturnValue({
      providerID: "openai",
      modelID: "gpt-4",
    });
    settings.getCurrentAgent.mockReturnValue("build");
    const sessionManager = createMockSessionManager();
    sessionManager.getCurrentSession.mockReturnValue({
      id: "sess-1",
      title: "Test",
      directory: "/workspace",
    });
    const router = createRouter({
      renderer,
      settingsManager: settings,
      sessionManager,
    });

    const result = await router.handleCommand("chat-1", "/status");

    expect(result.success).toBe(true);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("OpenCode Status");
  });

  it("/abort aborts current session", async () => {
    const openCodeClient = createMockOpenCodeClient();
    const sessionManager = createMockSessionManager();
    sessionManager.getCurrentSession.mockReturnValue({
      id: "sess-1",
      title: "Test",
      directory: "/workspace",
    });
    const interactionManager = createMockInteractionManager();
    const router = createRouter({
      openCodeClient,
      sessionManager,
      interactionManager,
    });

    const result = await router.handleCommand("chat-1", "/abort");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.abort).toHaveBeenCalledWith({
      sessionID: "sess-1",
    });
    expect(interactionManager.clearBusy).toHaveBeenCalledTimes(1);
  });

  it("/abort returns failure when no active session", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.getCurrentSession.mockReturnValue(null);
    const router = createRouter({ sessionManager });

    const result = await router.handleCommand("chat-1", "/abort");

    expect(result.success).toBe(false);
    expect(result.message).toContain("No active session");
  });

  it("/status shows busy state when interaction manager is busy", async () => {
    const renderer = createMockRenderer();
    const interactionManager = createMockInteractionManager();
    interactionManager.isBusy.mockReturnValue(true);
    const router = createRouter({ renderer, interactionManager });

    const result = await router.handleCommand("chat-1", "/status");

    expect(result.success).toBe(true);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    const markdownEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("busy");
  });
});
