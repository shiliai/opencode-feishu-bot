import type {
  InteractiveCard,
  InteractiveCardActionItem,
  InteractiveCardElement,
  InteractiveCardLarkMdItem,
  InteractiveCardPlainTextItem,
} from "@larksuiteoapi/node-sdk";
import type { PermissionRequest } from "../permission/types.js";
import type { Question } from "../question/types.js";
import type { SummaryTokensInfo, SummaryToolEvent } from "../summary/types.js";
import { optimizeMarkdownStyle } from "./markdown-style.js";
import type { StatusTurnState } from "./status-store.js";

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

export function buildStreamingStatusContent(state: StatusTurnState): string {
  const sections: string[] = [];
  const reasoningText = state.accumulatedReasoning?.trim();
  const toolSummary = formatToolSummary(state.toolEvents);
  const optimizedAnswer = state.lastPartialText?.trim()
    ? optimizeMarkdownStyle(state.lastPartialText.trim())
    : "";
  const shouldShowFooter = Boolean(
    reasoningText || toolSummary || state.latestTokens,
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

  if (toolSummary) {
    sections.push(`<font size="1" color="grey">${toolSummary}</font>`);
  }

  if (optimizedAnswer) {
    sections.push(optimizedAnswer);
  } else if (!reasoningText) {
    sections.push("Thinking…");
  }

  if (footer) {
    sections.push(footer);
  }

  return sections.join("\n\n") || "Thinking…";
}

function formatToolSummary(
  toolEvents?: SummaryToolEvent[],
): string | undefined {
  if (!toolEvents || toolEvents.length === 0) {
    return undefined;
  }

  const toolNames = Array.from(
    new Set(
      toolEvents
        .map((toolEvent) => toolEvent.tool.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  );

  if (toolNames.length === 0) {
    return undefined;
  }

  return `🔧 Using: ${toolNames.join(", ")}`;
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
    parts.push(
      `↑ ${compactNumber(tokens.input)} ↓ ${compactNumber(tokens.output)}`,
    );

    if (tokens.reasoning > 0) {
      parts.push(`💭 ${compactNumber(tokens.reasoning)}`);
    }

    if (tokens.cacheRead > 0 || tokens.cacheWrite > 0) {
      parts.push(
        `cache ${compactNumber(tokens.cacheRead)}/${compactNumber(tokens.cacheWrite)}`,
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
      title: plainText("OpenCode Control"),
      template: "blue",
    },
    elements,
  };
}
