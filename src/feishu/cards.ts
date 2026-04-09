import type {
  InteractiveCard,
  InteractiveCardActionItem,
  InteractiveCardElement,
  InteractiveCardLarkMdItem,
  InteractiveCardPlainTextItem,
} from "@larksuiteoapi/node-sdk";
import { getConfig } from "../config.js";
import type { PermissionRequest } from "../permission/types.js";
import type { Question } from "../question/types.js";
import type { SummaryTokensInfo, SummaryToolEvent } from "../summary/types.js";
import { optimizeMarkdownStyle } from "./markdown-style.js";
import type { StatusTurnState } from "./status-store.js";

// Exported element IDs for future plugin/client reference
export const STREAMING_ELEMENT_ID = "streaming_content";
export const REASONING_ELEMENT_ID = "reasoning_content";

type CardTemplate = "blue" | "green" | "red" | "orange" | "grey";

export interface CompleteCardOptions {
  reasoningText?: string;
  reasoningDurationMs?: number;
  elapsedMs?: number;
  tokens?: SummaryTokensInfo;
  toolEvents?: SummaryToolEvent[];
  template?: CardTemplate;
}

// Base primitives for cards
export function plainText(content: string): InteractiveCardPlainTextItem {
  return { tag: "plain_text", content };
}

export function larkMd(content: string): InteractiveCardLarkMdItem {
  return { tag: "lark_md", content };
}

// Card Builders
export function buildStatusCard(
  title: string,
  content: string,
  isCompleted: boolean,
  template: "blue" | "green" | "red" | "orange" | "grey" = "blue",
): InteractiveCard {
  const finalTemplate = isCompleted ? "green" : template;

  return {
    header: {
      title: plainText(title),
      template: finalTemplate,
    },
    elements: [
      {
        tag: "markdown",
        content: content || "...",
      },
    ],
  };
}

export function buildThinkingCard(
  title: string,
  content: string,
  template: CardTemplate = "blue",
): InteractiveCard {
  const normalizedContent = content.trim();
  const sections: string[] = [];

  if (normalizedContent) {
    sections.push('<font size="1" color="grey">💭 Thinking...</font>');
    sections.push(optimizeMarkdownStyle(normalizedContent));
  }

  return buildStatusCard(
    title,
    sections.join("\n\n") || "Thinking…",
    false,
    template,
  );
}

export function buildStreamingCard(
  title: string,
  state: StatusTurnState,
  template: CardTemplate = "blue",
): InteractiveCard {
  return buildStatusCard(
    title,
    buildStreamingStatusContent(state),
    false,
    template,
  );
}

export function buildCompleteCard(
  title: string,
  answerContent: string,
  options: CompleteCardOptions = {},
): InteractiveCard {
  const sections: string[] = [];
  const reasoningText = options.reasoningText?.trim();
  const toolSummary = formatToolSummary(options.toolEvents);
  const optimizedAnswer =
    optimizeMarkdownStyle(answerContent.trim()) || "Done.";
  const footer = buildFooterLine(options.elapsedMs, options.tokens);

  if (reasoningText) {
    const reasoningLabel = options.reasoningDurationMs
      ? `💭 Reasoning (${formatElapsed(options.reasoningDurationMs)})`
      : "💭 Reasoning";
    sections.push(
      `<details><summary>${reasoningLabel}</summary>\n\n${reasoningText}\n\n</details>`,
    );
  }

  if (toolSummary) {
    sections.push(toolSummary);
  }

  sections.push(optimizedAnswer);

  if (footer) {
    sections.push(footer);
  }

  return {
    header: {
      title: plainText(title),
      template: options.template ?? "green",
    },
    elements: [
      {
        tag: "markdown",
        content: sections.join("\n\n"),
      },
    ],
  };
}

export function buildStreamingStatusContent(
  state: StatusTurnState,
  resolveImages?: (text: string) => string,
): string {
  const sections: string[] = [];

  let reasoningText = state.accumulatedReasoning?.trim() ?? "";
  if (reasoningText && resolveImages) {
    reasoningText = resolveImages(reasoningText);
  }

  const todoSummary = formatTodoSummary(state);
  const recentUpdatesSummary = formatRecentUpdatesSummary(state);

  let answerContent = state.lastPartialText?.trim() ?? "";
  if (answerContent && resolveImages) {
    answerContent = resolveImages(answerContent);
  }

  const optimizedAnswer = answerContent
    ? optimizeMarkdownStyle(answerContent)
    : "";

  const shouldShowFooter = Boolean(
    reasoningText ||
    todoSummary ||
    recentUpdatesSummary ||
    optimizedAnswer ||
    state.latestTokens,
  );
  const footer = shouldShowFooter
    ? buildFooterLine(Date.now() - state.turnStartTime, state.latestTokens)
    : undefined;

  if (reasoningText) {
    sections.push(
      [
        '<font size="1" color="grey">💭 Thinking...</font>',
        `<font size="1">${reasoningText}</font>`,
      ].join("\n"),
    );
  }

  if (optimizedAnswer) {
    sections.push(optimizedAnswer);
  } else if (!reasoningText && !todoSummary && !recentUpdatesSummary) {
    sections.push("Thinking…");
  }

  if (todoSummary) {
    sections.push(`<font size="1" color="grey">${todoSummary}</font>`);
  }

  if (recentUpdatesSummary) {
    sections.push(`<font size="1" color="grey">${recentUpdatesSummary}</font>`);
  }

  if (footer) {
    sections.push(footer);
  }

  return sections.join("\n\n") || "Thinking…";
}

function formatTodoSummary(state: StatusTurnState): string | undefined {
  if (!state.todos || state.todos.length === 0) {
    return undefined;
  }

  const lines = state.todos
    .map((todo) => {
      const content = normalizeInlineText(todo.content);
      if (!content) {
        return undefined;
      }

      return `- ${getTodoStatusIcon(todo.status)} ${content}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return ["📝 Todo", ...lines].join("\n");
}

function formatRecentUpdatesSummary(
  state: StatusTurnState,
): string | undefined {
  if (!state.recentUpdates || state.recentUpdates.length === 0) {
    return undefined;
  }

  const lines = state.recentUpdates
    .map((update) => normalizeInlineText(update.summary))
    .filter((summary): summary is string => Boolean(summary))
    .map((summary) => `- ${summary}`);

  if (lines.length === 0) {
    return undefined;
  }

  return ["🕒 Recent updates", ...lines].join("\n");
}

function getTodoStatusIcon(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "✅";
    case "in_progress":
    case "running":
      return "🔄";
    case "cancelled":
      return "⏹️";
    case "pending":
    default:
      return "🔲";
  }
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatToolSummary(
  toolEvents?: SummaryToolEvent[],
): string | undefined {
  if (!toolEvents || toolEvents.length === 0) {
    return undefined;
  }

  const recentEvents = toolEvents.slice(-4);
  const lines = recentEvents
    .map((toolEvent) => formatToolEventLine(toolEvent))
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return ["🔧 Progress", ...lines.map((line) => `- ${line}`)].join("\n");
}

function formatToolEventLine(toolEvent: SummaryToolEvent): string | undefined {
  const toolName = toolEvent.tool.trim();
  if (!toolName) {
    return undefined;
  }

  const title = toolEvent.title?.trim();
  const label = title && title.length > 0 ? title : toolName;
  const status = formatToolStatus(toolEvent.status);
  return `${getToolIcon(toolName)} ${label}${status ? ` · ${status}` : ""}`;
}

function formatToolStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "pending":
      return "in progress";
    case "completed":
      return "done";
    case "error":
    case "failed":
      return "failed";
    default:
      return status.trim().toLowerCase();
  }
}

function getToolIcon(tool: string): string {
  switch (tool.trim().toLowerCase()) {
    case "task":
    case "subtask":
      return "🤖";
    case "skill":
      return "🧠";
    case "bash":
      return "⚙️";
    case "read":
      return "📄";
    case "write":
      return "📝";
    case "edit":
    case "apply_patch":
      return "✏️";
    case "webfetch":
    case "websearch_web_search_exa":
      return "🌐";
    default:
      return "🔧";
  }
}

function buildFooterLine(
  elapsedMs?: number,
  tokens?: SummaryTokensInfo,
): string | undefined {
  const parts: string[] = [];

  if (
    typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0
  ) {
    parts.push(`⏱️ ${formatElapsed(elapsedMs)}`);
  }

  if (tokens) {
    const totalTokens =
      tokens.input +
      tokens.output +
      tokens.reasoning +
      tokens.cacheRead +
      tokens.cacheWrite;

    if (totalTokens > 0) {
      parts.push(`🧮 ${compactNumber(totalTokens)} tok`);
    }

    if (tokens.reasoning > 0) {
      parts.push(`💭 ${compactNumber(tokens.reasoning)}`);
    }

    if (tokens.cacheRead > 0 || tokens.cacheWrite > 0) {
      parts.push(
        `🗂️ ${compactNumber(tokens.cacheRead)}/${compactNumber(tokens.cacheWrite)}`,
      );
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `<font size="1" color="grey">${parts.join(" · ")}</font>`;
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return Math.abs(millions) >= 100
      ? `${Math.round(millions)}m`
      : `${millions.toFixed(1)}m`;
  }

  if (abs >= 1_000) {
    const thousands = value / 1_000;
    return Math.abs(thousands) >= 100
      ? `${Math.round(thousands)}k`
      : `${thousands.toFixed(1)}k`;
  }

  return `${Math.round(value)}`;
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function buildQuestionCard(
  questionState: Question,
  messageId: string,
): InteractiveCard {
  const elements: InteractiveCardElement[] = [
    {
      tag: "markdown",
      content: questionState.header
        ? `**${questionState.header}**\n${questionState.question}`
        : questionState.question,
    },
  ];

  // For interactive selection, feishu supports button actions or select menus
  // Given multiple select options vs single select:

  if (questionState.options && questionState.options.length > 0) {
    if (questionState.multiple) {
      // For multiple, a select menu is usually better, but for simplicity of actions we can use buttons with state
      // Actually feishu select menu has multi-select support, but node sdk might not fully model it
      // For now we render options as buttons (or maybe a select menu)
      const optionButtons: InteractiveCardActionItem[] =
        questionState.options.map((opt, i) => ({
          tag: "button",
          text: plainText(opt.label),
          value: { action: "question_answer", messageId, optionIndex: i },
        }));

      elements.push({
        tag: "action",
        actions: optionButtons,
      });

      elements.push({
        tag: "markdown",
        content:
          "*This is a multiple-choice question. Please select all that apply.*",
      });
    } else {
      const optionButtons: InteractiveCardActionItem[] =
        questionState.options.map((opt, i) => ({
          tag: "button",
          text: plainText(opt.label),
          value: { action: "question_answer", messageId, optionIndex: i },
        }));

      elements.push({
        tag: "action",
        actions: optionButtons,
      });
    }
  }

  return {
    header: {
      title: plainText("Input Required"),
      template: "orange",
    },
    elements,
  };
}

export function buildPermissionCard(
  request: PermissionRequest,
): InteractiveCard {
  let content = `**Permission Requested: ${request.permission}**`;
  if (request.patterns && request.patterns.length > 0) {
    content += `\nTarget:\n${request.patterns.map((p) => `- ${p}`).join("\n")}`;
  }

  const actions: InteractiveCardActionItem[] = [
    {
      tag: "button",
      text: plainText("Approve"),
      type: "primary",
      value: {
        action: "permission_reply",
        reply: "approve",
        requestId: request.id,
      },
    },
    {
      tag: "button",
      text: plainText("Always Approve"),
      value: {
        action: "permission_reply",
        reply: "always",
        requestId: request.id,
      },
    },
    {
      tag: "button",
      text: plainText("Deny"),
      type: "danger",
      value: {
        action: "permission_reply",
        reply: "deny",
        requestId: request.id,
      },
    },
  ];

  return {
    header: {
      title: plainText("Permission Request"),
      template: "red",
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
      {
        tag: "action",
        actions,
      },
    ],
  };
}

export interface ConfirmCardData {
  operationDescription: string;
  pendingOperationId: string;
  preview?: string;
}

export function buildConfirmCard(data: ConfirmCardData): InteractiveCard {
  const elements: InteractiveCardElement[] = [
    {
      tag: "markdown",
      content: data.operationDescription,
    },
  ];

  if (data.preview) {
    elements.push({
      tag: "markdown",
      content: `**Preview:**\n${data.preview}`,
    });
  }

  const actions: InteractiveCardActionItem[] = [
    {
      tag: "button",
      text: plainText("✅ Confirm"),
      type: "primary",
      value: {
        action: "confirm_write",
        operationId: data.pendingOperationId,
      },
    },
    {
      tag: "button",
      text: plainText("❌ Cancel"),
      type: "danger",
      value: {
        action: "reject_write",
        operationId: data.pendingOperationId,
      },
    },
  ];

  elements.push({
    tag: "action",
    actions,
  });

  return {
    header: {
      title: plainText("⚠️ Confirmation Required"),
      template: "orange",
    },
    elements,
  };
}

export function buildControlCard(
  status: string,
  options: { showCancel?: boolean } = {},
): InteractiveCard {
  const elements: InteractiveCardElement[] = [
    {
      tag: "markdown",
      content: `**Current Status**: ${status}`,
    },
  ];

  if (options.showCancel) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: plainText("Cancel Task"),
          type: "danger",
          value: { action: "control_cancel" },
        },
      ],
    });
  }

  return {
    header: {
      title: plainText(`${getConfig().assistantName} Control`),
      template: "blue",
    },
    elements,
  };
}
