import { afterEach, describe, expect, it } from "vitest";
import { createBridgeHarness } from "./helpers/bridge-harness.js";
import {
  createProjectCardAction,
  createTextMessageEvent,
} from "./helpers/fixtures.js";

describe("projects picker integration", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createBridgeHarness>>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("renders /projects picker from live project catalog", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.openCodeClients.project.list.mockResolvedValue({
      data: [
        {
          id: "project-1",
          worktree: "/workspace/project-one",
          name: "Project One",
        },
        {
          id: "project-2",
          worktree: "/workspace/project-two",
          name: "Project Two",
        },
      ],
    });

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-project-picker-1",
        messageId: "msg-project-picker-1",
        chatId: "chat-project-1",
        text: "/projects",
      }),
    );

    expect(harness.openCodeClients.project.list).toHaveBeenCalledTimes(1);
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
    expect(sentCard.header.title.content).toBe("Projects");

    const actionEl = sentCard.elements.find(
      (element) => element.tag === "action",
    );
    const projectIds = (actionEl?.actions ?? []).map(
      (action) => action.value.value,
    );
    expect(projectIds).toContain("project-1");
    expect(projectIds).toContain("project-2");
    expect(actionEl?.actions?.[0]?.value.action).toBe("selection_pick");
    expect(actionEl?.actions?.[0]?.value.command).toBe("project");
  });

  it("selecting project updates /sessions directory scope", async () => {
    const harness = await createBridgeHarness();
    harnesses.push(harness);

    harness.openCodeClients.project.list.mockResolvedValue({
      data: [
        {
          id: "project-1",
          worktree: "/workspace/project-one",
          name: "Project One",
        },
        {
          id: "project-2",
          worktree: "/workspace/project-two",
          name: "Project Two",
        },
      ],
    });

    const result = await harness.handleCardAction(
      createProjectCardAction({
        eventId: "evt-project-select-1",
        chatId: "chat-project-2",
        projectId: "project-2",
      }),
    );

    expect(result).toEqual({
      toast: {
        type: "success",
        content:
          "Project selected: Project Two\n\nActive session cleared. Use /sessions or /new for this project.",
      },
    });
    expect(harness.renderer.sendText).toHaveBeenCalledWith(
      "chat-project-2",
      expect.stringContaining("Project selected: Project Two"),
    );

    await harness.handleMessageReceived(
      createTextMessageEvent({
        eventId: "evt-project-sessions-1",
        messageId: "msg-project-sessions-1",
        chatId: "chat-project-2",
        text: "/sessions",
      }),
    );

    expect(harness.openCodeClients.session.list).toHaveBeenCalledWith({
      directory: "/workspace/project-two",
      roots: true,
    });
  });
});
