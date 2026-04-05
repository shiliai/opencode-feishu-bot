import { describe, expect, it, vi } from "vitest";
import { FeishuEventRouter } from "../../src/feishu/event-router.js";
import { EventDeduplicator } from "../../src/feishu/event-deduplicator.js";
import { startFeishuWsClient } from "../../src/feishu/ws-client.js";

describe("startFeishuWsClient", () => {
  it("registers im.message.receive_v1 and starts the ws client", async () => {
    const register = vi.fn((handles) => handles);
    const start = vi.fn();
    const onMessageReceived = vi.fn();

    const router = new FeishuEventRouter({
      deduplicator: new EventDeduplicator({ ttlMs: 1000, now: () => 0 }),
      onMessageReceived,
      scheduleAsync: (task) => task(),
    });

    const dispatcher = await startFeishuWsClient({
      wsClient: { start },
      eventRouter: router,
      createEventDispatcher: () => ({ register }),
    });

    expect(register).toHaveBeenCalledTimes(1);
    const handles = register.mock.calls[0][0] as Record<string, (data: unknown) => void>;
    expect(Object.keys(handles)).toEqual(["im.message.receive_v1"]);

    const event = { header: { event_id: "evt-1", event_type: "im.message.receive_v1" } };
    handles["im.message.receive_v1"](event);

    expect(onMessageReceived).toHaveBeenCalledWith(event);
    expect(start).toHaveBeenCalledWith({ eventDispatcher: dispatcher });
  });
});
