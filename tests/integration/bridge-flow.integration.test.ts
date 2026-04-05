import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createAssistantTextEvents,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("bridge flow integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("routes a prompt from message ingress through SSE updates to a final reply", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.setSseEvents(
      createAssistantTextEvents({
        sessionId: "session-1",
        text: "Bridge reply complete",
      }),
    );

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-bridge-flow-1",
        messageId: "source-msg-1",
        chatId: "chat-bridge-1",
        text: "Please summarize the repository state",
      }),
    );

    await harness.flushSession();

    expect(harness.openCodeClients.session.create).toHaveBeenCalledTimes(1);
    expect(harness.openCodeClients.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/project",
      parts: [{ type: "text", text: "Please summarize the repository state" }],
    });

    expect(harness.renderer.renderStatusCard).toHaveBeenCalledWith(
      "chat-bridge-1",
      "OpenCode is working",
      expect.any(String),
      false,
      "blue",
    );
    expect(harness.renderer.replyPost).toHaveBeenCalledWith(
      "source-msg-1",
      "OpenCode reply",
      [["Bridge reply complete"]],
      { uuid: expect.any(String) },
    );
    expect(harness.renderer.sendPost).not.toHaveBeenCalled();
  });
});
