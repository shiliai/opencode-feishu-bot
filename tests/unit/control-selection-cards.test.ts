import { describe, expect, it, vi } from "vitest";
import { ControlRouter } from "../../src/feishu/control-router.js";
import type { ControlRouterOptions } from "../../src/feishu/control-router.js";
import {
  buildSessionListCard,
  buildModelPickerCard,
  buildAgentPickerCard,
} from "../../src/feishu/control-cards.js";

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
        .mockResolvedValue({ data: [{ id: "sess-1", title: "Test" }] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      abort: vi.fn().mockResolvedValue({ data: true }),
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
    expect(openCodeClient.session.list).toHaveBeenCalledTimes(1);
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
      action: "select_model",
      modelName: "openai/gpt-4",
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
      action: "select_agent",
      agentName: "build",
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

    expect(card.header.title.content).toBe("Sessions");
    const actionEl = card.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    expect(actionEl).toBeDefined();
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "select_session",
      sessionId: "sess-1",
    });
    expect(actions[1].value).toEqual({
      action: "select_session",
      sessionId: "sess-2",
    });
  });

  it("buildSessionListCard handles empty sessions", () => {
    const card = buildSessionListCard([]);
    const markdownEl = card.elements.find(
      (el: { tag: string }) => el.tag === "markdown",
    );
    expect(markdownEl.content).toContain("No recent sessions found");
  });

  it("buildModelPickerCard renders models as buttons", () => {
    const card = buildModelPickerCard(["openai/gpt-4", "anthropic/claude-3"]);

    expect(card.header.title.content).toBe("Model Picker");
    const actionEl = card.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "select_model",
      modelName: "openai/gpt-4",
    });
  });

  it("buildAgentPickerCard renders agents as buttons", () => {
    const card = buildAgentPickerCard(["build", "oracle"]);

    expect(card.header.title.content).toBe("Agent Picker");
    const actionEl = card.elements.find(
      (el: { tag: string }) => el.tag === "action",
    );
    const actions = (
      actionEl as { actions: Array<{ value: Record<string, unknown> }> }
    ).actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].value).toEqual({
      action: "select_agent",
      agentName: "build",
    });
  });

  it("handleCardAction switches session from a selection card", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.getCurrentSession.mockReturnValue({
      id: "sess-old",
      title: "Old",
      directory: "/workspace/project",
    });
    const router = createRouter({ sessionManager });

    const result = await router.handleCardAction({
      action: {
        value: { action: "select_session", sessionId: "sess-new" },
      },
    });

    expect(result).toEqual({});
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith({
      id: "sess-new",
      title: "Old",
      directory: "/workspace/project",
    });
  });

  it("handleCardAction switches model and agent from selection cards", async () => {
    const settings = createMockSettings();
    const router = createRouter({ settingsManager: settings });

    await router.handleCardAction({
      action: {
        value: { action: "select_model", modelName: "openai/gpt-4.1" },
      },
    });
    await router.handleCardAction({
      action: {
        value: { action: "select_agent", agentName: "oracle" },
      },
    });

    expect(settings.setCurrentModel).toHaveBeenCalledWith({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
    expect(settings.setCurrentAgent).toHaveBeenCalledWith("oracle");
  });
});
