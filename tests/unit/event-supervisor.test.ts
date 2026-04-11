import type { Event } from "@opencode-ai/sdk/v2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventSupervisor } from "../../src/events/supervisor.js";
import type {
  OpenCodeEventSubscriber,
  SubscribeToEventsOptions,
} from "../../src/opencode/events.js";
import { PendingInteractionStore } from "../../src/pending/store.js";
import type { Logger } from "../../src/utils/logger.js";

type EventCallback = (event: Event) => void;

type EventSupervisorClient = NonNullable<
  ConstructorParameters<typeof EventSupervisor>[0]["client"]
>;

function makeEvent(
  type: string,
  properties: Record<string, unknown> = {},
): Event {
  return {
    type,
    properties,
  } as unknown as Event;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EventSupervisor", () => {
  let subscribeToEvents: ReturnType<typeof vi.fn>;
  let stopEventListening: ReturnType<typeof vi.fn>;
  let eventSubscriber: Pick<
    OpenCodeEventSubscriber,
    "subscribeToEvents" | "stopEventListening"
  >;
  let summaryAggregator: { processEvent: ReturnType<typeof vi.fn> };
  let pendingStore: PendingInteractionStore;
  let client: EventSupervisorClient;
  let logger: Logger;
  let supervisor: EventSupervisor;

  beforeEach(() => {
    subscribeToEvents = vi
      .fn<
        (
          directory: string,
          callback: EventCallback,
          options?: SubscribeToEventsOptions,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    stopEventListening = vi.fn();

    eventSubscriber = {
      subscribeToEvents:
        subscribeToEvents as OpenCodeEventSubscriber["subscribeToEvents"],
      stopEventListening:
        stopEventListening as OpenCodeEventSubscriber["stopEventListening"],
    };

    summaryAggregator = {
      processEvent: vi.fn(),
    };

    pendingStore = new PendingInteractionStore();

    client = {
      question: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      permission: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    };

    logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    supervisor = new EventSupervisor({
      eventSubscriber: eventSubscriber as OpenCodeEventSubscriber,
      summaryAggregator,
      pendingStore,
      client,
      logger,
    });
  });

  it("ensureSubscribed starts subscription for new directory", () => {
    supervisor.ensureSubscribed("/workspace/a");

    expect(eventSubscriber.subscribeToEvents).toHaveBeenCalledWith(
      "/workspace/a",
      expect.any(Function),
    );
  });

  it("ensureSubscribed is no-op for same directory", () => {
    supervisor.ensureSubscribed("/workspace/a");
    supervisor.ensureSubscribed("/workspace/a");

    expect(eventSubscriber.subscribeToEvents).toHaveBeenCalledTimes(1);
  });

  it("ensureSubscribed restarts for different directory", () => {
    supervisor.ensureSubscribed("/workspace/a");
    supervisor.ensureSubscribed("/workspace/b");

    expect(eventSubscriber.stopEventListening).toHaveBeenCalledTimes(1);
    expect(eventSubscriber.subscribeToEvents).toHaveBeenNthCalledWith(
      2,
      "/workspace/b",
      expect.any(Function),
    );
  });

  it("onEvent forwards all events to summaryAggregator", () => {
    supervisor.ensureSubscribed("/workspace/a");

    const callback = subscribeToEvents.mock.calls[0]?.[1];
    const event = makeEvent("message.updated", { id: "msg-1" });
    callback?.(event);

    expect(summaryAggregator.processEvent).toHaveBeenCalledWith(event);
  });

  it("onEvent removes from pendingStore on question.replied", () => {
    pendingStore.add("req-1", "sess-1", "/workspace/a", "chat-1", "question");
    supervisor.ensureSubscribed("/workspace/a");

    const callback = subscribeToEvents.mock.calls[0]?.[1];
    callback?.(
      makeEvent("question.replied", {
        sessionID: "sess-1",
        requestID: "req-1",
      }),
    );

    expect(pendingStore.has("req-1")).toBe(false);
  });

  it("onEvent removes from pendingStore on question.rejected", () => {
    pendingStore.add("req-1", "sess-1", "/workspace/a", "chat-1", "question");
    supervisor.ensureSubscribed("/workspace/a");

    const callback = subscribeToEvents.mock.calls[0]?.[1];
    callback?.(
      makeEvent("question.rejected", {
        sessionID: "sess-1",
        id: "req-1",
      }),
    );

    expect(pendingStore.has("req-1")).toBe(false);
  });

  it("onEvent removes from pendingStore on permission.replied", () => {
    pendingStore.add("req-1", "sess-1", "/workspace/a", "chat-1", "permission");
    supervisor.ensureSubscribed("/workspace/a");

    const callback = subscribeToEvents.mock.calls[0]?.[1];
    callback?.(
      makeEvent("permission.replied", {
        sessionID: "sess-1",
        requestID: "req-1",
      }),
    );

    expect(pendingStore.has("req-1")).toBe(false);
  });

  it("onEvent does not touch pendingStore for other event types", () => {
    pendingStore.add("req-1", "sess-1", "/workspace/a", "chat-1", "question");
    supervisor.ensureSubscribed("/workspace/a");

    const callback = subscribeToEvents.mock.calls[0]?.[1];
    callback?.(makeEvent("message.updated", { id: "msg-1" }));

    expect(pendingStore.has("req-1")).toBe(true);
  });

  it("bootstrap hydrates pendingStore from question.list and permission.list", async () => {
    client.question.list = vi.fn().mockResolvedValue({
      data: [{ id: "q-1", sessionID: "sess-q" }],
    });
    client.permission.list = vi.fn().mockResolvedValue({
      data: [{ id: "p-1", sessionID: "sess-p" }],
    });

    supervisor.ensureSubscribed("/workspace/a");
    await flushPromises();

    expect(client.question.list).toHaveBeenCalledWith({
      directory: "/workspace/a",
    });
    expect(client.permission.list).toHaveBeenCalledWith({
      directory: "/workspace/a",
    });
    expect(pendingStore.get("q-1")).toMatchObject({
      requestId: "q-1",
      sessionId: "sess-q",
      directory: "/workspace/a",
      chatId: "",
      type: "question",
    });
    expect(pendingStore.get("p-1")).toMatchObject({
      requestId: "p-1",
      sessionId: "sess-p",
      directory: "/workspace/a",
      chatId: "",
      type: "permission",
    });
  });

  it("bootstrap failure is logged but does not crash", async () => {
    const failure = new Error("question list failed");
    client.question.list = vi.fn().mockRejectedValue(failure);
    client.permission.list = vi.fn().mockResolvedValue({
      data: [{ id: "p-1", sessionID: "sess-p" }],
    });

    expect(() => supervisor.ensureSubscribed("/workspace/a")).not.toThrow();
    await flushPromises();

    expect(logger.error).toHaveBeenCalledWith(
      "[EventSupervisor] Failed to hydrate pending question requests for /workspace/a",
      failure,
    );
    expect(pendingStore.get("p-1")).toMatchObject({
      requestId: "p-1",
      type: "permission",
    });
  });

  it("stop calls stopEventListening", () => {
    supervisor.ensureSubscribed("/workspace/a");

    supervisor.stop();

    expect(eventSubscriber.stopEventListening).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot returns current state", () => {
    expect(supervisor.getSnapshot()).toEqual({
      directory: null,
      isSubscribed: false,
    });

    supervisor.ensureSubscribed("/workspace/a");

    expect(supervisor.getSnapshot()).toEqual({
      directory: "/workspace/a",
      isSubscribed: true,
    });

    supervisor.stop();

    expect(supervisor.getSnapshot()).toEqual({
      directory: null,
      isSubscribed: false,
    });
  });
});
