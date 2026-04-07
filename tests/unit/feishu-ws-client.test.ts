import { describe, expect, it, vi } from "vitest";
import { FeishuEventRouter } from "../../src/feishu/event-router.js";
import { EventDeduplicator } from "../../src/feishu/event-deduplicator.js";
import { startFeishuWsClient } from "../../src/feishu/ws-client.js";

describe("startFeishuWsClient", () => {
  it("registers message and card-action handlers and starts the ws client", async () => {
    const register = vi.fn((handles) => handles);
    const start = vi.fn();
    const onMessageReceived = vi.fn();
    const onCardAction = vi.fn().mockResolvedValue({});

    const router = new FeishuEventRouter({
      deduplicator: new EventDeduplicator({ ttlMs: 1000, now: () => 0 }),
      onMessageReceived,
      onCardAction,
      scheduleAsync: (task) => task(),
    });

    const dispatcher = await startFeishuWsClient({
      wsClient: { start },
      eventRouter: router,
      createEventDispatcher: () => ({ register }),
    });

    expect(register).toHaveBeenCalledTimes(1);
    const handles = register.mock.calls[0][0] as Record<
      string,
      (data: unknown) => void
    >;
    expect(Object.keys(handles)).toEqual([
      "im.message.receive_v1",
      "card.action.trigger",
    ]);

    const event = {
      header: { event_id: "evt-1", event_type: "im.message.receive_v1" },
    };
    handles["im.message.receive_v1"](event);

    const cardActionEvent = {
      event_id: "evt-card-1",
      open_message_id: "om_123",
      action: { value: { action: "select_agent", agentName: "build" } },
    };
    await handles["card.action.trigger"](cardActionEvent);

    expect(onMessageReceived).toHaveBeenCalledWith(event);
    expect(onCardAction).toHaveBeenCalledWith(cardActionEvent);
    expect(start).toHaveBeenCalledWith({ eventDispatcher: dispatcher });
  });
});
