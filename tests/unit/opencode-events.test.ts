import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

const { createOpencodeClientMock } = vi.hoisted(() => ({
  createOpencodeClientMock: vi.fn(() => ({
    event: { subscribe: vi.fn() },
  })),
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

function clearEnv(): void {
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
}

function makeEvent(type: string): Event {
  return { type } as Event;
}

describe("OpenCodeEventSubscriber", () => {
  beforeEach(() => {
    clearEnv();
    process.env.FEISHU_APP_ID = "test-app-id";
    process.env.FEISHU_APP_SECRET = "test-app-secret";
    createOpencodeClientMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.resetModules();
  });

  it("dispatches stream events and stops cleanly", async () => {
    const { OpenCodeEventSubscriber } = await import("../../src/opencode/events.js");
    const received: Event[] = [];

    const client = {
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* (): AsyncGenerator<Event, void, unknown> {
            yield makeEvent("event.one");
            yield makeEvent("event.two");
          })(),
        }),
      },
    };

    const subscriber = new OpenCodeEventSubscriber({
      client: client as never,
      scheduleCallback: (callback) => callback(),
    });

    await subscriber.subscribeToEvents("/workspace", (event) => {
      received.push(event);
      if (received.length === 2) {
        subscriber.stopEventListening();
      }
    });

    expect(received).toEqual([makeEvent("event.one"), makeEvent("event.two")]);
    expect(client.event.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.getSnapshot()).toEqual({ activeDirectory: null, isListening: false });
  });

  it("reconnects with exponential backoff after non-fatal stream errors", async () => {
    const { OpenCodeEventSubscriber } = await import("../../src/opencode/events.js");
    const reconnectDelays: number[] = [];
    const received: Event[] = [];

    const client = {
      event: {
        subscribe: vi
          .fn()
          .mockResolvedValueOnce({
            stream: (async function* (): AsyncGenerator<Event, void, unknown> {
              yield makeEvent("event.before-reconnect");
              throw new Error("stream broke");
            })(),
          })
          .mockResolvedValueOnce({
            stream: (async function* (): AsyncGenerator<Event, void, unknown> {
              yield makeEvent("event.after-reconnect");
            })(),
          }),
      },
    };

    const subscriber = new OpenCodeEventSubscriber({
      client: client as never,
      scheduleCallback: (callback) => callback(),
      waitFn: async (delayMs) => {
        reconnectDelays.push(delayMs);
        return true;
      },
    });

    await subscriber.subscribeToEvents("/workspace", (event) => {
      received.push(event);
      if (received.length === 2) {
        subscriber.stopEventListening();
      }
    });

    expect(received).toEqual([
      makeEvent("event.before-reconnect"),
      makeEvent("event.after-reconnect"),
    ]);
    expect(reconnectDelays).toEqual([1000]);
    expect(client.event.subscribe).toHaveBeenCalledTimes(2);
  });

  it("throws a fatal error when subscribe returns no stream", async () => {
    const { FATAL_NO_STREAM_ERROR, OpenCodeEventSubscriber } = await import(
      "../../src/opencode/events.js"
    );
    const client = {
      event: {
        subscribe: vi.fn().mockResolvedValue({}),
      },
    };

    const subscriber = new OpenCodeEventSubscriber({ client: client as never });

    await expect(
      subscriber.subscribeToEvents("/workspace", () => undefined),
    ).rejects.toThrow(FATAL_NO_STREAM_ERROR);
  });

  it("supports external AbortController shutdown", async () => {
    const { OpenCodeEventSubscriber } = await import("../../src/opencode/events.js");
    const controller = new AbortController();
    const received: Event[] = [];

    const client = {
      event: {
        subscribe: vi.fn().mockImplementation(
          async (
            _query: unknown,
            options: { signal?: AbortSignal } | undefined,
          ): Promise<{ stream: AsyncGenerator<Event, void, unknown> }> => ({
            stream: (async function* (): AsyncGenerator<Event, void, unknown> {
              yield makeEvent("event.abortable");
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) {
                  resolve();
                  return;
                }

                options?.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            })(),
          }),
        ),
      },
    };

    const subscriber = new OpenCodeEventSubscriber({
      client: client as never,
      scheduleCallback: (callback) => callback(),
    });

    await subscriber.subscribeToEvents(
      "/workspace",
      (event) => {
        received.push(event);
        controller.abort();
      },
      { signal: controller.signal },
    );

    expect(received).toEqual([makeEvent("event.abortable")]);
    expect(client.event.subscribe).toHaveBeenCalledTimes(1);
  });
});
