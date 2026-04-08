import type {
  InteractiveCard,
  InteractiveCardActionItem,
  InteractiveCardElement,
} from "@larksuiteoapi/node-sdk";
import { getConfig } from "../config.js";
import { plainText } from "./cards.js";
import type { ChatMessage } from "./message-reader.js";

export interface SessionSummary {
  id: string;
  title?: string;
  [key: string]: unknown;
}

export interface ProjectSummary {
  id: string;
  worktree: string;
  name?: string;
}

export interface ProjectPickerEntry {
  id?: string;
  worktree: string;
  name?: string;
  isNew?: boolean;
}

const COMMAND_HELP: Array<{ command: string; description: string }> = [
  { command: "/help", description: "Show available commands" },
  { command: "/new", description: "Create a new session" },
  { command: "/projects [id]", description: "Select OpenCode project scope" },
  { command: "/sessions", description: "List recent sessions" },
  {
    command: "/session [id]",
    description: "Switch to a session (or show picker)",
  },
  { command: "/history [count]", description: "Show recent chat messages" },
  { command: "/model [name]", description: "Switch model (or show picker)" },
  { command: "/agent [name]", description: "Switch agent (or show picker)" },
  { command: "/status", description: "Show current status" },
  { command: "/version", description: "Show bridge version" },
  { command: "/abort", description: "Abort the current session" },
];

const HISTORY_PREVIEW_LIMIT = 200;
const MAX_ACTIONS_PER_ROW = 5;
const MAX_SESSION_CHOICES = 10;
const MAX_MODEL_CHOICES = 20;
const MAX_AGENT_CHOICES = 20;
const MAX_PROJECT_CHOICES = 20;
const MAX_BUTTON_LABEL_LENGTH = 58;

function truncateLabel(label: string, limit = MAX_BUTTON_LABEL_LENGTH): string {
  if (label.length <= limit) {
    return label;
  }

  if (limit <= 1) {
    return label.slice(0, limit);
  }

  return `${label.slice(0, limit - 1)}…`;
}

function buildActionRows(
  actions: InteractiveCardActionItem[],
): InteractiveCardElement[] {
  const rows: InteractiveCardElement[] = [];

  for (let index = 0; index < actions.length; index += MAX_ACTIONS_PER_ROW) {
    rows.push({
      tag: "action",
      actions: actions.slice(index, index + MAX_ACTIONS_PER_ROW),
    });
  }

  return rows;
}

export function getPathLeaf(pathValue: string): string {
  const normalized = pathValue.replace(/[\\/]+$/g, "");
  if (!normalized) {
    return pathValue;
  }

  const segments = normalized
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.at(-1) ?? normalized;
}

function formatHistoryTimestamp(createdAt: string): string {
  const parsedDate = new Date(createdAt);
  if (Number.isNaN(parsedDate.getTime())) {
    return "--:--";
  }

  const hours = String(parsedDate.getHours()).padStart(2, "0");
  const minutes = String(parsedDate.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatHistorySender(message: ChatMessage): string {
  const senderId = message.senderId.trim();
  if (senderId) {
    return senderId;
  }

  return message.senderType;
}

function buildHistoryPreview(content: string): string {
  const normalized =
    content.replace(/\r\n/g, "\n").trim() || "[no readable content]";
  if (normalized.length <= HISTORY_PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, HISTORY_PREVIEW_LIMIT - 1)}…`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }

  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}K`;
  }

  return count.toString();
}

export function buildHelpCard(): InteractiveCard {
  const commandLines = COMMAND_HELP.map(
    (c) => `**${c.command}** — ${c.description}`,
  );
  const content = commandLines.join("\n");

  return {
    header: {
      title: plainText(`${getConfig().assistantName} Commands`),
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
    const visibleSessions = sessions.slice(0, MAX_SESSION_CHOICES);

    elements.push({
      tag: "markdown",
      content: "Select a session:",
    });

    const buttons: InteractiveCardActionItem[] = visibleSessions.map(
      (session, index) => {
        const baseLabel = session.title?.trim().length
          ? `${session.title.trim()} (${session.id})`
          : session.id;
        return {
          tag: "button",
          text: plainText(truncateLabel(`${index + 1}. ${baseLabel}`)),
          value: { action: "select_session", sessionId: session.id },
        };
      },
    );

    elements.push(...buildActionRows(buttons));

    if (sessions.length > visibleSessions.length) {
      elements.push({
        tag: "markdown",
        content: `Showing ${visibleSessions.length} of ${sessions.length} sessions. Use /session <id> to switch by id.`,
      });
    }
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
    const visibleModels = models.slice(0, MAX_MODEL_CHOICES);

    elements.push({
      tag: "markdown",
      content: "Select a model:",
    });

    const buttons: InteractiveCardActionItem[] = visibleModels.map(
      (modelName) => ({
        tag: "button",
        text: plainText(truncateLabel(modelName)),
        value: { action: "select_model", modelName },
      }),
    );

    elements.push(...buildActionRows(buttons));

    if (models.length > visibleModels.length) {
      elements.push({
        tag: "markdown",
        content: `Showing ${visibleModels.length} of ${models.length} models. Use /model provider/model to select any specific model.`,
      });
    }
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
    const visibleAgents = agents.slice(0, MAX_AGENT_CHOICES);

    elements.push({
      tag: "markdown",
      content: "Select an agent:",
    });

    const buttons: InteractiveCardActionItem[] = visibleAgents.map(
      (agentName) => ({
        tag: "button",
        text: plainText(truncateLabel(agentName)),
        value: { action: "select_agent", agentName },
      }),
    );

    elements.push(...buildActionRows(buttons));

    if (agents.length > visibleAgents.length) {
      elements.push({
        tag: "markdown",
        content: `Showing ${visibleAgents.length} of ${agents.length} agents.`,
      });
    }
  }

  return {
    header: {
      title: plainText("Agent Picker"),
      template: "blue",
    },
    elements,
  };
}

export function buildProjectPickerCard(
  entries: ProjectPickerEntry[],
  currentProjectId?: string,
): InteractiveCard {
  const elements: InteractiveCardElement[] = [];

  if (entries.length === 0) {
    elements.push({
      tag: "markdown",
      content: "No projects available.",
    });
  } else {
    const visibleProjects = entries.slice(0, MAX_PROJECT_CHOICES);
    const currentProject =
      currentProjectId &&
      entries.find((entry) => entry.id === currentProjectId);
    const currentLabel = currentProject
      ? (currentProject.name ?? currentProject.worktree)
      : (currentProjectId ?? "none");

    elements.push({
      tag: "markdown",
      content: `Select a project:\nCurrent: ${currentLabel}`,
    });

    const buttons: InteractiveCardActionItem[] = visibleProjects.map(
      (entry, index) => {
        const labelRoot = entry.name?.trim().length
          ? entry.name.trim()
          : getPathLeaf(entry.worktree);
        if (entry.isNew || !entry.id) {
          return {
            tag: "button",
            text: plainText(truncateLabel(`${index + 1}. ✨ ${labelRoot}`)),
            value: {
              action: "discover_project",
              directory: entry.worktree,
            },
          };
        }

        const indexedLabel = `${index + 1}. ${labelRoot}`;
        const label =
          entry.id === currentProjectId
            ? `[Current] ${indexedLabel}`
            : indexedLabel;
        return {
          tag: "button",
          text: plainText(truncateLabel(label)),
          value: {
            action: "select_project",
            projectId: entry.id,
          },
        };
      },
    );

    elements.push(...buildActionRows(buttons));

    if (entries.length > visibleProjects.length) {
      elements.push({
        tag: "markdown",
        content: `Showing ${visibleProjects.length} of ${entries.length} projects. Use /projects <id> to select any specific known project.`,
      });
    }
  }

  return {
    header: {
      title: plainText("Projects"),
      template: "blue",
    },
    elements,
  };
}

export function buildHistoryCard(
  messages: ChatMessage[],
  totalCount?: number,
): InteractiveCard {
  const shownCount = messages.length;
  const title =
    typeof totalCount === "number" && totalCount !== shownCount
      ? `Chat History (${shownCount} of ${totalCount})`
      : "Chat History";

  const content =
    shownCount === 0
      ? "No recent messages found."
      : messages
          .map(
            (message) =>
              `**[${formatHistorySender(message)}]** (${formatHistoryTimestamp(message.createdAt)})\n${buildHistoryPreview(message.content)}`,
          )
          .join("\n\n");

  return {
    header: {
      title: plainText(title),
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

export function buildStatusCard(status: {
  health?: string | null;
  version?: string | null;
  project?: string | null;
  directory?: string | null;
  session: string | null;
  sessionTitle?: string | null;
  model: string | null;
  agent: string | null;
  state: string;
  contextUsed?: number | null;
  contextLimit?: number | null;
}): InteractiveCard {
  const assistantName = getConfig().assistantName;
  const lines: string[] = [];
  if (status.health) {
    lines.push(`**Server**: ${status.health}`);
  }
  if (status.version) {
    lines.push(`**Version**: ${status.version}`);
  }
  if (status.project) {
    lines.push(`**Project**: ${status.project}`);
  }
  if (status.directory) {
    lines.push(`**Scope**: ${status.directory}`);
  }
  lines.push(`**Session**: ${status.session ?? "none"}`);
  if (status.sessionTitle) {
    lines.push(`**Session Title**: ${status.sessionTitle}`);
  }
  lines.push(`**Model**: ${status.model ?? `${assistantName} default`}`);
  lines.push(`**Agent**: ${status.agent ?? `${assistantName} default`}`);
  lines.push(`**State**: ${status.state}`);
  if (status.contextUsed != null) {
    const used = formatTokenCount(status.contextUsed);
    const limitStr = status.contextLimit
      ? formatTokenCount(status.contextLimit)
      : "unknown";
    const pctSuffix = status.contextLimit
      ? ` (${Math.round((status.contextUsed / status.contextLimit) * 100)}%)`
      : "";
    lines.push(`**Context**: ${used}/${limitStr}${pctSuffix}`);
  }

  return {
    header: {
      title: plainText(`${assistantName} Status`),
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
