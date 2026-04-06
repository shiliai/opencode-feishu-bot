import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import { EventDeduplicator } from "../../../src/feishu/event-deduplicator.js";
import {
  FeishuEventRouter,
  type FeishuMessageReceiveEvent,
} from "../../../src/feishu/event-router.js";
import { PromptIngressHandler } from "../../../src/feishu/handlers/prompt.js";
import { ResponsePipelineController } from "../../../src/feishu/response-pipeline.js";
import { StatusStore } from "../../../src/feishu/status-store.js";
import { SettingsManager } from "../../../src/settings/manager.js";
import { SessionManager } from "../../../src/session/manager.js";
import { QuestionManager } from "../../../src/question/manager.js";
import { PermissionManager } from "../../../src/permission/manager.js";
import { InteractionManager } from "../../../src/interaction/manager.js";
import {
  FileHandler,
  type FeishuFileClient,
} from "../../../src/feishu/file-handler.js";
import { FileStore, type StoredFile } from "../../../src/feishu/file-store.js";
import {
  QuestionCardHandler,
  type OpenCodeQuestionClient,
  type QuestionRenderer,
} from "../../../src/feishu/handlers/question.js";
import {
  PermissionCardHandler,
  type OpenCodePermissionClient,
  type PermissionRenderer,
} from "../../../src/feishu/handlers/permission.js";
import type { Logger } from "../../../src/utils/logger.js";
import type { PermissionRequest } from "../../../src/permission/types.js";
import type { Question } from "../../../src/question/types.js";
import { RuntimeSummaryAggregator } from "../../../src/app/runtime-summary-aggregator.js";
import { createRuntimeEventHandlers } from "../../../src/app/runtime-event-handlers.js";
import { ControlRouter } from "../../../src/feishu/control-router.js";

interface MockRenderer {
  sendCard: ReturnType<typeof vi.fn>;
  renderStatusCard: ReturnType<typeof vi.fn>;
  updateStatusCard: ReturnType<typeof vi.fn>;
  replyPost: ReturnType<typeof vi.fn>;
  sendPost: ReturnType<typeof vi.fn>;
  renderQuestionCard: ReturnType<typeof vi.fn>;
  renderPermissionCard: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
}

interface MockOpenCodeClients {
  session: {
    create: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    promptAsync: ReturnType<typeof vi.fn>;
  };
  app: {
    agents: ReturnType<typeof vi.fn>;
  };
  config: {
    providers: ReturnType<typeof vi.fn>;
  };
  question: {
    reply: ReturnType<typeof vi.fn>;
  };
  permission: {
    reply: ReturnType<typeof vi.fn>;
  };
}

interface MockFeishuFileClient extends FeishuFileClient {
  im: {
    resource: {
      get: ReturnType<typeof vi.fn>;
    };
    file: {
      create: ReturnType<typeof vi.fn>;
    };
    message: {
      create: ReturnType<typeof vi.fn>;
    };
  };
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createRenderer(): MockRenderer {
  return {
    sendCard: vi.fn().mockResolvedValue("control-card-1"),
    renderStatusCard: vi.fn().mockResolvedValue("status-card-1"),
    updateStatusCard: vi.fn().mockResolvedValue(undefined),
    replyPost: vi.fn().mockResolvedValue("reply-message-1"),
    sendPost: vi.fn().mockResolvedValue("send-post-1"),
    renderQuestionCard: vi.fn().mockResolvedValue("question-card-1"),
    renderPermissionCard: vi.fn().mockResolvedValue("permission-card-1"),
    sendText: vi.fn().mockResolvedValue(["text-message-1"]),
  };
}

function createOpenCodeClients(): MockOpenCodeClients {
  return {
    session: {
      create: vi.fn().mockResolvedValue({
        data: {
          id: "session-1",
          title: "Integration Session",
          directory: "/workspace/project",
        },
        error: undefined,
      }),
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: "session-1",
            title: "Integration Session",
            directory: "/workspace/project",
          },
        ],
        error: undefined,
      }),
      status: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
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
              },
            },
          ],
          default: {},
        },
      }),
    },
    question: {
      reply: vi.fn().mockResolvedValue(undefined),
    },
    permission: {
      reply: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createFeishuFileClient(): MockFeishuFileClient {
  return {
    im: {
      resource: {
        get: vi
          .fn()
          .mockResolvedValue({ data: Buffer.from("downloaded fixture") }),
      },
      file: {
        create: vi
          .fn()
          .mockResolvedValue({ data: { file_key: "uploaded-file-key-1" } }),
      },
      message: {
        create: vi
          .fn()
          .mockResolvedValue({ data: { message_id: "file-message-1" } }),
      },
    },
  };
}

export interface BridgeHarness {
  logger: Logger;
  renderer: MockRenderer;
  openCodeClients: MockOpenCodeClients;
  feishuFileClient: MockFeishuFileClient;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
  questionManager: QuestionManager;
  permissionManager: PermissionManager;
  interactionManager: InteractionManager;
  fileStore: FileStore;
  fileHandler: FileHandler;
  responsePipeline: ResponsePipelineController;
  eventRouter: FeishuEventRouter;
  setSseEvents(events: Event[]): void;
  getDownloadedFiles(): StoredFile[];
  handleMessageReceived(event: FeishuMessageReceiveEvent): Promise<void>;
  handleCardAction(event: Record<string, unknown>): Promise<unknown>;
  flushSession(sessionId?: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createBridgeHarness(): Promise<BridgeHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), "feishu-bridge-integration-"));
  const settingsFilePath = join(tempRoot, "settings.json");

  const logger = createLogger();
  const renderer = createRenderer();
  const openCodeClients = createOpenCodeClients();
  const feishuFileClient = createFeishuFileClient();
  const fileStore = new FileStore({
    tempDirPrefix: "feishu-bridge-integration-file-",
    logger,
  });
  const settingsManager = new SettingsManager({ settingsFilePath, logger });
  const sessionManager = new SessionManager(settingsManager);
  const questionManager = new QuestionManager();
  const permissionManager = new PermissionManager();
  const interactionManager = new InteractionManager();
  const statusStore = new StatusStore();
  const downloadedFiles: StoredFile[] = [];
  const pendingTasks = new Set<Promise<unknown>>();
  let currentSseEvents: Event[] = [];

  const trackTask = (task: Promise<unknown>): void => {
    pendingTasks.add(task);
    void task.finally(() => {
      pendingTasks.delete(task);
    });
  };

  const fileHandler = new FileHandler({
    fileStore,
    client: feishuFileClient,
    replySender: renderer,
    logger,
  });

  const questionClient: OpenCodeQuestionClient = {
    question: {
      reply: (params) => openCodeClients.question.reply(params),
    },
  };

  const permissionClient: OpenCodePermissionClient = {
    permission: {
      reply: (params) => openCodeClients.permission.reply(params),
    },
  };

  const questionRenderer: QuestionRenderer = {
    renderQuestionCard: (receiveId, question, associatedMessageId) =>
      renderer.renderQuestionCard(receiveId, question, associatedMessageId),
  };

  const questionCardHandler = new QuestionCardHandler({
    questionManager,
    renderer: questionRenderer,
    openCodeClient: questionClient,
    interactionManager,
    logger,
  });

  const permissionCardHandler = new PermissionCardHandler({
    permissionManager,
    renderer: {
      renderPermissionCard: (receiveId, request) =>
        renderer.renderPermissionCard(receiveId, request),
    } satisfies PermissionRenderer,
    openCodeClient: permissionClient,
    interactionManager,
    logger,
  });

  const inboundFilesBySession = new Map<string, StoredFile[]>();

  const controlRouter = new ControlRouter({
    settingsManager,
    sessionManager,
    renderer: renderer as never,
    openCodeClient: openCodeClients as never,
    interactionManager,
    logger,
  });

  const summaryAggregator = new RuntimeSummaryAggregator({
    statusStore,
    questionManager,
    permissionManager,
    interactionManager,
    questionCardHandler,
    permissionCardHandler,
    fileHandler,
    fileStore,
    logger,
    trackTask,
    onSessionSettled: async (sessionId) => {
      const storedFiles = inboundFilesBySession.get(sessionId) ?? [];
      inboundFilesBySession.delete(sessionId);
      await Promise.all(
        storedFiles.map((storedFile) => fileHandler.cleanup(storedFile)),
      );
    },
  });

  const eventSubscriber = {
    subscribeToEvents: vi.fn(
      async (
        _directory: string,
        callback: (event: Event) => void,
        options?: { signal?: AbortSignal },
      ): Promise<void> => {
        for (const event of currentSseEvents) {
          callback(event);
        }

        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }

          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    ),
  };

  const responsePipeline = new ResponsePipelineController({
    eventSubscriber,
    summaryAggregator,
    renderer,
    settingsManager,
    interactionManager,
    statusStore,
    logger,
    scheduleAsync: (task): void => task(),
    config: {
      throttle: {
        statusCardUpdateIntervalMs: 1,
        statusCardPatchRetryDelayMs: 1,
        statusCardPatchMaxAttempts: 2,
      },
    },
  });

  settingsManager.setCurrentProject({
    id: "project-1",
    worktree: "/workspace/project",
    name: "Integration Project",
  });

  const promptIngressHandler = new PromptIngressHandler({
    settings: settingsManager,
    interactionManager,
    openCodeSession: openCodeClients.session,
    openCodeSessionStatus: openCodeClients.session,
    openCodePromptAsync: openCodeClients.session,
    botOpenId: "bot-open-id-1",
    logger,
    scheduleAsync: (task): void => task(),
  });

  const deduplicator = new EventDeduplicator({ ttlMs: 30_000 });

  const runtimeEventHandlers = createRuntimeEventHandlers({
    promptIngressHandler,
    pipelineController: responsePipeline,
    questionCardHandler,
    permissionCardHandler,
    controlRouter,
    fileHandler,
    botOpenId: "bot-open-id-1",
    logger,
    onPromptDispatched: async (result, storedFile) => {
      if (storedFile) {
        downloadedFiles.push(storedFile);
        const files = inboundFilesBySession.get(result.sessionId) ?? [];
        files.push(storedFile);
        inboundFilesBySession.set(result.sessionId, files);
      }
    },
  });

  const eventRouter = new FeishuEventRouter({
    deduplicator,
    logger,
    scheduleAsync: (task): void => task(),
    onMessageReceived: runtimeEventHandlers.handleMessageReceived,
    onCardAction: runtimeEventHandlers.handleCardAction,
  });

  const flushPendingTasks = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
      if (pendingTasks.size === 0) {
        break;
      }
      await Promise.allSettled(Array.from(pendingTasks));
    }
  };

  return {
    logger,
    renderer,
    openCodeClients,
    feishuFileClient,
    settingsManager,
    sessionManager,
    questionManager,
    permissionManager,
    interactionManager,
    fileStore,
    fileHandler,
    responsePipeline,
    eventRouter,
    setSseEvents(events: Event[]): void {
      currentSseEvents = events;
    },
    getDownloadedFiles(): StoredFile[] {
      return [...downloadedFiles];
    },
    async handleMessageReceived(
      event: FeishuMessageReceiveEvent,
    ): Promise<void> {
      eventRouter.handleMessageReceived(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    handleCardAction(event: Record<string, unknown>): Promise<unknown> {
      return eventRouter.handleCardAction(event);
    },
    async flushSession(sessionId: string = "session-1"): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await responsePipeline.enqueueSessionTask(
        sessionId,
        async () => undefined,
      );
      await flushPendingTasks();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await flushPendingTasks();
    },
    async cleanup(): Promise<void> {
      statusStore.clearAll();
      await settingsManager.waitForPendingWrites();
      await fileStore.cleanupAll();
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export function createQuestionFixture(): Question[] {
  return [
    {
      header: "Choose stack",
      question: "Which framework should we use?",
      options: [
        { label: "React", description: "Component UI" },
        { label: "Vue", description: "Progressive UI" },
      ],
    },
  ];
}

export function createPermissionFixture(): PermissionRequest {
  return {
    id: "permission-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["npm test"],
    metadata: {},
    always: [],
    tool: {
      messageID: "assistant-message-1",
      callID: "tool-call-1",
    },
  };
}
