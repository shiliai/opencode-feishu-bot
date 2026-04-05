import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createAssistantTextEvents,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("duplicate event integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("rejects replayed websocket events and dispatches the prompt only once", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.setSseEvents(
      createAssistantTextEvents({
        sessionId: "session-1",
        text: "Only one reply should be emitted",
      }),
    );

    const duplicateEvent = createTextMessageEvent({
      eventId: "evt-duplicate-1",
      messageId: "source-msg-duplicate",
      chatId: "chat-duplicate-1",
      text: "Run once",
    });

    await harness.handleMessageReceived(duplicateEvent);
    await harness.handleMessageReceived(duplicateEvent);

    await harness.flushSession();

    expect(harness.openCodeClients.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(harness.renderer.replyPost).toHaveBeenCalledTimes(1);
  });
});
