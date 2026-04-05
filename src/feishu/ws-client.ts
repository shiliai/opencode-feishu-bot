import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { logger as defaultLogger, type Logger } from "../utils/logger.js";
import type { FeishuEventRouter, FeishuMessageReceiveEvent } from "./event-router.js";

export interface EventDispatcherLike {
  register(handles: Record<string, (data: unknown) => Promise<void> | void>): unknown;
}

export interface WSClientLike {
  start(params: { eventDispatcher: unknown }): Promise<void> | void;
}

export interface StartFeishuWsClientOptions {
  wsClient: WSClientLike;
  eventRouter: Pick<FeishuEventRouter, "handleMessageReceived">;
  createEventDispatcher?: () => EventDispatcherLike;
  logger?: Logger;
}

export function createDefaultEventDispatcher(): EventDispatcherLike {
  return new EventDispatcher({});
}

export async function startFeishuWsClient(options: StartFeishuWsClientOptions): Promise<unknown> {
  const logger = options.logger ?? defaultLogger;
  const dispatcher = (options.createEventDispatcher ?? createDefaultEventDispatcher)().register({
    "im.message.receive_v1": (data) => {
      options.eventRouter.handleMessageReceived(data as FeishuMessageReceiveEvent);
    },
  });

  await options.wsClient.start({ eventDispatcher: dispatcher });
  logger.info("[FeishuWsClient] Started websocket ingress");
  return dispatcher;
}
