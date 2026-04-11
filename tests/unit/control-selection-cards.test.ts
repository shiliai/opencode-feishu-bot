import { describe, expect, it, vi } from "vitest";
import {
  buildAgentPickerCard,
  buildModelListCard,
  buildModelPickerCard,
  buildModelProviderCard,
  buildProjectPickerCard,
  buildSessionListCard,
} from "../../src/feishu/control-cards.js";
import {
  ControlRouter,
  type ControlRouterOptions,
} from "../../src/feishu/control-router.js";

function createMockSettings() {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    setCurrentProject: vi.fn(),
    getCurrentSession: vi.fn().mockReturnValue(undefined),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
    getCurrentAgent: vi.fn().mockReturnValue("build"),
    setCurrentAgent: vi.fn(),
    clearCurrentAgent: vi.fn(),
    getCurrentModel: vi
      .fn()
      .mockReturnValue({ providerID: "openai", modelID: "gpt-4" }),
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
    getChatSession: vi.fn().mockReturnValue(undefined),
    setChatSession: vi.fn(),
    clearChatSession: vi.fn(),
    clearChatStatusMessageId: vi.fn(),
  };
}

function createMockSessionManager() {
  return {
    getCurrentSession: vi.fn().mockReturnValue(null),
    setCurrentSession: vi.fn(),
    clearSession: vi.fn(),
    getChatSession: vi.fn().mockReturnValue(undefined),
    setChatSession: vi.fn(),
    clearChatSession: vi.fn(),
  };
}

function createMockRenderer() {
  return {
    sendCard: vi.fn().mockResolvedValue("msg-123"),
    sendText: vi.fn().mockResolvedValue([]),
    updateCompleteCard: vi.fn().mockResolvedValue(undefined),
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
        error: undefined,
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
        .mockResolvedValue({ data: [{ id: "sess-1", title: "Test" }] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      prompt: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      agents: vi.fn().mockResolvedValue({
        data: [
          { name: "build", mode: "primary" },
          { name: "oracle", mode: "all" },
        ],
      }),
    },
    config: {
      providers: vi.fn().mockResolvedValue({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-4": {},
                "gpt-4.1": {},
              },
            },
          ],
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

describe("ControlRouter — selection cards (no args)", () => {
  it("/session without args renders session list card", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/session");

    expect(result.success).toBe(true);
    expect(openCodeClient.session.list).toHaveBeenCalledWith({
      directory: process.cwd(),
      roots: true,
    });
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);

    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Sessions");
  });

  it("/model without args renders model picker card", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/model");

    expect(result.success).toBe(true);
    expect(openCodeClient.config.providers).toHaveBeenCalledTimes(1);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);

    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Model Picker");
    const actionEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "model",
      context: { level: "provider" },
      value: "openai",
    });
  });

  it("/agent without args renders agent picker card", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCommand("chat-1", "/agent");

    expect(result.success).toBe(true);
    expect(openCodeClient.app.agents).toHaveBeenCalledTimes(1);
    expect(renderer.sendCard).toHaveBeenCalledTimes(1);

    const sentCard = renderer.sendCard.mock.calls[0][1];
    expect(sentCard.header.title.content).toBe("Agent Picker");
    const actionEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "agent",
      value: "build",
    });
  });

  it("/model without args shows empty picker when catalog is empty", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.config.providers.mockResolvedValue({
      data: { providers: [], default: {} },
    });
    const router = createRouter({ renderer, openCodeClient });

    await router.handleCommand("chat-1", "/model");

    const sentCard = renderer.sendCard.mock.calls[0][1];
    const markdownEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("No models available");
  });

  it("/agent without args shows empty picker when catalog is empty", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.app.agents.mockResolvedValue({ data: [] });
    const router = createRouter({ renderer, openCodeClient });

    await router.handleCommand("chat-1", "/agent");

    const sentCard = renderer.sendCard.mock.calls[0][1];
    const markdownEl = sentCard.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("No agents available");
  });
});

describe("Selection card builders", () => {
  it("buildSessionListCard renders sessions with select buttons", () => {
    const card = buildSessionListCard([
      { id: "sess-1", title: "First session" },
      { id: "sess-2", title: "Second session" },
    ]);

    expect(card.header?.title?.content).toBe("Sessions");
    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    expect(actionEl).toBeDefined();
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "session",
      context: undefined,
      value: "sess-1",
    });
    expect(actions[1].value).toEqual({
      action: "selection_pick",
      command: "session",
      context: undefined,
      value: "sess-2",
    });

    const markdownEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "markdown",
    ) as { content?: string } | undefined;
    expect(markdownEl?.content).toContain("Select a session");
  });

  it("buildSessionListCard handles empty sessions", () => {
    const card = buildSessionListCard([]);
    const markdownEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "markdown",
    ) as { content?: string } | undefined;
    expect(markdownEl?.content ?? "").toContain("No recent sessions found");
  });

  it("buildModelPickerCard renders models as buttons", () => {
    const card = buildModelPickerCard(["openai/gpt-4", "anthropic/claude-3"]);

    expect(card.header?.title?.content).toBe("Model Picker");
    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "model",
      context: { level: "flat" },
      value: "openai/gpt-4",
    });
  });

  it("buildModelPickerCard caps button count and preserves choices", () => {
    const models = Array.from(
      { length: 30 },
      (_, index) => `provider/model-${index}`,
    );
    const card = buildModelPickerCard(models);

    const actionElements = card.elements?.filter(
      (el: { tag: string }) => el.tag === "action",
    ) as Array<{
      actions: Array<{ value: { action?: string; value?: string } }>;
    }>;
    const modelNames = actionElements
      .flatMap((el) => el.actions.map((action) => action.value))
      .filter((value) => value.action === "selection_pick")
      .map((value) => value.value);

    expect(modelNames).toHaveLength(20);
    expect(modelNames).toContain("provider/model-0");
    expect(modelNames).toContain("provider/model-19");
    expect(modelNames).not.toContain("provider/model-20");
  });

  it("buildAgentPickerCard renders agents as buttons", () => {
    const card = buildAgentPickerCard(["build", "oracle"]);

    expect(card.header?.title?.content).toBe("Agent Picker");
    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "agent",
      value: "build",
    });
  });

  it("buildModelProviderCard renders provider buttons with provider context", () => {
    const card = buildModelProviderCard([
      { name: "openai", modelCount: 2 },
      { name: "anthropic", modelCount: 1 },
    ]);

    expect(card.header?.title?.content).toBe("Model Picker");
    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "model",
      context: { level: "provider" },
      value: "openai",
    });
  });

  it("buildModelListCard renders model buttons with provider-specific context", () => {
    const card = buildModelListCard("openai", ["gpt-4", "gpt-4.1"]);

    expect(card.header?.title?.content).toBe("Model Picker");
    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "model",
      context: { level: "model", provider: "openai" },
      value: "gpt-4",
    });
  });

  it("buildProjectPickerCard renders projects as buttons", () => {
    const card = buildProjectPickerCard(
      [
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
      "project-2",
    );

    expect(card.header?.title?.content).toBe("Projects");
    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    expect(actionEl).toBeDefined();
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "selection_pick",
      command: "project",
      context: undefined,
      value: "project-1",
    });
  });

  it("buildProjectPickerCard renders discover buttons for new directories", () => {
    const card = buildProjectPickerCard([
      {
        id: "project-1",
        worktree: "/workspace/project-1",
        name: "Project One",
      },
      {
        worktree: "/workspace/project-3",
        name: "project-3",
        isNew: true,
      },
    ]);

    const actionEl = card.elements?.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions[1].value).toEqual({
      action: "selection_pick",
      command: "project",
      context: undefined,
      value: "/workspace/project-3",
    });
  });

  it("handleCardAction switches session from a selection card", async () => {
    const renderer = createMockRenderer();
    const sessionManager = createMockSessionManager();
    const openCodeClient = createMockOpenCodeClient();
    sessionManager.getCurrentSession.mockReturnValue({
      id: "sess-old",
      title: "Old",
      directory: "/workspace/project",
    });
    const router = createRouter({ sessionManager, renderer, openCodeClient });

    const result = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: { action: "select_session", sessionId: "sess-42" },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "success",
        content: expect.stringContaining(
          "Session selected: Target Session (sess-42)",
        ),
      },
    });
    expect(sessionManager.setChatSession).toHaveBeenCalledWith("chat-1", {
      id: "sess-42",
      title: "Target Session",
      directory: "/workspace/project",
    });
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Session selected:"),
    );
  });

  it("handleCardAction switches model and agent from selection cards", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const modelResult = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: { action: "select_model", modelName: "openai/gpt-4.1" },
      },
    });
    const agentResult = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: { action: "select_agent", agentName: "oracle" },
      },
    });

    expect(modelResult).toEqual({
      toast: {
        type: "success",
        content: "Model selected: openai/gpt-4.1",
      },
    });
    expect(agentResult).toEqual({
      toast: {
        type: "success",
        content: "Agent selected: oracle",
      },
    });

    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
    expect(settings.setCurrentAgent).toHaveBeenCalledWith("oracle");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Model selected: openai/gpt-4.1",
    );
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Agent selected: oracle",
    );
  });

  it("handleCardAction supports nested Feishu callback payloads", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const result = await router.handleCardAction({
      event: {
        action: {
          value: { action: "select_model", modelName: "openai/gpt-4.1" },
        },
        context: {
          open_chat_id: "chat-nested",
        },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "success",
        content: "Model selected: openai/gpt-4.1",
      },
    });
    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-nested",
      "Model selected: openai/gpt-4.1",
    );
  });

  it("updates cards when nested callbacks carry open_message_id in context", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    await router.handleCardAction({
      event: {
        action: {
          value: { action: "select_model", modelName: "openai/gpt-4.1" },
        },
        context: {
          open_chat_id: "chat-nested",
          open_message_id: "msg-nested-card",
        },
      },
    });

    expect(renderer.updateCard).toHaveBeenCalledWith(
      "msg-nested-card",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "green",
        }),
      }),
    );
  });

  it("handleCardAction returns toast feedback when callback has no chat id", async () => {
    const renderer = createMockRenderer();
    const router = createRouter({ renderer });

    const result = await router.handleCardAction({
      action: {
        value: {
          action: "confirm_write",
          operationId: "create_new_session",
        },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "error",
        content:
          "Unable to determine which chat should receive the new session. Please try again from the original chat.",
      },
    });
    expect(renderer.sendText).not.toHaveBeenCalled();
  });

  it("handleCardAction switches project from project picker", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const sessionManager = createMockSessionManager();
    const router = createRouter({
      settingsManager: settings,
      sessionManager,
      renderer,
    });

    const result = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: { action: "select_project", projectId: "project-1" },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "success",
        content:
          "Project selected: Project One\n\nActive session cleared. Use /sessions or /new for this project.",
      },
    });
    expect(settings.setCurrentProject).toHaveBeenCalledWith({
      id: "project-1",
      worktree: "/workspace/project-1",
      name: "Project One",
    });
    expect(sessionManager.clearChatSession).toHaveBeenCalledWith("chat-1");
    expect(renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Project selected: Project One"),
    );
  });

  it("handleCardAction supports two-level model picker flow", async () => {
    const renderer = createMockRenderer();
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings, renderer });

    const providerResult = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: {
          action: "selection_pick",
          command: "model",
          value: "openai",
          context: { level: "provider" },
        },
      },
    });

    expect(providerResult).toEqual({});
    expect(renderer.sendCard).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: "Model Picker" }),
        }),
      }),
    );

    const modelResult = await router.handleCardAction({
      open_chat_id: "chat-1",
      action: {
        value: {
          action: "selection_pick",
          command: "model",
          value: "gpt-4.1",
          context: { level: "model", provider: "openai" },
        },
      },
    });

    expect(modelResult).toEqual({
      toast: {
        type: "success",
        content: "Model selected: openai/gpt-4.1",
      },
    });
    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
  });

  it("handleCardAction supports selection cancel and pagination", async () => {
    const renderer = createMockRenderer();
    const router = createRouter({ renderer });

    await expect(
      router.handleCardAction({
        open_chat_id: "chat-1",
        action: { value: { action: "selection_cancel" } },
      }),
    ).resolves.toEqual({ toast: { type: "info", content: "Cancelled" } });

    await expect(
      router.handleCardAction({
        open_chat_id: "chat-1",
        action: {
          value: {
            action: "selection_page",
            command: "session",
            page: 1,
          },
        },
      }),
    ).resolves.toEqual({});
    expect(renderer.sendCard).toHaveBeenCalled();
  });

  it("leaves the original card in place when selection handling fails", async () => {
    const renderer = createMockRenderer();
    const openCodeClient = createMockOpenCodeClient();
    openCodeClient.session.get.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    const router = createRouter({ renderer, openCodeClient });

    const result = await router.handleCardAction({
      open_chat_id: "chat-1",
      open_message_id: "msg-failed-card",
      action: {
        value: { action: "select_session", sessionId: "sess-missing" },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "error",
        content: "Failed to switch session",
      },
    });
    expect(renderer.updateCard).not.toHaveBeenCalled();
  });
});
