import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createSessionCardAction,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("sessions picker integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("selecting a session updates active state and confirms the choice", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.openCodeClients.session.get.mockResolvedValue({
      data: {
        id: "session-2",
        title: "Recovered Session",
        directory: "/workspace/project",
      },
      error: undefined,
    });

    const result = await harness.handleCardAction(
      createSessionCardAction({
        eventId: "evt-session-select-1",
        chatId: "chat-session-1",
        sessionId: "session-2",
      }),
    );

    expect(result).toEqual({
      toast: {
        type: "success",
        content: expect.stringContaining(
          "Session selected: Recovered Session (session-2)",
        ),
      },
    });
    expect(harness.renderer.sendText).toHaveBeenCalledWith(
      "chat-session-1",
      expect.stringContaining(
        "Session selected: Recovered Session (session-2)",
      ),
    );
    expect(harness.sessionManager.getChatSession("chat-session-1")).toEqual({
      id: "session-2",
      title: "Recovered Session",
      directory: "/workspace/project",
    });

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-session-status-1",
        messageId: "msg-session-status-1",
        chatId: "chat-session-1",
        text: "/status",
      }),
    );

    const statusCall =
      harness.renderer.sendCard.mock.calls[
        harness.renderer.sendCard.mock.calls.length - 1
      ];
    const statusCard = statusCall?.[1] as {
      header: { title: { content: string } };
      elements: Array<{ tag: string; content?: string }>;
    };
    expect(statusCard.header.title.content).toBe("OpenCode Status");
    const markdownEl = statusCard.elements.find(
      (element) => element.tag === "markdown",
    );
    expect(markdownEl?.content).toContain("**Session**: session-2");
    expect(markdownEl?.content).toContain(
      "**Session Title**: Recovered Session",
    );
  });
});
