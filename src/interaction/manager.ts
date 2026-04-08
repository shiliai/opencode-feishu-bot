import type {
  BlockReason,
  BusyState,
  ExpectedInput,
  GuardDecision,
  IncomingInputType,
  InteractionClearReason,
  InteractionInput,
  InteractionKind,
  InteractionState,
  ResolveInteractionGuardOptions,
  StartInteractionOptions,
  TransitionInteractionOptions,
} from "./types.js";
import { logger } from "../utils/logger.js";

export const DEFAULT_ALLOWED_INTERACTION_COMMANDS = [
  "/help",
  "/status",
  "/abort",
] as const;
export const BUSY_ALLOWED_COMMANDS = ["/abort", "/status", "/help"] as const;

export function normalizeCommand(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutMention = withSlash.split("@")[0];
  if (!withoutMention || withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function normalizeIncomingCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  return normalizeCommand(trimmed);
}

function normalizeAllowedCommands(commands?: readonly string[]): string[] {
  if (commands === undefined) {
    return [...DEFAULT_ALLOWED_INTERACTION_COMMANDS];
  }

  const normalized = new Set<string>();
  for (const command of commands) {
    const value = normalizeCommand(command);
    if (value) {
      normalized.add(value);
    }
  }

  return Array.from(normalized);
}

function cloneState(state: InteractionState): InteractionState {
  return {
    ...state,
    allowedCommands: [...state.allowedCommands],
    metadata: { ...state.metadata },
  };
}

function cloneBusyState(state: BusyState | null): BusyState | null {
  if (!state) {
    return null;
  }

  return {
    createdAt: state.createdAt,
    metadata: { ...state.metadata },
  };
}

function classifyIncomingInput(input: InteractionInput): {
  inputType: IncomingInputType;
  command?: string;
} {
  if (input.type && input.type !== "command") {
    return { inputType: input.type };
  }

  if (typeof input.callbackData === "string" && input.callbackData.length > 0) {
    return { inputType: "callback" };
  }

  if (typeof input.text === "string") {
    const command = normalizeIncomingCommand(input.text);
    if (command) {
      return { inputType: "command", command };
    }

    return { inputType: "text" };
  }

  if (input.type === "command") {
    return { inputType: "command" };
  }

  return { inputType: "other" };
}

function getExpectedInputBlockReason(
  expectedInput: ExpectedInput,
): BlockReason {
  switch (expectedInput) {
    case "callback":
      return "expected_callback";
    case "command":
      return "expected_command";
    case "text":
    case "mixed":
      return "expected_text";
  }
}

function createAllowDecision(
  inputType: IncomingInputType,
  state: InteractionState | null,
  command?: string,
  busy?: boolean,
): GuardDecision {
  return {
    allow: true,
    inputType,
    state,
    command,
    busy,
  };
}

function createBlockDecision(
  inputType: IncomingInputType,
  state: InteractionState,
  reason: BlockReason,
  command?: string,
  busy?: boolean,
): GuardDecision {
  return {
    allow: false,
    inputType,
    state,
    reason,
    command,
    busy,
  };
}

function allowsBusyInteraction(kind: InteractionKind | undefined): boolean {
  return kind === "question" || kind === "permission";
}

function isBusyAllowedCommand(
  command: string | undefined,
  busyAllowedCommands: Set<string>,
): boolean {
  return Boolean(command && busyAllowedCommands.has(command));
}

export class InteractionManager {
  private state: InteractionState | null = null;
  private busyState: BusyState | null = null;

  start(options: StartInteractionOptions): InteractionState {
    const now = Date.now();
    let expiresAt: number | null = null;

    if (this.state) {
      this.clear("state_replaced");
    }

    if (typeof options.expiresInMs === "number") {
      expiresAt = now + options.expiresInMs;
    }

    const nextState: InteractionState = {
      kind: options.kind,
      expectedInput: options.expectedInput,
      allowedCommands: normalizeAllowedCommands(options.allowedCommands),
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt,
    };

    this.state = nextState;
    logger.info(
      `[InteractionManager] Started interaction: kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return cloneState(nextState);
  }

  get(): InteractionState | null {
    return this.state ? cloneState(this.state) : null;
  }

  getSnapshot(): InteractionState | null {
    return this.get();
  }

  isActive(): boolean {
    return this.state !== null;
  }

  isExpired(referenceTimeMs: number = Date.now()): boolean {
    if (!this.state || this.state.expiresAt === null) {
      return false;
    }

    return referenceTimeMs >= this.state.expiresAt;
  }

  transition(options: TransitionInteractionOptions): InteractionState | null {
    if (!this.state) {
      return null;
    }

    const now = Date.now();
    this.state = {
      ...this.state,
      kind: options.kind ?? this.state.kind,
      expectedInput: options.expectedInput ?? this.state.expectedInput,
      allowedCommands:
        options.allowedCommands !== undefined
          ? normalizeAllowedCommands(options.allowedCommands)
          : [...this.state.allowedCommands],
      metadata: options.metadata
        ? { ...options.metadata }
        : { ...this.state.metadata },
      expiresAt:
        options.expiresInMs === undefined
          ? this.state.expiresAt
          : options.expiresInMs === null
            ? null
            : now + options.expiresInMs,
    };

    logger.debug(
      `[InteractionManager] Transitioned interaction: kind=${this.state.kind}, expectedInput=${this.state.expectedInput}, allowedCommands=${this.state.allowedCommands.join(",") || "none"}`,
    );

    return cloneState(this.state);
  }

  clear(reason: InteractionClearReason = "manual"): void {
    if (!this.state) {
      return;
    }

    logger.info(
      `[InteractionManager] Cleared interaction: reason=${reason}, kind=${this.state.kind}, expectedInput=${this.state.expectedInput}`,
    );
    this.state = null;
  }

  startBusy(metadata: Record<string, unknown> = {}): BusyState {
    this.busyState = {
      createdAt: Date.now(),
      metadata: { ...metadata },
    };
    logger.info("[InteractionManager] Busy state started");
    return cloneBusyState(this.busyState) as BusyState;
  }

  clearBusy(): void {
    if (!this.busyState) {
      return;
    }

    this.busyState = null;
    logger.info("[InteractionManager] Busy state cleared");
  }

  isBusy(): boolean {
    return this.busyState !== null;
  }

  getBusyState(): BusyState | null {
    return cloneBusyState(this.busyState);
  }

  resolveGuardDecision(
    input: InteractionInput,
    options: ResolveInteractionGuardOptions = {},
  ): GuardDecision {
    const state = this.getSnapshot();
    const { inputType, command } = classifyIncomingInput(input);
    const isBusy = options.busy ?? this.isBusy();
    const busyAllowedCommands = new Set(
      normalizeAllowedCommands(
        options.busyAllowedCommands ?? BUSY_ALLOWED_COMMANDS,
      ),
    );
    const allowBusyKinds = new Set(
      options.allowBusyKinds ?? ["question", "permission"],
    );

    if (state && this.isExpired()) {
      this.clear("expired");
      return createBlockDecision(inputType, state, "expired", command, isBusy);
    }

    if (isBusy) {
      if (inputType === "command") {
        if (isBusyAllowedCommand(command, busyAllowedCommands)) {
          return createAllowDecision(inputType, state, command, true);
        }

        if (state) {
          return createBlockDecision(
            inputType,
            state,
            "command_not_allowed",
            command,
            true,
          );
        }

        return {
          allow: false,
          inputType,
          state,
          reason: "command_not_allowed",
          command,
          busy: true,
        };
      }

      if (
        state &&
        allowBusyKinds.has(state.kind) &&
        allowsBusyInteraction(state.kind)
      ) {
        if (state.expectedInput === "mixed") {
          if (inputType === "callback" || inputType === "text") {
            return createAllowDecision(inputType, state, command, true);
          }

          return createBlockDecision(
            inputType,
            state,
            "expected_text",
            command,
            true,
          );
        }

        if (state.expectedInput === inputType) {
          return createAllowDecision(inputType, state, command, true);
        }

        return createBlockDecision(
          inputType,
          state,
          getExpectedInputBlockReason(state.expectedInput),
          command,
          true,
        );
      }

      if (state) {
        return createBlockDecision(
          inputType,
          state,
          "expected_text",
          command,
          true,
        );
      }

      return {
        allow: false,
        inputType,
        state,
        reason: "expected_text",
        command,
        busy: true,
      };
    }

    if (!state) {
      return createAllowDecision(inputType, null, command);
    }

    if (inputType === "command") {
      if (command === "/start") {
        return createAllowDecision(inputType, state, command);
      }

      if (command && state.allowedCommands.includes(command)) {
        return createAllowDecision(inputType, state, command);
      }

      return createBlockDecision(
        inputType,
        state,
        "command_not_allowed",
        command,
      );
    }

    if (state.expectedInput === "mixed") {
      if (inputType === "callback" || inputType === "text") {
        return createAllowDecision(inputType, state, command);
      }

      return createBlockDecision(inputType, state, "expected_text", command);
    }

    if (state.expectedInput === inputType) {
      return createAllowDecision(inputType, state, command);
    }

    return createBlockDecision(
      inputType,
      state,
      getExpectedInputBlockReason(state.expectedInput),
      command,
    );
  }
}

export const interactionManager = new InteractionManager();
