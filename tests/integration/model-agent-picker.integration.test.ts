import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createAgentCardAction,
  createModelCardAction,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("model and agent picker integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("renders /model picker from live provider catalog", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.openCodeClients.config.providers.mockResolvedValue({
      data: {
        providers: [
          {
            id: "openai",
            models: {
              "gpt-4o": {},
              "gpt-4.1": {},
            },
          },
        ],
        default: {},
      },
    });

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-model-picker-1",
        messageId: "msg-model-picker-1",
        chatId: "chat-picker-1",
        text: "/model",
      }),
    );

    expect(harness.openCodeClients.config.providers).toHaveBeenCalledWith({
      directory: "/workspace/project",
    });
    expect(harness.renderer.sendCard).toHaveBeenCalledTimes(1);

    const sentCard = harness.renderer.sendCard.mock.calls[0][1] as {
      header: { title: { content: string } };
      elements: Array<{
        tag: string;
        actions?: Array<{
          value: {
            action?: string;
            command?: string;
            context?: Record<string, unknown>;
            value?: string;
          };
        }>;
      }>;
    };
    expect(sentCard.header.title.content).toBe("Model Picker");

    const actionEl = sentCard.elements.find(
      (element) => element.tag === "action",
    );
    expect(actionEl?.actions?.[0]?.value).toEqual({
      action: "selection_pick",
      command: "model",
      context: { level: "provider" },
      value: "openai",
    });
  });

  it("renders /agent picker from live agent catalog", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.openCodeClients.app.agents.mockResolvedValue({
      data: [
        { name: "build", mode: "primary" },
        { name: "oracle", mode: "all" },
      ],
    });

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-agent-picker-1",
        messageId: "msg-agent-picker-1",
        chatId: "chat-picker-2",
        text: "/agent",
      }),
    );

    expect(harness.openCodeClients.app.agents).toHaveBeenCalledWith({
      directory: "/workspace/project",
    });
    expect(harness.renderer.sendCard).toHaveBeenCalledTimes(1);

    const sentCard = harness.renderer.sendCard.mock.calls[0][1] as {
      header: { title: { content: string } };
      elements: Array<{
        tag: string;
        actions?: Array<{
          value: { action?: string; command?: string; value?: string };
        }>;
      }>;
    };
    expect(sentCard.header.title.content).toBe("Agent Picker");

    const actionEl = sentCard.elements.find(
      (element) => element.tag === "action",
    );
    const agentNames = (actionEl?.actions ?? []).map(
      (action) => action.value.value,
    );
    expect(agentNames).toContain("build");
    expect(agentNames).toContain("oracle");
    expect(actionEl?.actions?.[0]?.value.action).toBe("selection_pick");
    expect(actionEl?.actions?.[0]?.value.command).toBe("agent");
  });

  it("applies picker card selections and reflects them in /status", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    await harness.handleCardAction(
      createModelCardAction({
        eventId: "evt-model-select-1",
        modelName: "openai/gpt-4.1",
      }),
    );
    await harness.handleCardAction(
      createAgentCardAction({
        eventId: "evt-agent-select-1",
        agentName: "oracle",
      }),
    );

    expect(harness.renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Model selected: openai/gpt-4.1",
    );
    expect(harness.renderer.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Agent selected: oracle",
    );

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-status-picker-1",
        messageId: "msg-status-picker-1",
        chatId: "chat-picker-3",
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
    expect(markdownEl?.content).toContain("openai/gpt-4.1");
    expect(markdownEl?.content).toContain("oracle");
  });

  it("handles nested Feishu callback payloads and returns toast feedback", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    const result = await harness.handleCardAction({
      event_id: "evt-model-select-nested-1",
      event: {
        action: {
          value: { action: "select_model", modelName: "openai/gpt-4.1" },
        },
        context: {
          open_chat_id: "chat-picker-nested",
        },
      },
    });

    expect(result).toEqual({
      toast: {
        type: "success",
        content: "Model selected: openai/gpt-4.1",
      },
    });
    expect(harness.renderer.sendText).toHaveBeenCalledWith(
      "chat-picker-nested",
      "Model selected: openai/gpt-4.1",
    );
  });
});
