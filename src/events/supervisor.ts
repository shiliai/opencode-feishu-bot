import type { Event } from "@opencode-ai/sdk/v2";
import type { OpenCodeEventSubscriber } from "../opencode/events.js";
import type { PendingInteractionStore } from "../pending/store.js";
import type { Logger } from "../utils/logger.js";

interface EventSupervisorAggregator {
  processEvent(event: Event): void;
}

interface EventSupervisorClient {
  question: {
    list(params?: {
      directory?: string;
    }): Promise<{ data?: Array<{ id: string; sessionID: string }> }>;
  };
  permission: {
    list(params?: {
      directory?: string;
    }): Promise<{ data?: Array<{ id: string; sessionID: string }> }>;
  };
}

export interface EventSupervisorOptions {
  eventSubscriber: OpenCodeEventSubscriber;
  summaryAggregator: EventSupervisorAggregator;
  pendingStore: PendingInteractionStore;
  client?: EventSupervisorClient;
  logger: Logger;
  resubscribeDelayMs?: number;
}

export interface EventSupervisorSnapshot {
  directory: string | null;
  isSubscribed: boolean;
}

const DEFAULT_RESUBSCRIBE_DELAY_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getRequestId(event: Event): string | undefined {
  const rawEvent = event as { properties?: unknown };
  const properties = isRecord(rawEvent.properties)
    ? rawEvent.properties
    : undefined;
  return getString(properties?.requestID) ?? getString(properties?.id);
}

export class EventSupervisor {
  private currentDirectory: string | null = null;
  private isSubscribed = false;
  private subscriptionGeneration = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: EventSupervisorOptions) {}

  ensureSubscribed(directory: string): void {
    if (this.currentDirectory === directory && this.isSubscribed) {
      this.options.logger.debug(
        `[EventSupervisor] Subscription already active for ${directory}`,
      );
      return;
    }

    if (this.currentDirectory && this.currentDirectory !== directory) {
      this.options.logger.info(
        `[EventSupervisor] Switching subscription from ${this.currentDirectory} to ${directory}`,
      );
      this.stop();
    }

    this.clearRetryTimer();
    this.subscriptionGeneration += 1;
    this.currentDirectory = directory;
    this.isSubscribed = true;

    this.startSubscription(directory, this.subscriptionGeneration);
    void this.bootstrap(directory, this.subscriptionGeneration).catch(
      (error: unknown) => {
        this.options.logger.error(
          `[EventSupervisor] Bootstrap failed for ${directory}`,
          error,
        );
      },
    );
  }

  stop(): void {
    this.clearRetryTimer();
    this.subscriptionGeneration += 1;
    this.options.eventSubscriber.stopEventListening();
    this.currentDirectory = null;
    this.isSubscribed = false;
  }

  getSnapshot(): EventSupervisorSnapshot {
    return {
      directory: this.currentDirectory,
      isSubscribed: this.isSubscribed,
    };
  }

  private startSubscription(directory: string, generation: number): void {
    void this.options.eventSubscriber
      .subscribeToEvents(directory, (event) => {
        this.onEvent(event);
      })
      .catch((error: unknown) => {
        this.options.logger.error(
          `[EventSupervisor] Event subscription failed for ${directory}`,
          error,
        );

        if (!this.isCurrentSubscription(directory, generation)) {
          return;
        }

        this.scheduleRetry(directory, generation);
      });
  }

  private isCurrentSubscription(
    directory: string,
    generation: number,
  ): boolean {
    return (
      this.isSubscribed &&
      this.currentDirectory === directory &&
      this.subscriptionGeneration === generation
    );
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(directory: string, generation: number): void {
    this.clearRetryTimer();

    const delay =
      this.options.resubscribeDelayMs ?? DEFAULT_RESUBSCRIBE_DELAY_MS;
    this.options.logger.warn(
      `[EventSupervisor] Retrying subscription for ${directory} in ${delay}ms`,
    );

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;

      if (!this.isCurrentSubscription(directory, generation)) {
        return;
      }

      this.startSubscription(directory, generation);
    }, delay);
  }

  private onEvent(event: Event): void {
    this.options.summaryAggregator.processEvent(event);

    const eventType = getString((event as { type?: unknown }).type);
    if (
      eventType !== "question.replied" &&
      eventType !== "question.rejected" &&
      eventType !== "permission.replied"
    ) {
      return;
    }

    const requestId = getRequestId(event);
    if (!requestId) {
      return;
    }

    this.options.pendingStore.remove(requestId);
  }

  private async bootstrap(
    directory: string,
    generation: number,
  ): Promise<void> {
    if (!this.options.client) {
      return;
    }

    try {
      const questionResponse = await this.options.client.question.list({
        directory,
      });
      if (!this.isCurrentSubscription(directory, generation)) {
        return;
      }
      const questions = questionResponse.data ?? [];
      for (const item of questions) {
        if (!this.isCurrentSubscription(directory, generation)) {
          return;
        }
        this.options.pendingStore.add(
          item.id,
          item.sessionID,
          directory,
          "",
          "question",
        );
      }
      this.options.logger.info(
        `[EventSupervisor] Hydrated ${questions.length} pending question requests for ${directory}`,
      );
    } catch (error) {
      this.options.logger.error(
        `[EventSupervisor] Failed to hydrate pending question requests for ${directory}`,
        error,
      );
    }

    try {
      const permissionResponse = await this.options.client.permission.list({
        directory,
      });
      if (!this.isCurrentSubscription(directory, generation)) {
        return;
      }
      const permissions = permissionResponse.data ?? [];
      for (const item of permissions) {
        if (!this.isCurrentSubscription(directory, generation)) {
          return;
        }
        this.options.pendingStore.add(
          item.id,
          item.sessionID,
          directory,
          "",
          "permission",
        );
      }
      this.options.logger.info(
        `[EventSupervisor] Hydrated ${permissions.length} pending permission requests for ${directory}`,
      );
    } catch (error) {
      this.options.logger.error(
        `[EventSupervisor] Failed to hydrate pending permission requests for ${directory}`,
        error,
      );
    }
  }
}
