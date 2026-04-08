import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "./client.js";
import { logger } from "../utils/logger.js";

export type EventCallback = (event: Event) => void;

export interface SubscribeToEventsOptions {
  signal?: AbortSignal;
}

export interface OpenCodeEventSubscriberOptions {
  client?: Pick<OpencodeClient, "event">;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  waitFn?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  scheduleCallback?: (callback: () => void) => void;
}

export interface OpenCodeEventSubscriberSnapshot {
  activeDirectory: string | null;
  isListening: boolean;
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000;

export const FATAL_NO_STREAM_ERROR =
  "No stream returned from event subscription";

export function getReconnectDelayMs(
  attempt: number,
  reconnectBaseDelayMs: number = DEFAULT_RECONNECT_BASE_DELAY_MS,
  reconnectMaxDelayMs: number = DEFAULT_RECONNECT_MAX_DELAY_MS,
): number {
  const exponentialDelay =
    reconnectBaseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponentialDelay, reconnectMaxDelayMs);
}

export function waitWithAbort(
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function forwardAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!source) {
    return () => undefined;
  }

  if (source.aborted) {
    controller.abort();
    return () => undefined;
  }

  const onAbort = () => {
    controller.abort();
  };

  source.addEventListener("abort", onAbort, { once: true });

  return () => {
    source.removeEventListener("abort", onAbort);
  };
}

export class OpenCodeEventSubscriber {
  private eventStream: AsyncGenerator<Event, unknown, unknown> | null = null;
  private eventCallback: EventCallback | null = null;
  private isListening = false;
  private activeDirectory: string | null = null;
  private streamAbortController: AbortController | null = null;
  private readonly client: Pick<OpencodeClient, "event">;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly waitFn: (
    ms: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  private readonly scheduleCallback: (callback: () => void) => void;

  constructor(options: OpenCodeEventSubscriberOptions = {}) {
    this.client = options.client ?? opencodeClient;
    this.reconnectBaseDelayMs =
      options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs =
      options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.waitFn = options.waitFn ?? waitWithAbort;
    this.scheduleCallback =
      options.scheduleCallback ?? ((callback) => setImmediate(callback));
  }

  getSnapshot(): OpenCodeEventSubscriberSnapshot {
    return {
      activeDirectory: this.activeDirectory,
      isListening: this.isListening,
    };
  }

  async subscribeToEvents(
    directory: string,
    callback: EventCallback,
    options: SubscribeToEventsOptions = {},
  ): Promise<void> {
    if (this.isListening && this.activeDirectory === directory) {
      this.eventCallback = callback;
      logger.debug(
        `[OpenCodeEvents] Event listener already running for ${directory}`,
      );
      return;
    }

    if (this.isListening && this.activeDirectory !== directory) {
      logger.info(
        `[OpenCodeEvents] Stopping event listener for ${this.activeDirectory}, starting for ${directory}`,
      );
      this.stopEventListening();
    }

    const controller = new AbortController();
    const detachExternalAbort = forwardAbortSignal(options.signal, controller);

    this.activeDirectory = directory;
    this.eventCallback = callback;
    this.isListening = true;
    this.streamAbortController = controller;

    try {
      let reconnectAttempt = 0;

      while (
        this.isListening &&
        this.activeDirectory === directory &&
        !controller.signal.aborted
      ) {
        try {
          const result = await this.client.event.subscribe(
            { directory },
            { signal: controller.signal },
          );

          if (!result.stream) {
            throw new Error(FATAL_NO_STREAM_ERROR);
          }

          reconnectAttempt = 0;
          this.eventStream = result.stream;

          for await (const event of this.eventStream) {
            if (
              !this.isListening ||
              this.activeDirectory !== directory ||
              controller.signal.aborted
            ) {
              logger.debug(
                `[OpenCodeEvents] Event listener stopped or changed directory for ${directory}`,
              );
              break;
            }

            this.scheduleCallback(() => {
              const callbackSnapshot = this.eventCallback;
              if (!callbackSnapshot) {
                return;
              }

              callbackSnapshot(event);
            });
          }

          this.eventStream = null;

          if (
            !this.isListening ||
            this.activeDirectory !== directory ||
            controller.signal.aborted
          ) {
            break;
          }

          reconnectAttempt++;
          const reconnectDelay = getReconnectDelayMs(
            reconnectAttempt,
            this.reconnectBaseDelayMs,
            this.reconnectMaxDelayMs,
          );
          logger.warn(
            `[OpenCodeEvents] Event stream ended for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
          );

          const shouldContinue = await this.waitFn(
            reconnectDelay,
            controller.signal,
          );
          if (!shouldContinue) {
            break;
          }
        } catch (error) {
          this.eventStream = null;

          if (
            controller.signal.aborted ||
            !this.isListening ||
            this.activeDirectory !== directory
          ) {
            logger.info("[OpenCodeEvents] Event listener aborted");
            return;
          }

          if (
            error instanceof Error &&
            error.message === FATAL_NO_STREAM_ERROR
          ) {
            logger.error("[OpenCodeEvents] Event stream fatal error", error);
            throw error;
          }

          reconnectAttempt++;
          const reconnectDelay = getReconnectDelayMs(
            reconnectAttempt,
            this.reconnectBaseDelayMs,
            this.reconnectMaxDelayMs,
          );
          logger.error(
            `[OpenCodeEvents] Event stream error for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
            error,
          );

          const shouldContinue = await this.waitFn(
            reconnectDelay,
            controller.signal,
          );
          if (!shouldContinue) {
            break;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        logger.info("[OpenCodeEvents] Event listener aborted");
        return;
      }

      logger.error("[OpenCodeEvents] Event stream error", error);
      this.isListening = false;
      this.activeDirectory = null;
      this.streamAbortController = null;
      throw error;
    } finally {
      detachExternalAbort();

      if (this.streamAbortController === controller) {
        if (
          this.isListening &&
          this.activeDirectory === directory &&
          !controller.signal.aborted
        ) {
          logger.warn(
            `[OpenCodeEvents] Event stream ended for ${directory}, listener marked as disconnected`,
          );
        }

        this.streamAbortController = null;
        this.eventStream = null;
        this.eventCallback = null;
        this.isListening = false;
        this.activeDirectory = null;
      }
    }
  }

  stopEventListening(): void {
    this.streamAbortController?.abort();
    this.streamAbortController = null;
    this.isListening = false;
    this.eventCallback = null;
    this.eventStream = null;
    this.activeDirectory = null;
    logger.info("[OpenCodeEvents] Event listener stopped");
  }
}

export const openCodeEventSubscriber = new OpenCodeEventSubscriber();

export async function subscribeToEvents(
  directory: string,
  callback: EventCallback,
  options?: SubscribeToEventsOptions,
): Promise<void> {
  return openCodeEventSubscriber.subscribeToEvents(
    directory,
    callback,
    options,
  );
}

export function stopEventListening(): void {
  openCodeEventSubscriber.stopEventListening();
}
