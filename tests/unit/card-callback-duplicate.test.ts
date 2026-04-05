import { describe, expect, it, vi } from "vitest";
import { EventDeduplicator } from "../../src/feishu/event-deduplicator.js";
import {
  FeishuEventRouter,
  extractCardActionDedupKey,
  extractFeishuEventId,
} from "../../src/feishu/event-router.js";

describe("FeishuEventRouter deduplication", () => {
  it("drops duplicate websocket events by event_id", () => {
    const onMessageReceived = vi.fn();
    const router = new FeishuEventRouter({
      deduplicator: new EventDeduplicator({ ttlMs: 1000, now: () => 0 }),
      onMessageReceived,
      scheduleAsync: (task) => task(),
    });

    const event = { header: { event_id: "evt-1", event_type: "im.message.receive_v1" } };
    router.handleMessageReceived(event);
    router.handleMessageReceived(event);

    expect(onMessageReceived).toHaveBeenCalledTimes(1);
    expect(extractFeishuEventId(event)).toBe("evt-1");
  });

  it("drops duplicate card actions with the same derived action key", async () => {
    const onCardAction = vi.fn().mockResolvedValue({ code: 0 });
    const router = new FeishuEventRouter({
      deduplicator: new EventDeduplicator({ ttlMs: 1000, now: () => 0 }),
      onCardAction,
    });

    const cardAction = {
      event_id: "card-event-1",
      open_message_id: "om_123",
      token: "verification-token",
      operator: { open_id: "ou_1" },
      action: {
        value: { action: "approve" },
        form_value: { note: "done" },
      },
    };

    await router.handleCardAction(cardAction);
    await router.handleCardAction(cardAction);

    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(extractCardActionDedupKey(cardAction)).toBe("card-event-1");
  });
});
