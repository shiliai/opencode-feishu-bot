import type {
  InteractiveCard,
  InteractiveCardElement,
  InteractiveCardActionItem,
} from "@larksuiteoapi/node-sdk";
import { plainText } from "./cards.js";

export interface SessionSummary {
  id: string;
  title?: string;
  [key: string]: unknown;
}

const COMMAND_HELP: Array<{ command: string; description: string }> = [
  { command: "/help", description: "Show available commands" },
  { command: "/new", description: "Create a new session" },
  { command: "/sessions", description: "List recent sessions" },
  { command: "/session [id]", description: "Switch to a session (or show picker)" },
  { command: "/model [name]", description: "Switch model (or show picker)" },
  { command: "/agent [name]", description: "Switch agent (or show picker)" },
  { command: "/status", description: "Show current status" },
  { command: "/abort", description: "Abort the current session" },
];

export function buildHelpCard(): InteractiveCard {
  const commandLines = COMMAND_HELP.map(
    (c) => `**${c.command}** — ${c.description}`,
  );
  const content = commandLines.join("\n");

  return {
    header: {
      title: plainText("OpenCode Commands"),
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
}

export function buildSessionListCard(
  sessions: SessionSummary[],
): InteractiveCard {
  const elements: InteractiveCardElement[] = [];

  if (sessions.length === 0) {
    elements.push({
      tag: "markdown",
      content: "No recent sessions found.",
    });
  } else {
    const lines = sessions
      .map(
        (s, i) =>
          `${i + 1}. **${s.id}**${s.title ? ` — ${s.title}` : ""}`,
      )
      .join("\n");
    elements.push({
      tag: "markdown",
      content: lines,
    });

    const buttons: InteractiveCardActionItem[] = sessions.slice(0, 10).map((s) => ({
      tag: "button",
      text: plainText(s.id),
      value: { action: "select_session", sessionId: s.id },
    }));
    elements.push({
      tag: "action",
      actions: buttons,
    });
  }

  return {
    header: {
      title: plainText("Sessions"),
      template: "blue",
    },
    elements,
  };
}

export function buildModelPickerCard(models: string[]): InteractiveCard {
  const elements: InteractiveCardElement[] = [];

  if (models.length === 0) {
    elements.push({
      tag: "markdown",
      content: "No models available.",
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "Select a model:",
    });

    const buttons: InteractiveCardActionItem[] = models.map((m) => ({
      tag: "button",
      text: plainText(m),
      value: { action: "select_model", modelName: m },
    }));
    elements.push({
      tag: "action",
      actions: buttons,
    });
  }

  return {
    header: {
      title: plainText("Model Picker"),
      template: "blue",
    },
    elements,
  };
}

export function buildAgentPickerCard(agents: string[]): InteractiveCard {
  const elements: InteractiveCardElement[] = [];

  if (agents.length === 0) {
    elements.push({
      tag: "markdown",
      content: "No agents available.",
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "Select an agent:",
    });

    const buttons: InteractiveCardActionItem[] = agents.map((a) => ({
      tag: "button",
      text: plainText(a),
      value: { action: "select_agent", agentName: a },
    }));
    elements.push({
      tag: "action",
      actions: buttons,
    });
  }

  return {
    header: {
      title: plainText("Agent Picker"),
      template: "blue",
    },
    elements,
  };
}

export function buildStatusCard(status: {
  session: string | null;
  model: string | null;
  agent: string | null;
  state: string;
}): InteractiveCard {
  const lines: string[] = [];
  lines.push(`**Session**: ${status.session ?? "none"}`);
  lines.push(`**Model**: ${status.model ?? "none"}`);
  lines.push(`**Agent**: ${status.agent ?? "none"}`);
  lines.push(`**State**: ${status.state}`);

  return {
    header: {
      title: plainText("OpenCode Status"),
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: lines.join("\n"),
      },
    ],
  };
}
