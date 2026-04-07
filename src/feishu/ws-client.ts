import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { logger as defaultLogger, type Logger } from "../utils/logger.js";
import type {
  FeishuEventRouter,
  FeishuMessageReceiveEvent,
} from "./event-router.js";
import { normalizeFeishuEvent } from "./message-events.js";

export interface EventDispatcherLike {
  register(
    handles: Record<string, (data: unknown) => Promise<unknown> | unknown>,
  ): unknown;
}

export interface WSClientLike {
  start(params: { eventDispatcher: unknown }): Promise<void> | void;
}

export interface StartFeishuWsClientOptions {
  wsClient: WSClientLike;
  eventRouter: Pick<
    FeishuEventRouter,
    "handleMessageReceived" | "handleCardAction"
  >;
  createEventDispatcher?: () => EventDispatcherLike;
  logger?: Logger;
}

export function createDefaultEventDispatcher(): EventDispatcherLike {
  return new EventDispatcher({}) as unknown as EventDispatcherLike;
}

export async function startFeishuWsClient(
  options: StartFeishuWsClientOptions,
): Promise<unknown> {
  const logger = options.logger ?? defaultLogger;
  const dispatcher = (
    options.createEventDispatcher ?? createDefaultEventDispatcher
  )().register({
    "im.message.receive_v1": (data) => {
      const eventData = data as FeishuMessageReceiveEvent;
      const normalized = normalizeFeishuEvent(eventData);
      const { header, message } = normalized;

      logger.debug(
        `[FeishuWsClient] im.message.receive_v1 ingress: ` +
          `event_id=${typeof header?.event_id === "string" ? header.event_id : "unknown"}, ` +
          `event_type=${typeof header?.event_type === "string" ? header.event_type : "unknown"}, ` +
          `message_type=${typeof message?.message_type === "string" ? message.message_type : "unknown"}, ` +
          `chat_type=${typeof message?.chat_type === "string" ? message.chat_type : "unknown"}`,
      );
      options.eventRouter.handleMessageReceived(eventData);
    },
    "card.action.trigger": async (data) => {
      logger.debug("[FeishuWsClient] card.action.trigger ingress");
      return options.eventRouter.handleCardAction(
        data as Record<string, unknown>,
      );
    },
  });

  await options.wsClient.start({ eventDispatcher: dispatcher });
  logger.info("[FeishuWsClient] Started websocket ingress");
  return dispatcher;
}
