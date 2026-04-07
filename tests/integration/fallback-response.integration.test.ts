import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createAssistantTextEvents,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("fallback response integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("still delivers the final reply when status card updates fail", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.renderer.updateStatusCard.mockRejectedValueOnce(
      new Error("patch failed"),
    );
    harness.setSseEvents(
      createAssistantTextEvents({
        sessionId: "session-1",
        text: "Final response survives card failure",
      }),
    );

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-fallback-1",
        messageId: "source-msg-fallback-1",
        chatId: "chat-fallback-1",
        text: "Trigger the fallback path",
      }),
    );

    await harness.flushSession();

    expect(
      harness.renderer.renderCompleteCard.mock.calls.length +
        harness.renderer.updateCompleteCard.mock.calls.length,
    ).toBeGreaterThan(0);
    expect(harness.renderer.replyPost).not.toHaveBeenCalled();
    expect(harness.renderer.sendPost).not.toHaveBeenCalled();
  });

  it("falls back to a non-threaded post when complete-card and reply-post delivery fail", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.renderer.updateCompleteCard.mockRejectedValueOnce(
      new Error("complete card patch failed"),
    );
    harness.renderer.replyPost.mockRejectedValueOnce(new Error("reply failed"));
    harness.setSseEvents(
      createAssistantTextEvents({
        sessionId: "session-1",
        text: "Fallback to sendPost",
      }),
    );

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-fallback-2",
        messageId: "source-msg-fallback-2",
        chatId: "chat-fallback-2",
        text: "Break replyPost",
      }),
    );

    await harness.flushSession();

    expect(harness.renderer.replyPost).toHaveBeenCalledTimes(1);
    expect(harness.renderer.sendPost).toHaveBeenCalledWith(
      "chat-fallback-2",
      "OpenCode reply",
      [["Fallback to sendPost"]],
    );
  });
});
