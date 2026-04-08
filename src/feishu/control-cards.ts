import type { InteractiveCard } from "@larksuiteoapi/node-sdk";
import { getConfig } from "../config.js";
import { plainText } from "./cards.js";
import type { ChatMessage } from "./message-reader.js";
import {
  buildButtonGridCard,
  buildSelectionCard,
  buildTwoLevelCard,
} from "./selection-card/index.js";

export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string;
  messageCount?: number;
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
  { command: "/task", description: "Create a scheduled task" },
  { command: "/tasklist", description: "List and manage scheduled tasks" },
  { command: "/update", description: "Check for updates and restart" },
  { command: "/status", description: "Show current status" },
  { command: "/version", description: "Show bridge version" },
  { command: "/abort", description: "Abort the current session" },
];

const HISTORY_PREVIEW_LIMIT = 200;
const MAX_FLAT_MODEL_CHOICES = 20;
const MAX_AGENT_CHOICES = 20;
const SESSION_PAGE_SIZE = 10;
const MODEL_PAGE_SIZE = 10;
const PROJECT_PAGE_SIZE = 20;

const MODEL_PROVIDER_ICONS: Record<string, string> = {
  anthropic: "🟠",
  deepseek: "🐋",
  gemini: "✨",
  google: "🔵",
  groq: "⚙️",
  mistral: "🌪️",
  ollama: "🦙",
  openai: "🟢",
  openrouter: "🧭",
  relay: "🔁",
  xai: "⚡",
};

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
  page = 0,
): InteractiveCard {
  return buildSelectionCard({
    command: "session",
    title: "Sessions",
    template: "blue",
    items: sessions.map((session) => ({
      label: session.title?.trim() || session.id,
      value: session.id,
      description: session.id,
      badge: undefined,
    })),
    page,
    pageSize: SESSION_PAGE_SIZE,
    totalItems: sessions.length,
    instruction: "Select a session:",
    emptyMessage: "No recent sessions found.",
  });
}

function getModelProviderIcon(providerName: string): string {
  const normalized = providerName.trim().toLowerCase();
  return MODEL_PROVIDER_ICONS[normalized] ?? "🤖";
}

export function buildModelProviderCard(
  providers: Array<{ name: string; modelCount: number }>,
  page = 0,
): InteractiveCard {
  return buildTwoLevelCard({
    title: "Model Picker",
    template: "purple",
    instruction: "Select a model provider:",
    emptyMessage: "No models available.",
    items: providers.map((provider) => ({
      label: provider.name,
      value: provider.name,
      icon: getModelProviderIcon(provider.name),
      count: provider.modelCount,
    })),
    command: "model",
    context: { level: "provider" },
    page,
    pageSize: MODEL_PAGE_SIZE,
  });
}

export function buildModelListCard(
  providerName: string,
  models: string[],
  page = 0,
): InteractiveCard {
  return buildTwoLevelCard({
    title: "Model Picker",
    template: "purple",
    instruction: `Select a model from **${providerName}**:`,
    emptyMessage: `No models available for **${providerName}**.`,
    items: models.map((modelName) => ({
      label: modelName,
      value: modelName,
    })),
    command: "model",
    context: { level: "model", provider: providerName },
    page,
    pageSize: MODEL_PAGE_SIZE,
    backEnabled: true,
  });
}

export function buildModelPickerCard(
  models: string[],
  page = 0,
): InteractiveCard {
  return buildSelectionCard({
    command: "model",
    title: "Model Picker",
    template: "purple",
    items: models.map((modelName) => ({
      label: modelName,
      value: modelName,
    })),
    page,
    pageSize: MAX_FLAT_MODEL_CHOICES,
    totalItems: models.length,
    instruction: "Select a model:",
    emptyMessage: "No models available.",
    context: { level: "flat" },
  });
}

export function buildAgentPickerCard(agents: string[]): InteractiveCard {
  const visibleAgents = agents.slice(0, MAX_AGENT_CHOICES);
  const instruction =
    visibleAgents.length === 0
      ? "No agents available."
      : agents.length > visibleAgents.length
        ? `Select an agent:\nShowing ${visibleAgents.length} of ${agents.length} agents.`
        : "Select an agent:";

  return buildButtonGridCard({
    title: "Agent Picker",
    template: "blue",
    instruction,
    buttons: visibleAgents.map((agentName) => ({
      label: agentName,
      value: {
        action: "selection_pick",
        command: "agent",
        value: agentName,
      },
    })),
  });
}

export function buildProjectPickerCard(
  entries: ProjectPickerEntry[],
  currentProjectId?: string,
  page = 0,
): InteractiveCard {
  const currentProject =
    currentProjectId && entries.find((entry) => entry.id === currentProjectId);
  const currentLabel = currentProject
    ? (currentProject.name ?? currentProject.worktree)
    : (currentProjectId ?? "none");

  return buildSelectionCard({
    command: "project",
    title: "Projects",
    template: "green",
    items: entries.map((entry) => ({
      label: entry.name?.trim() || getPathLeaf(entry.worktree),
      value: entry.id || entry.worktree,
      description: entry.worktree,
      badge:
        entry.id && currentProjectId && entry.id === currentProjectId
          ? "[Current]"
          : entry.isNew
            ? "✨ New"
            : undefined,
    })),
    page,
    pageSize: PROJECT_PAGE_SIZE,
    totalItems: entries.length,
    instruction: `Select a project:\nCurrent: ${currentLabel}`,
    emptyMessage: "No projects available.",
  });
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
