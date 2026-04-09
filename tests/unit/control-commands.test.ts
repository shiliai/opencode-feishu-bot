import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlRouter,
  type ControlRouterOptions,
} from "../../src/feishu/control-router.js";
import { StatusStore } from "../../src/feishu/status-store.js";

const { getModelContextLimitMock, scanWorkdirSubdirsMock } = vi.hoisted(() => ({
  getModelContextLimitMock: vi.fn(),
  scanWorkdirSubdirsMock: vi.fn(),
}));

vi.mock("../../src/model/context-limit.js", () => ({
  getModelContextLimit: getModelContextLimitMock,
}));

vi.mock("../../src/feishu/workdir-scanner.js", () => ({
  scanWorkdirSubdirs: scanWorkdirSubdirsMock,
}));

function createMockSettings() {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    setCurrentProject: vi.fn(),
    getChatSession: vi.fn().mockReturnValue(undefined),
    setChatSession: vi.fn(),
    clearChatSession: vi.fn(),
    getCurrentSession: vi.fn().mockReturnValue(undefined),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
    getCurrentAgent: vi.fn().mockReturnValue(undefined),
    setCurrentAgent: vi.fn(),
    clearCurrentAgent: vi.fn(),
    getCurrentModel: vi.fn().mockReturnValue(undefined),
    setCurrentModel: vi.fn(),
    clearCurrentModel: vi.fn(),
    getChatStatusMessageId: vi.fn().mockReturnValue(undefined),
    setChatStatusMessageId: vi.fn(),
    clearChatStatusMessageId: vi.fn(),
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
    getChatSession: vi.fn().mockReturnValue(undefined),
    setChatSession: vi.fn(),
    clearChatSession: vi.fn(),
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
      create: vi.fn().mockResolvedValue({
        data: {
          id: "new-session-1",
          title: "New Session",
          directory: "/workspace/project",
        },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          id: "sess-42",
          title: "Target Session",
          directory: "/workspace/project",
        },
        error: undefined,
      }),
      list: vi
        .fn()
        .mockResolvedValue({ data: [{ id: "sess-1", title: "Test Session" }] }),
      status: vi
        .fn()
        .mockResolvedValue({ data: { "sess-1": { type: "idle" } } }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      prompt: vi.fn().mockResolvedValue(undefined),
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
    project: {
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: "project-1",
            worktree: "/workspace/project-1",
            name: "Project One",
          },
          {
            id: "project-2",
            worktree: "/workspace/project-2",
            name: "Project Two",
          },
        ],
      }),
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
    clearAll: vi.fn(),
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

beforeEach(() => {
  getModelContextLimitMock.mockReset();
  getModelContextLimitMock.mockResolvedValue(400_000);
  scanWorkdirSubdirsMock.mockReset();
  scanWorkdirSubdirsMock.mockResolvedValue([]);
});

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

  it("/version sends version as text", async () => {
    const renderer = createMockRenderer();
    renderer.sendText.mockResolvedValue(["msg-version-1"]);
    const router = createRouter({ renderer });

    const result = await router.handleCommand("chat-1", "/version");

    expect(result.success).toBe(true);
    expect(result.cardMessageId).toBe("msg-version-1");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringMatching(/^opencode-feishu-bridge v/),
    );
  });

  it("/new sends confirmation card instead of creating session immediately", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/new");

    expect(result.success).toBe(true);
    expect(result.cardMessageId).toBe("msg-123");
    expect(result.message).toBe("Confirmation required");
    expect(openCodeClient.session.create).not.toHaveBeenCalled();
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("⚠️ Confirmation Required");
  });

  it("/new confirmation card has confirm and cancel buttons", async () => {
    const renderer = createMockRenderer();
    const router = createRouter({ renderer });

    await router.handleCommand("chat-1", "/new");

    const sentCard = renderer.sendCard.mock.calls[0][1];
    const actionEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    expect(actionEl).toBeDefined();
    const actions = actionEl.actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].text.content).toBe("✅ Confirm");
    expect(actions[0].type).toBe("primary");
    expect(actions[0].value).toEqual({
      action: "confirm_write",
      operationId: "create_new_session",
    });
    expect(actions[1].text.content).toBe("❌ Cancel");
    expect(actions[1].type).toBe("danger");
    expect(actions[1].value).toEqual({
      action: "reject_write",
      operationId: "create_new_session",
    });
  });

  it("/new creates session immediately when card callbacks are disabled", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const settings = createMockSettings();
    const sessionManager = createMockSessionManager();
    const router = createRouter({
      renderer,
      openCodeClient,
      settingsManager: settings,
      sessionManager,
      cardActionsEnabled: false,
    });

    const result = await router.handleCommand("chat-1", "/new");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.create).toHaveBeenCalledWith({
      directory: process.cwd(),
    });
    expect(renderer.sendCard).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "New session selected: New Session (new-session-1)",
    );
    expect(sessionManager.setChatSession).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ id: "new-session-1" }),
    );
  });

  it("/new sends fallback text when confirmation card send fails", async () => {
    const renderer = createMockRenderer();
    renderer.sendCard.mockRejectedValueOnce(new Error("card send failed"));
    const router = createRouter({ renderer });

    const result = await router.handleCommand("chat-1", "/new");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to send confirmation card");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Failed to send confirmation card. Please try again.",
    );
  });

  it("/sessions lists sessions as a card", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/sessions");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.list).toHaveBeenCalledWith({
      directory: process.cwd(),
      roots: true,
    });
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Sessions");
  });

  it("/projects without args renders project picker card", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/projects");

    expect(result.success).toBe(true);
    expect(openCodeClient.project.list).toHaveBeenCalledTimes(1);
    expect(scanWorkdirSubdirsMock).not.toHaveBeenCalled();
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Projects");
    const actionEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "project",
      context: undefined,
      value: "project-1",
    });
  });

  it("/projects with workdir configured shows merged known and new entries", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    scanWorkdirSubdirsMock.mockResolvedValue([
      {
        name: "project-1",
        absolutePath: "/workspace/project-1",
      },
      {
        name: "project-3",
        absolutePath: "/workspace/project-3",
      },
    ]);
    const router = createRouter({
      renderer,
      openCodeClient,
      workdir: "/workspace",
      logger,
    });

    const result = await router.handleCommand("chat-1", "/projects");

    expect(result.success).toBe(true);
    expect(scanWorkdirSubdirsMock).toHaveBeenCalledWith("/workspace", logger);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    const actionEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as {
        actions: Array<{
          text: { content: string };
          value: Record<string, unknown>;
        }>;
      }
    ).actions;
    expect(actions.map((action) => action.value)).toEqual([
      {
        action: "selection_pick",
        command: "project",
        context: undefined,
        value: "project-1",
      },
      {
        action: "selection_pick",
        command: "project",
        context: undefined,
        value: "/workspace/project-3",
      },
      {
        action: "selection_pick",
        command: "project",
        context: undefined,
        value: "project-2",
      },
    ]);
    const markdownContent = sentCard.elements
      .filter((el: { tag: string }) => el.tag === "markdown")
      .map((el: { content: string }) => el.content)
      .join("\n");
    expect(markdownContent).toContain("✨ New");
  });

  it("/task without args shows usage guide, /tasklist shows empty message", async () => {
    const renderer = createMockRenderer();
    const router = createRouter({ renderer });

    const taskResult = await router.handleCommand("chat-1", "/task");
    expect(taskResult.success).toBe(false);
    expect(taskResult.message).toContain("Scheduled Task — Usage");

    const tasklistResult = await router.handleCommand("chat-1", "/tasklist");
    expect(tasklistResult.success).toBe(true);
    expect(tasklistResult.message).toContain("No scheduled tasks");
  });

  it("/project alias renders the same picker as /projects", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/project");

    expect(result.success).toBe(true);
    expect(openCodeClient.project.list).toHaveBeenCalledTimes(1);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Projects");
  });

  it("/projects <id> switches project and clears session", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const settings = createMockSettings();
    const sessionManager = createMockSessionManager();
    const router = createRouter({
      renderer,
      openCodeClient,
      settingsManager: settings,
      sessionManager,
    });

    const result = await router.handleCommand("chat-1", "/projects project-2");

    expect(result.success).toBe(true);
    expect(settings.setCurrentProject).toHaveBeenCalledWith({
      id: "project-2",
      worktree: "/workspace/project-2",
      name: "Project Two",
    });
    expect(sessionManager.clearChatSession).toHaveBeenCalledWith("chat-1");
    expect(settings.clearChatStatusMessageId).toHaveBeenCalledWith("chat-1");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Project selected:"),
    );
  });

  it("/projects falls back to text list when card callbacks are disabled", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({
      renderer,
      openCodeClient,
      cardActionsEnabled: false,
    });

    const result = await router.handleCommand("chat-1", "/projects");

    expect(result.success).toBe(true);
    expect(renderer.sendCard).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Use /projects <id>"),
    );
  });

  it("discover_project card action triggers auto-discovery and stores the directory", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const sessionManager = createMockSessionManager();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.session.create.mockResolvedValue({
      data: {
        id: "new-session-3",
        title: "Project Three Session",
        directory: "/workspace/project-3",
      },
      error: undefined,
    });
    const router = createRouter({
      settingsManager: settings,
      sessionManager,
      renderer,
      openCodeClient,
      workdir: "/workspace",
    });

    const result = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: {
          action: "discover_project",
          directory: "/workspace/project-3",
        },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "success",
        content:
          "Project discovered: project-3\n\nActive session cleared. Use /sessions or /new for this project.",
      },
    });
    expect(openCodeClient.session.create).toHaveBeenCalledWith({
      directory: "/workspace/project-3",
    });
    expect(settings.setCurrentProject).toHaveBeenCalledWith({
      id: "discovered",
      worktree: "/workspace/project-3",
      name: "project-3",
    });
    expect(sessionManager.clearChatSession).toHaveBeenCalledWith("chat-1");
    expect(settings.clearChatStatusMessageId).toHaveBeenCalledWith("chat-1");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Project discovered: project-3"),
    );
  });

  it("discover_project rejects relative paths from card payloads", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({
      renderer,
      openCodeClient,
      workdir: "/workspace",
    });

    const result = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: {
          action: "discover_project",
          directory: "project-3",
        },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "error",
        content: "Project discovery requires an absolute path.",
      },
    });
    expect(openCodeClient.session.create).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Project discovery requires an absolute path.",
    );
  });

  it("discover_project rejects directories outside the immediate workdir children", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({
      renderer,
      openCodeClient,
      workdir: "/workspace",
    });

    const result = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: {
          action: "discover_project",
          directory: "/workspace/team/project-3",
        },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "error",
        content:
          "Project discovery is limited to immediate subdirectories of /workspace.",
      },
    });
    expect(openCodeClient.session.create).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Project discovery is limited to immediate subdirectories of /workspace.",
    );
  });

  it("/session <id> switches to specified session", async () => {
    const renderer = createMockRenderer();
    const sessionManager = createMockSessionManager();
    sessionManager.getChatSession.mockReturnValue({
      id: "old-session",
      title: "Old",
      directory: "/workspace",
    });
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.session.get.mockResolvedValue({
      data: { id: "sess-42", title: "Target Session", directory: "/workspace" },
      error: undefined,
    });
    const router = createRouter({ sessionManager, renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/session sess-42");

    expect(result.success).toBe(true);
    expect(result.message).toContain("sess-42");
    expect(openCodeClient.session.get).toHaveBeenCalledWith({
      sessionID: "sess-42",
      directory: "/workspace",
    });
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Session selected:"),
    );
    expect(sessionManager.setChatSession).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ id: "sess-42" }),
    );
  });

  it("/model <name> updates model in settings", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const result = await router.handleCommand("chat-1", "/model gpt-4");

    expect(result.success).toBe(true);
    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4",
    });
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Model selected: openai/gpt-4",
    );
  });

  it("/models alias renders the same picker as /model", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/models");

    expect(result.success).toBe(true);
    expect(openCodeClient.config.providers).toHaveBeenCalledTimes(1);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Model Picker");
  });

  it("/model <provider/model> stores provider and model separately", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const result = await router.handleCommand(
      "chat-1",
      "/model openai/gpt-4.1",
    );

    expect(result.success).toBe(true);
    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Model selected: openai/gpt-4.1",
    );
  });

  it("/model <name> returns failure when bare model name is ambiguous", async () => {
    const renderer = createMockRenderer();
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

    const router = createRouter({
      settingsManager: settings,
      openCodeClient,
      renderer,
    });
    const result = await router.handleCommand("chat-1", "/model gpt-4o");

    expect(result.success).toBe(false);
    expect(result.message).toContain("provider/model");
    expect(settings.setCurrentModel).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("provider/model"),
    );
  });

  it("/model <name> returns failure when bare model name is unknown", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const result = await router.handleCommand("chat-1", "/model not-real");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown model");
    expect(settings.setCurrentModel).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Unknown model"),
    );
  });

  it("/agent <name> updates agent in settings", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const result = await router.handleCommand("chat-1", "/agent build");

    expect(result.success).toBe(true);
    expect(settings.setCurrentAgent).toHaveBeenCalledWith("build");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Agent selected: build",
    );
  });

  it("/agent <name> returns failure when agent is unknown", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.app.agents.mockResolvedValue({
      data: [{ name: "oracle", mode: "all" }],
    });
    const router = createRouter({
      settingsManager: settings,
      renderer,
      openCodeClient,
    });

    const result = await router.handleCommand("chat-1", "/agent build");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown agent");
    expect(settings.setCurrentAgent).not.toHaveBeenCalled();
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Unknown agent"),
    );
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
    sessionManager.getChatSession.mockReturnValue({
      id: "sess-1",
      title: "Test",
      directory: "/workspace",
    });
    const statusStore = new StatusStore();
    statusStore.startTurn({
      sessionId: "sess-1",
      directory: "/workspace",
      receiveId: "chat-1",
      sourceMessageId: "source-1",
    });
    statusStore.update("sess-1", (state) => {
      state.latestTokens = {
        input: 120_000,
        output: 0,
        reasoning: 0,
        cacheRead: 31_000,
        cacheWrite: 0,
      };
    });
    const router = createRouter({
      renderer,
      settingsManager: settings,
      sessionManager,
      statusStore,
    });

    const result = await router.handleCommand("chat-1", "/status");

    expect(result.success).toBe(true);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("OpenCode Status");
    const markdownEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("**Context**: 151K/400K (38%)");
  });

  it("/status prefers current model and agent from the OpenCode session API", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    settings.getCurrentModel.mockReturnValue(undefined);
    settings.getCurrentAgent.mockReturnValue(undefined);
    settings.getCurrentProject.mockReturnValue({
      id: "project-1",
      worktree: "/workspace/project-1",
      name: "Project One",
    });
    const sessionManager = createMockSessionManager();
    sessionManager.getChatSession.mockReturnValue({
      id: "sess-1",
      title: "Test",
      directory: "/workspace/project-1",
    });
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            role: "assistant",
            providerID: "relay-gpt-sub",
            modelID: "gpt-5.4",
            agent: "oracle",
            tokens: {
              input: 120_000,
              cache: {
                read: 31_000,
              },
            },
          },
        },
      ],
    });

    const router = createRouter({
      renderer,
      settingsManager: settings,
      sessionManager,
      openCodeClient,
    });

    const result = await router.handleCommand("chat-1", "/status");

    expect(result.success).toBe(true);
    expect(openCodeClient.global.health).toHaveBeenCalledTimes(1);
    expect(openCodeClient.session.messages).toHaveBeenCalledWith({
      sessionID: "sess-1",
      directory: "/workspace/project-1",
      limit: 50,
    });
    expect(getModelContextLimitMock).toHaveBeenCalledWith(
      "relay-gpt-sub",
      "gpt-5.4",
    );
    const sentCard = renderer.sendCard.mock.calls[0][1];
    const markdownEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("**Server**: healthy");
    expect(markdownEl.content).toContain("**Version**: 1.3.17");
    expect(markdownEl.content).toContain("**Project**: Project One");
    expect(markdownEl.content).toContain("**Scope**: /workspace/project-1");
    expect(markdownEl.content).toContain("**Model**: relay-gpt-sub/gpt-5.4");
    expect(markdownEl.content).toContain("**Agent**: oracle");
    expect(markdownEl.content).toContain("**Context**: 151K/400K (38%)");
  });

  it("/status preserves explicitly selected model and agent overrides", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    settings.getCurrentModel.mockReturnValue({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
    settings.getCurrentAgent.mockReturnValue("build");
    const sessionManager = createMockSessionManager();
    sessionManager.getChatSession.mockReturnValue({
      id: "sess-1",
      title: "Test",
      directory: "/workspace/project-1",
    });
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            providerID: "relay-gpt-sub",
            modelID: "gpt-5.4",
            agent: "oracle",
          },
        },
      ],
    });

    const router = createRouter({
      renderer,
      settingsManager: settings,
      sessionManager,
      openCodeClient,
    });

    const result = await router.handleCommand("chat-1", "/status");

    expect(result.success).toBe(true);
    const sentCard = renderer.sendCard.mock.calls[0][1];
    const markdownEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("**Model**: openai/gpt-4.1");
    expect(markdownEl.content).toContain("**Agent**: build");
  });

  it("/abort aborts current session", async () => {
    const openCodeClient = createMockOpenCodeClient();
    const settings = createMockSettings();
    const sessionManager = createMockSessionManager();
    sessionManager.getChatSession.mockReturnValue({
      id: "sess-1",
      title: "Test",
      directory: "/workspace",
    });
    const interactionManager = createMockInteractionManager();
    const renderer = createMockRenderer();
    const router = createRouter({
      openCodeClient,
      settingsManager: settings,
      sessionManager,
      renderer,
      interactionManager,
    });

    const result = await router.handleCommand("chat-1", "/abort");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.abort).toHaveBeenCalledWith({
      sessionID: "sess-1",
    });
    expect(settings.clearChatStatusMessageId).toHaveBeenCalledWith("chat-1");
    expect(interactionManager.clearBusy).toHaveBeenCalledWith("chat-1");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "✅ 已取消当前操作",
    );
  });

  it("/abort returns failure when no active session", async () => {
    const renderer = createMockRenderer();
    const sessionManager = createMockSessionManager();
    sessionManager.getChatSession.mockReturnValue(undefined);
    const router = createRouter({ renderer, sessionManager });

    const result = await router.handleCommand("chat-1", "/abort");

    expect(result.success).toBe(false);
    expect(result.message).toContain("No active session");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "没有活跃的会话可以取消",
    );
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
