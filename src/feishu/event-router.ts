import type { Logger } from "../utils/logger.js";
import { logger as defaultLogger } from "../utils/logger.js";
import type { EventDeduplicator } from "./event-deduplicator.js";

export interface FeishuMessageReceiveEvent {
  header?: {
    event_id?: string;
    event_type?: string;
  };
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FeishuEventRouterOptions {
  deduplicator: EventDeduplicator;
  logger?: Logger;
  onMessageReceived?: (event: FeishuMessageReceiveEvent) => Promise<void> | void;
  onCardAction?: (event: Record<string, unknown>) => Promise<unknown> | unknown;
  scheduleAsync?: (task: () => void) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  const nested = getNestedValue(value, path);
  return typeof nested === "string" ? nested : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function extractFeishuEventId(event: FeishuMessageReceiveEvent): string | null {
  return event.header?.event_id ?? getNestedString(event, ["event_id"]) ?? null;
}

export function extractCardActionDedupKey(event: Record<string, unknown>): string | null {
  const eventId = getNestedString(event, ["event_id"]) ?? getNestedString(event, ["header", "event_id"]);
  if (eventId) {
    return eventId;
  }

  const openMessageId =
    getNestedString(event, ["open_message_id"]) ??
    getNestedString(event, ["context", "open_message_id"]);
  const tenantKey =
    getNestedString(event, ["tenant_key"]) ?? getNestedString(event, ["context", "tenant_key"]);
  const operatorOpenId =
    getNestedString(event, ["operator", "open_id"]) ??
    getNestedString(event, ["operator", "operator_id", "open_id"]);
  const token = getNestedString(event, ["token"]);
  const actionValue =
    getNestedValue(event, ["action", "value"]) ?? getNestedValue(event, ["action", "name"]);
  const formValue =
    getNestedValue(event, ["action", "form_value"]) ?? getNestedValue(event, ["form_value"]);

  if (
    !openMessageId &&
    !tenantKey &&
    !operatorOpenId &&
    !token &&
    actionValue === undefined &&
    formValue === undefined
  ) {
    return null;
  }

  return stableStringify({
    openMessageId,
    tenantKey,
    operatorOpenId,
    token,
    actionValue,
    formValue,
  });
}

export class FeishuEventRouter {
  private readonly deduplicator: EventDeduplicator;
  private readonly logger: Logger;
  private readonly onMessageReceived?: (event: FeishuMessageReceiveEvent) => Promise<void> | void;
  private readonly onCardAction?: (event: Record<string, unknown>) => Promise<unknown> | unknown;
  private readonly scheduleAsync: (task: () => void) => void;
  private readonly emptyCardActionResponse: Record<string, never> = {};

  constructor(options: FeishuEventRouterOptions) {
    this.deduplicator = options.deduplicator;
    this.logger = options.logger ?? defaultLogger;
    this.onMessageReceived = options.onMessageReceived;
    this.onCardAction = options.onCardAction;
    this.scheduleAsync = options.scheduleAsync ?? ((task) => setImmediate(task));
  }

  handleMessageReceived(event: FeishuMessageReceiveEvent): void {
    const eventId = extractFeishuEventId(event);
    if (eventId && !this.deduplicator.claim(`ws:${eventId}`)) {
      this.logger.debug(`[FeishuEventRouter] Dropped duplicate websocket event: ${eventId}`);
      return;
    }

    this.scheduleAsync(() => {
      void Promise.resolve(this.onMessageReceived?.(event)).catch((error: unknown) => {
        this.logger.error("[FeishuEventRouter] Failed to process websocket event", error);
      });
    });
  }

  async handleCardAction(event: unknown): Promise<unknown> {
    const record = isRecord(event) ? event : null;
    if (!record) {
      return this.emptyCardActionResponse;
    }

    const dedupKey = extractCardActionDedupKey(record);
    if (dedupKey && !this.deduplicator.claim(`card:${dedupKey}`)) {
      this.logger.debug("[FeishuEventRouter] Dropped duplicate card action");
      return this.emptyCardActionResponse;
    }

    try {
      return (await this.onCardAction?.(record)) ?? this.emptyCardActionResponse;
    } catch (error) {
      this.logger.error("[FeishuEventRouter] Failed to process card action", error);
      return this.emptyCardActionResponse;
    }
  }
}
