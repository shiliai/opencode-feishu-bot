import "dotenv/config";

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type AppConfig, ConfigValidationError, getConfig } from "../config.js";
import { createCardCallbackRequestHandler } from "../feishu/card-callback-server.js";
import { ControlRouter } from "../feishu/control-router.js";
import { createEventDeduplicator } from "../feishu/event-deduplicator.js";
import { FeishuEventRouter } from "../feishu/event-router.js";
import { type FeishuFileClient, FileHandler } from "../feishu/file-handler.js";
import { FileStore, type StoredFile } from "../feishu/file-store.js";
import {
  type OpenCodePermissionClient,
  PermissionCardHandler,
} from "../feishu/handlers/permission.js";
import {
  type OpenCodePromptAsyncClient,
  PromptIngressHandler,
  type PromptIngressResult,
} from "../feishu/handlers/prompt.js";
import {
  type OpenCodeQuestionClient,
  QuestionCardHandler,
} from "../feishu/handlers/question.js";
import { ImageResolver } from "../feishu/image-resolver.js";
import { MessageReader } from "../feishu/message-reader.js";
import { FeishuRenderer } from "../feishu/renderer.js";
import { ResponsePipelineController } from "../feishu/response-pipeline.js";
import { createFeishuClients } from "../feishu/sdk.js";
import { statusStore } from "../feishu/status-store.js";
import { startFeishuWsClient } from "../feishu/ws-client.js";
import { interactionManager } from "../interaction/manager.js";
import { createOpenCodeClient } from "../opencode/client.js";
import { createSessionMessageFetcher } from "../opencode/message-fetcher.js";
import { createOpenCodePromptClient } from "../opencode/prompt-client.js";
import { permissionManager } from "../permission/manager.js";
import { questionManager } from "../question/manager.js";
import { sessionManager } from "../session/manager.js";
import { settingsManager } from "../settings/manager.js";
import { logger } from "../utils/logger.js";
import { APP_VERSION } from "../version.js";
import { createRuntimeEventHandlers } from "./runtime-event-handlers.js";
import { RuntimeSummaryAggregator } from "./runtime-summary-aggregator.js";

let _actualPort: number | null = null;

export function getActualServicePort(): number | null {
  return _actualPort;
}

export async function startFeishuApp(): Promise<void> {
  // Step 1: Load config — fails fast on missing required env vars
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      logger.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  logger.info(`opencode-feishu-bridge v${APP_VERSION} starting...`);

  // Step 2: Create Feishu clients — forward reference needed because eventRouter
  // doesn't exist yet; the indirection is resolved after step 8
  let resolveCardAction: ((event: unknown) => Promise<unknown>) | null = null;
  const cardActionForwarder = (event: unknown): unknown => {
    if (resolveCardAction) {
      return resolveCardAction(event);
    }
    return Promise.resolve();
  };

  const feishuClients = createFeishuClients(config, cardActionForwarder);

  // Step 3: Create FeishuRenderer
  const renderer = new FeishuRenderer({
    client: feishuClients.client,
  });
  let pipelineControllerInstance: ResponsePipelineController | null = null;
  const imageResolver = new ImageResolver({
    client: feishuClients.client,
    onImageResolved: () => {
      pipelineControllerInstance?.handleImageResolved();
    },
  });

  // Step 4: Create OpenCode client
  const openCodeClient = createOpenCodeClient(config.opencode);

  const openCodeQuestionClient: OpenCodeQuestionClient = {
    question: {
      reply: (params) => openCodeClient.question.reply(params),
    },
  };

  const openCodePermissionClient: OpenCodePermissionClient = {
    permission: {
      reply: (params) => openCodeClient.permission.reply(params),
    },
  };

  const feishuFileClient = feishuClients.client as unknown as FeishuFileClient;

  const openCodePromptAsyncClient: OpenCodePromptAsyncClient =
    createOpenCodePromptClient(openCodeClient, logger);

  // Step 5: Create managers (singletons)
  const managers = {
    settings: settingsManager,
    session: sessionManager,
    question: questionManager,
    permission: permissionManager,
    interaction: interactionManager,
  };

  await managers.settings.loadSettings();
  if (!managers.settings.getCurrentProject()) {
    const defaultWorktree =
      managers.settings.getCurrentSession()?.directory ?? process.cwd();
    managers.settings.setCurrentProject({
      id: defaultWorktree,
      worktree: defaultWorktree,
      name: "Default workspace",
    });
    logger.info(
      `[Startup] No current project configured; defaulting to worktree=${defaultWorktree}`,
    );
  }

  // Step 6: Create handlers
  const questionCardHandler = new QuestionCardHandler({
    questionManager: managers.question,
    renderer,
    openCodeClient: openCodeQuestionClient,
    interactionManager: managers.interaction,
  });

  const permissionCardHandler = new PermissionCardHandler({
    permissionManager: managers.permission,
    renderer,
    openCodeClient: openCodePermissionClient,
    interactionManager: managers.interaction,
  });

  const fileStore = new FileStore({ logger });
  const fileHandler = new FileHandler({
    fileStore,
    client: feishuFileClient,
    replySender: renderer,
    logger,
  });

  const messageReader = new MessageReader({
    client: feishuClients.client,
    logger,
  });

  const controlRouter = new ControlRouter({
    settingsManager: managers.settings,
    sessionManager: managers.session,
    renderer,
    openCodeClient,
    feishuClient: feishuClients.client,
    catalogCacheTtlMs: config.controlCatalog.cacheTtlMs,
    catalogModelStatePath: config.controlCatalog.modelStatePath,
    messageReader,
    interactionManager: managers.interaction,
    statusStore,
    cardActionsEnabled:
      config.connectionType === "ws" ||
      Boolean(config.cardCallback && feishuClients.cardActionHandler),
    workdir: config.workdir,
    logger,
  });

  const promptIngressHandler = new PromptIngressHandler({
    settings: managers.settings,
    interactionManager: managers.interaction,
    openCodeSession: openCodeClient.session,
    openCodeSessionStatus: openCodeClient.session,
    openCodeSessionMessages: openCodeClient.session,
    openCodePromptAsync: openCodePromptAsyncClient,
    messageReader,
    botOpenId: config.feishu.botOpenId || null,
  });

  const inboundFilesBySession = new Map<string, StoredFile[]>();

  const summaryAggregator = new RuntimeSummaryAggregator({
    statusStore,
    questionManager: managers.question,
    permissionManager: managers.permission,
    interactionManager: managers.interaction,
    questionCardHandler,
    permissionCardHandler,
    fileHandler,
    fileStore,
    logger,
    onSessionSettled: async (sessionId) => {
      const storedFiles = inboundFilesBySession.get(sessionId) ?? [];
      inboundFilesBySession.delete(sessionId);
      await Promise.all(
        storedFiles.map((storedFile) => fileHandler.cleanup(storedFile)),
      );
    },
  });

  // Step 7: Create ResponsePipelineController
  const sessionMessageFetcher = createSessionMessageFetcher(openCodeClient);
  const pipelineController = new ResponsePipelineController({
    summaryAggregator,
    sessionMessageFetcher,
    renderer,
    imageResolver,
    settingsManager: managers.settings,
    interactionManager: managers.interaction,
    statusStore,
    config,
  });
  pipelineControllerInstance = pipelineController;

  // Step 8: Create event router with message and card action handlers
  const deduplicator = createEventDeduplicator(config);
  await deduplicator.hydrate();

  const runtimeEventHandlers = createRuntimeEventHandlers({
    promptIngressHandler,
    pipelineController,
    questionCardHandler,
    permissionCardHandler,
    controlRouter,
    fileHandler,
    botOpenId: config.feishu.botOpenId || null,
    logger,
    onPromptDispatched: async (
      result: Extract<PromptIngressResult, { kind: "dispatched" }>,
      storedFiles,
    ) => {
      if (!storedFiles || storedFiles.length === 0) {
        return;
      }

      const files = inboundFilesBySession.get(result.sessionId) ?? [];
      files.push(...storedFiles);
      inboundFilesBySession.set(result.sessionId, files);
    },
  });

  const eventRouter = new FeishuEventRouter({
    deduplicator,
    onMessageReceived: runtimeEventHandlers.handleMessageReceived,
    onCardAction: runtimeEventHandlers.handleCardAction,
  });

  // Resolve the forward reference now that eventRouter exists
  resolveCardAction = (event: unknown) =>
    eventRouter.handleCardAction(event as Record<string, unknown>);

  // Step 9: Start HTTP server (card callback + /healthz)
  const healthResponse = JSON.stringify({ status: "ok" });
  const sendHealthz = (res: ServerResponse): void => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(healthResponse);
  };

  let httpServer: Server | null = null;

  if (config.cardCallback && feishuClients.cardActionHandler) {
    const cardCallbackHandler = createCardCallbackRequestHandler(
      feishuClients.cardActionHandler,
      undefined,
      {
        verificationToken: config.cardCallback.verificationToken,
        encryptKey: config.cardCallback.encryptKey,
      },
    );
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const requestUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      if (requestUrl.pathname === "/healthz") {
        sendHealthz(res);
        return;
      }
      cardCallbackHandler(req, res);
    });
  } else {
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const requestUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      if (requestUrl.pathname === "/healthz") {
        sendHealthz(res);
        return;
      }
      res.statusCode = 404;
      res.end("Not Found");
    });
  }

  const server = httpServer;
  if (!server) {
    throw new Error("HTTP server was not initialized");
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.service.port, config.service.host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        _actualPort = addr.port;
      } else {
        _actualPort = config.service.port;
      }
      resolve();
    });
  });

  logger.info(
    `HTTP server listening on ${config.service.host}:${config.service.port}`,
  );

  // Step 10: Start WebSocket client (if ws mode)
  if (config.connectionType === "ws") {
    await startFeishuWsClient({
      wsClient: feishuClients.wsClient,
      eventRouter,
    });
  }

  logger.info(`opencode-feishu-bridge v${APP_VERSION} started successfully`);

  // Step 11: Graceful shutdown
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down...`);

    const snapshot = pipelineController.getSnapshot();
    for (const sessionId of snapshot.activeSessions) {
      logger.info(`Aborting active session: ${sessionId}`);
    }
    statusStore.clearAll();

    httpServer?.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn("Forcing exit after timeout");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
