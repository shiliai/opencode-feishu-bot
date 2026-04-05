import { 
  InteractiveCard, 
  InteractiveCardElement,
  InteractiveCardPlainTextItem,
  InteractiveCardLarkMdItem,
  InteractiveCardActionItem
} from "@larksuiteoapi/node-sdk";
import type { Question } from "../question/types.js";
import type { PermissionRequest } from "../permission/types.js";

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
  template: "blue" | "green" | "red" | "orange" | "grey" = "blue"
): InteractiveCard {
  const finalTemplate = isCompleted ? "green" : template;
  
  return {
    header: {
      title: plainText(title),
      template: finalTemplate
    },
    elements: [
      {
        tag: "markdown",
        content: content || "..."
      }
    ]
  };
}

export function buildQuestionCard(questionState: Question, messageId: string): InteractiveCard {
  const elements: InteractiveCardElement[] = [
    {
      tag: "markdown",
      content: questionState.header ? `**${questionState.header}**\n${questionState.question}` : questionState.question
    }
  ];

  // For interactive selection, feishu supports button actions or select menus
  // Given multiple select options vs single select:
  
  if (questionState.options && questionState.options.length > 0) {
    if (questionState.multiple) {
      // For multiple, a select menu is usually better, but for simplicity of actions we can use buttons with state
      // Actually feishu select menu has multi-select support, but node sdk might not fully model it
      // For now we render options as buttons (or maybe a select menu)
      const optionButtons: InteractiveCardActionItem[] = questionState.options.map((opt, i) => ({
        tag: "button",
        text: plainText(opt.label),
        value: { action: "question_answer", messageId, optionIndex: i }
      }));
      
      elements.push({
        tag: "action",
        actions: optionButtons
      });
      
      elements.push({
        tag: "markdown",
        content: "*This is a multiple-choice question. Please select all that apply.*"
      });
    } else {
      const optionButtons: InteractiveCardActionItem[] = questionState.options.map((opt, i) => ({
        tag: "button",
        text: plainText(opt.label),
        value: { action: "question_answer", messageId, optionIndex: i }
      }));
      
      elements.push({
        tag: "action",
        actions: optionButtons
      });
    }
  }

  return {
    header: {
      title: plainText("Input Required"),
      template: "orange"
    },
    elements
  };
}

export function buildPermissionCard(request: PermissionRequest): InteractiveCard {
  let content = `**Permission Requested: ${request.permission}**`;
  if (request.patterns && request.patterns.length > 0) {
    content += `\nTarget:\n` + request.patterns.map(p => `- ${p}`).join("\n");
  }

  const actions: InteractiveCardActionItem[] = [
    {
      tag: "button",
      text: plainText("Approve"),
      type: "primary",
      value: { action: "permission_reply", reply: "approve", requestId: request.id }
    },
    {
      tag: "button",
      text: plainText("Always Approve"),
      value: { action: "permission_reply", reply: "always", requestId: request.id }
    },
    {
      tag: "button",
      text: plainText("Deny"),
      type: "danger",
      value: { action: "permission_reply", reply: "deny", requestId: request.id }
    }
  ];

  return {
    header: {
      title: plainText("Permission Request"),
      template: "red"
    },
    elements: [
      {
        tag: "markdown",
        content
      },
      {
        tag: "action",
        actions
      }
    ]
  };
}

export function buildControlCard(status: string, options: { showCancel?: boolean } = {}): InteractiveCard {
  const elements: InteractiveCardElement[] = [
    {
      tag: "markdown",
      content: `**Current Status**: ${status}`
    }
  ];

  if (options.showCancel) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: plainText("Cancel Task"),
          type: "danger",
          value: { action: "control_cancel" }
        }
      ]
    });
  }

  return {
    header: {
      title: plainText("OpenCode Control"),
      template: "blue"
    },
    elements
  };
}
