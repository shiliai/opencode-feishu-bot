export type SelectionCardTemplate =
  | "blue"
  | "green"
  | "purple"
  | "red"
  | "orange"
  | "grey";

export interface SelectionCardConfig {
  command: string;
  title: string;
  template: SelectionCardTemplate;
  items: SelectionItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  instruction?: string;
  emptyMessage?: string;
  context?: Record<string, unknown>;
  cancelButtonEnabled?: boolean;
}

export interface SelectionItem {
  label: string;
  value: string;
  description?: string;
  badge?: string;
  icon?: string;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  totalItems: number;
}

export type SelectionAction =
  | {
      action: "selection_pick";
      command: string;
      value: string;
      context?: Record<string, unknown>;
    }
  | { action: "selection_cancel" }
  | {
      action: "selection_page";
      command: string;
      page: number;
      context?: Record<string, unknown>;
    }
  | {
      action: "selection_back";
      command: string;
      context?: Record<string, unknown>;
    };

function getOptionalContext(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value == null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function parseSelectionAction(
  rawValue: Record<string, unknown>,
): SelectionAction | null {
  const action = typeof rawValue.action === "string" ? rawValue.action : null;

  if (!action?.startsWith("selection_")) {
    return null;
  }

  switch (action) {
    case "selection_pick": {
      if (
        typeof rawValue.command === "string" &&
        typeof rawValue.value === "string"
      ) {
        return {
          action: "selection_pick",
          command: rawValue.command,
          value: rawValue.value,
          context: getOptionalContext(rawValue.context),
        };
      }

      return null;
    }
    case "selection_cancel":
      return { action: "selection_cancel" };
    case "selection_page": {
      if (
        typeof rawValue.command === "string" &&
        typeof rawValue.page === "number"
      ) {
        return {
          action: "selection_page",
          command: rawValue.command,
          page: rawValue.page,
          context: getOptionalContext(rawValue.context),
        };
      }

      return null;
    }
    case "selection_back": {
      if (typeof rawValue.command === "string") {
        return {
          action: "selection_back",
          command: rawValue.command,
          context: getOptionalContext(rawValue.context),
        };
      }

      return null;
    }
    default:
      return null;
  }
}

export function getPageInfo(state: PaginationState): {
  hasNext: boolean;
  hasPrev: boolean;
  totalPages: number;
  currentPage: number;
} {
  const totalPages = Math.max(1, Math.ceil(state.totalItems / state.pageSize));
  const currentPage = state.page + 1;

  return {
    hasNext: state.page < totalPages - 1,
    hasPrev: state.page > 0,
    totalPages,
    currentPage,
  };
}
