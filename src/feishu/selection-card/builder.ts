import type {
  InteractiveCard,
  InteractiveCardActionItem,
  InteractiveCardElement,
} from "@larksuiteoapi/node-sdk";
import { plainText } from "../cards.js";
import type {
  PaginationState,
  SelectionCardConfig,
  SelectionCardTemplate,
} from "./types.js";
import { getPageInfo } from "./types.js";

const MAX_BUTTON_LABEL_LENGTH = 58;
const MAX_ACTIONS_PER_ROW = 5;

export function truncateLabel(
  label: string,
  limit = MAX_BUTTON_LABEL_LENGTH,
): string {
  if (label.length <= limit) {
    return label;
  }

  if (limit <= 1) {
    return label.slice(0, limit);
  }

  return `${label.slice(0, limit - 1)}…`;
}

export function buildActionRows(
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

export function buildSelectionCard(
  config: SelectionCardConfig,
): InteractiveCard {
  const {
    command,
    title,
    template,
    items,
    page,
    pageSize,
    totalItems,
    instruction,
    emptyMessage,
    context,
    cancelButtonEnabled = true,
  } = config;
  const pagination: PaginationState = { page, pageSize, totalItems };
  const pageInfo = getPageInfo(pagination);
  const startIndex = page * pageSize;
  const visibleItems = items.slice(startIndex, startIndex + pageSize);

  const elements: InteractiveCardElement[] = [];

  if (visibleItems.length === 0) {
    elements.push({
      tag: "markdown",
      content: emptyMessage ?? "No items found.",
    });
  } else {
    if (instruction) {
      elements.push({ tag: "markdown", content: instruction });
    }

    const itemLines: string[] = [];
    const buttons: InteractiveCardActionItem[] = [];

    visibleItems.forEach((item, itemIndex) => {
      const number = startIndex + itemIndex + 1;
      const icon = item.icon ? `${item.icon} ` : "";
      const badge = item.badge ? ` ${item.badge}` : "";
      const description = item.description ? `\n   ${item.description}` : "";

      itemLines.push(
        `${number}. ${icon}**${item.label}**${badge}${description}`,
      );

      buttons.push({
        tag: "button",
        text: plainText(truncateLabel(`${number}. ${item.label}`)),
        value: {
          action: "selection_pick",
          command,
          value: item.value,
          context,
        },
      });
    });

    elements.push({ tag: "markdown", content: itemLines.join("\n\n") });
    elements.push(...buildActionRows(buttons));
  }

  const footerActions: InteractiveCardActionItem[] = [];

  if (pageInfo.hasPrev) {
    footerActions.push({
      tag: "button",
      text: plainText("◀ Previous"),
      value: { action: "selection_page", command, page: page - 1, context },
    });
  }

  if (totalItems > pageSize) {
    footerActions.push({
      tag: "button",
      text: plainText(`${pageInfo.currentPage}/${pageInfo.totalPages}`),
      type: "primary",
      value: { action: "selection_page", command, page, context },
    });
  }

  if (pageInfo.hasNext) {
    footerActions.push({
      tag: "button",
      text: plainText("Next ▶"),
      value: { action: "selection_page", command, page: page + 1, context },
    });
  }

  if (cancelButtonEnabled) {
    footerActions.push({
      tag: "button",
      text: plainText("Cancel"),
      value: { action: "selection_cancel" },
    });
  }

  if (footerActions.length > 0) {
    elements.push({ tag: "hr" });
    elements.push(...buildActionRows(footerActions));
  }

  return {
    header: {
      title: plainText(title),
      template,
    },
    elements,
  };
}

export function buildButtonGridCard(options: {
  title: string;
  template: SelectionCardTemplate;
  instruction?: string;
  buttons: Array<{
    label: string;
    value: Record<string, unknown>;
    type?: "primary" | "danger";
  }>;
  cancelButtonEnabled?: boolean;
}): InteractiveCard {
  const elements: InteractiveCardElement[] = [];

  if (options.instruction) {
    elements.push({ tag: "markdown", content: options.instruction });
  }

  const actions: InteractiveCardActionItem[] = options.buttons.map(
    (button) => ({
      tag: "button",
      text: plainText(truncateLabel(button.label)),
      ...(button.type ? { type: button.type } : {}),
      value: button.value,
    }),
  );

  elements.push(...buildActionRows(actions));

  if (options.cancelButtonEnabled !== false) {
    elements.push({ tag: "hr" });
    elements.push(
      ...buildActionRows([
        {
          tag: "button",
          text: plainText("Cancel"),
          value: { action: "selection_cancel" },
        },
      ]),
    );
  }

  return {
    header: {
      title: plainText(options.title),
      template: options.template,
    },
    elements,
  };
}

export function buildTwoLevelCard(options: {
  title: string;
  template: SelectionCardTemplate;
  instruction?: string;
  emptyMessage?: string;
  items: Array<{ label: string; value: string; icon?: string; count?: number }>;
  command: string;
  context?: Record<string, unknown>;
  page?: number;
  pageSize?: number;
  cancelButtonEnabled?: boolean;
  backEnabled?: boolean;
}): InteractiveCard {
  const {
    command,
    context,
    cancelButtonEnabled = true,
    backEnabled = false,
  } = options;
  const page = options.page ?? 0;
  const pageSize = options.pageSize ?? 10;
  const totalItems = options.items.length;
  const startIndex = page * pageSize;
  const visibleItems = options.items.slice(startIndex, startIndex + pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const elements: InteractiveCardElement[] = [];

  if (visibleItems.length === 0) {
    elements.push({
      tag: "markdown",
      content: options.emptyMessage ?? "No items found.",
    });
  } else {
    if (options.instruction) {
      elements.push({ tag: "markdown", content: options.instruction });
    }

    const buttons: InteractiveCardActionItem[] = visibleItems.map((item) => {
      const icon = item.icon ? `${item.icon} ` : "";
      const count = item.count != null ? ` (${item.count})` : "";

      return {
        tag: "button",
        text: plainText(truncateLabel(`${icon}${item.label}${count}`)),
        value: {
          action: "selection_pick",
          command,
          value: item.value,
          context,
        },
      };
    });

    elements.push(...buildActionRows(buttons));
  }

  const footerActions: InteractiveCardActionItem[] = [];

  if (page > 0) {
    footerActions.push({
      tag: "button",
      text: plainText("◀ Previous"),
      value: { action: "selection_page", command, page: page - 1, context },
    });
  }

  if (totalItems > pageSize) {
    footerActions.push({
      tag: "button",
      text: plainText(`${page + 1}/${totalPages}`),
      value: { action: "selection_page", command, page, context },
    });
  }

  if (page < totalPages - 1) {
    footerActions.push({
      tag: "button",
      text: plainText("Next ▶"),
      value: { action: "selection_page", command, page: page + 1, context },
    });
  }

  if (backEnabled) {
    footerActions.push({
      tag: "button",
      text: plainText("◀ Back"),
      value: { action: "selection_back", command, context },
    });
  }

  if (cancelButtonEnabled) {
    footerActions.push({
      tag: "button",
      text: plainText("Cancel"),
      value: { action: "selection_cancel" },
    });
  }

  if (footerActions.length > 0) {
    elements.push({ tag: "hr" });
    elements.push(...buildActionRows(footerActions));
  }

  return {
    header: {
      title: plainText(options.title),
      template: options.template,
    },
    elements,
  };
}
