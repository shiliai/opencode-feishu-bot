import { afterEach, describe, expect, it } from "vitest";
import {
  createBridgeHarness,
  createPermissionFixture,
  createQuestionFixture,
} from "./helpers/bridge-harness.js";
import {
  createAssistantTextEvents,
  createPermissionAskedEvent,
  createPermissionCardAction,
  createQuestionAskedEvent,
  createQuestionCardAction,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("question and permission integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("renders a question card from SSE and forwards the chosen answer from the callback", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.setSseEvents([
      createQuestionAskedEvent({
        sessionId: "session-1",
        requestId: "question-request-1",
        questions: createQuestionFixture(),
      }),
      ...createAssistantTextEvents({
        sessionId: "session-1",
        text: "Question handled",
      }),
    ]);

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-question-1",
        messageId: "source-msg-question-1",
        chatId: "chat-question-1",
        text: "Ask me a question",
      }),
    );

    await harness.flushSession();

    expect(harness.renderer.renderQuestionCard).toHaveBeenCalledWith(
      "chat-question-1",
      createQuestionFixture()[0],
      "question-request-1",
    );

    await harness.handleCardAction(
      createQuestionCardAction({
        messageId: "question-card-1",
        requestId: "question-request-1",
        optionIndex: 0,
      }),
    );

    expect(harness.openCodeClients.question.reply).toHaveBeenCalledWith({
      requestID: "question-request-1",
      answers: [["React"]],
    });
  });

  it("renders a permission card from SSE and forwards the approval callback exactly once", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    const permissionRequest = createPermissionFixture();
    harness.setSseEvents([
      createPermissionAskedEvent({ request: permissionRequest }),
      ...createAssistantTextEvents({
        sessionId: "session-1",
        text: "Permission handled",
      }),
    ]);

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-permission-1",
        messageId: "source-msg-permission-1",
        chatId: "chat-permission-1",
        text: "Request a permission",
      }),
    );

    await harness.flushSession();

    expect(harness.renderer.renderPermissionCard).toHaveBeenCalledWith(
      "chat-permission-1",
      permissionRequest,
    );

    await harness.handleCardAction(
      createPermissionCardAction({
        messageId: "permission-card-1",
        requestId: permissionRequest.id,
        reply: "approve",
      }),
    );

    expect(harness.openCodeClients.permission.reply).toHaveBeenCalledWith({
      requestID: permissionRequest.id,
      reply: "once",
    });
    expect(harness.openCodeClients.permission.reply).toHaveBeenCalledTimes(1);
  });
});
