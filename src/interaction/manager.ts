import { logger } from "../utils/logger.js";
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
  private readonly states = new Map<string, InteractionState>();
  private readonly busyStates = new Map<string, BusyState>();

  start(chatId: string, options: StartInteractionOptions): InteractionState {
    const now = Date.now();
    let expiresAt: number | null = null;

    if (this.states.has(chatId)) {
      this.clear(chatId, "state_replaced");
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

    this.states.set(chatId, nextState);
    logger.info(
      `[InteractionManager] Started interaction: chatId=${chatId}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return cloneState(nextState);
  }

  get(chatId: string): InteractionState | null {
    const state = this.states.get(chatId);
    return state ? cloneState(state) : null;
  }

  getSnapshot(chatId: string): InteractionState | null {
    return this.get(chatId);
  }

  isActive(chatId: string): boolean {
    return this.states.has(chatId);
  }

  isExpired(chatId: string, referenceTimeMs: number = Date.now()): boolean {
    const state = this.states.get(chatId);
    if (!state || state.expiresAt === null) {
      return false;
    }

    return referenceTimeMs >= state.expiresAt;
  }

  transition(
    chatId: string,
    options: TransitionInteractionOptions,
  ): InteractionState | null {
    const currentState = this.states.get(chatId);
    if (!currentState) {
      return null;
    }

    const now = Date.now();
    const nextState: InteractionState = {
      ...currentState,
      kind: options.kind ?? currentState.kind,
      expectedInput: options.expectedInput ?? currentState.expectedInput,
      allowedCommands:
        options.allowedCommands !== undefined
          ? normalizeAllowedCommands(options.allowedCommands)
          : [...currentState.allowedCommands],
      metadata: options.metadata
        ? { ...options.metadata }
        : { ...currentState.metadata },
      expiresAt:
        options.expiresInMs === undefined
          ? currentState.expiresAt
          : options.expiresInMs === null
            ? null
            : now + options.expiresInMs,
    };
    this.states.set(chatId, nextState);

    logger.debug(
      `[InteractionManager] Transitioned interaction: chatId=${chatId}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return cloneState(nextState);
  }

  clear(chatId: string, reason: InteractionClearReason = "manual"): void {
    const state = this.states.get(chatId);
    if (!state) {
      return;
    }

    logger.info(
      `[InteractionManager] Cleared interaction: chatId=${chatId}, reason=${reason}, kind=${state.kind}, expectedInput=${state.expectedInput}`,
    );
    this.states.delete(chatId);
  }

  startBusy(chatId: string, metadata: Record<string, unknown> = {}): BusyState {
    const nextBusyState: BusyState = {
      createdAt: Date.now(),
      metadata: { ...metadata },
    };
    this.busyStates.set(chatId, nextBusyState);
    logger.info(`[InteractionManager] Busy state started: chatId=${chatId}`);
    return cloneBusyState(nextBusyState) as BusyState;
  }

  clearBusy(chatId: string): void {
    if (!this.busyStates.has(chatId)) {
      return;
    }

    this.busyStates.delete(chatId);
    logger.info(`[InteractionManager] Busy state cleared: chatId=${chatId}`);
  }

  isBusy(chatId: string): boolean {
    return this.busyStates.has(chatId);
  }

  getBusyState(chatId: string): BusyState | null {
    return cloneBusyState(this.busyStates.get(chatId) ?? null);
  }

  clearAll(reason: InteractionClearReason = "manual"): void {
    for (const chatId of Array.from(this.states.keys())) {
      this.clear(chatId, reason);
    }

    for (const chatId of Array.from(this.busyStates.keys())) {
      this.clearBusy(chatId);
    }
  }

  __resetForTests(): void {
    this.states.clear();
    this.busyStates.clear();
  }

  resolveGuardDecision(
    chatId: string,
    input: InteractionInput,
    options: ResolveInteractionGuardOptions = {},
  ): GuardDecision {
    const state = this.getSnapshot(chatId);
    const { inputType, command } = classifyIncomingInput(input);
    const isBusy = options.busy ?? this.isBusy(chatId);
    const busyAllowedCommands = new Set(
      normalizeAllowedCommands(
        options.busyAllowedCommands ?? BUSY_ALLOWED_COMMANDS,
      ),
    );
    const allowBusyKinds = new Set(
      options.allowBusyKinds ?? ["question", "permission"],
    );

    if (state && this.isExpired(chatId)) {
      this.clear(chatId, "expired");
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

      if (!state && inputType === "text") {
        return createAllowDecision(inputType, null, command, true);
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
