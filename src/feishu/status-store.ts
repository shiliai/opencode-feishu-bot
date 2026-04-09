import type {
  SummaryFileChange,
  SummaryTokensInfo,
  SummaryToolEvent,
} from "../summary/types.js";

export interface ResponsePipelineTurnContext {
  sessionId: string;
  directory: string;
  receiveId: string;
  sourceMessageId: string;
}

export interface StatusTurnState extends ResponsePipelineTurnContext {
  abortRequested?: boolean;
  statusCardMessageId?: string;
  lastPartialSignature?: string;
  lastPartialText?: string;
  lastPatchedSignature?: string;
  lastPatchedText?: string;
  accumulatedReasoning?: string;
  reasoningStartTime?: number;
  latestCompletedText?: string;
  turnStartTime: number;
  pendingCompletion: boolean;
  cardUpdatesBroken: boolean;
  finalReplySent: boolean;
  finalReplyUuid?: string;
  toolEvents: SummaryToolEvent[];
  diffs: SummaryFileChange[];
  latestTokens?: SummaryTokensInfo;
  subscriptionAbortController?: AbortController;
  statusUpdateTimer?: ReturnType<typeof setTimeout>;
}

export class StatusStore {
  private readonly turns = new Map<string, StatusTurnState>();

  startTurn(context: ResponsePipelineTurnContext): StatusTurnState {
    const state: StatusTurnState = {
      ...context,
      turnStartTime: Date.now(),
      pendingCompletion: false,
      cardUpdatesBroken: false,
      finalReplySent: false,
      toolEvents: [],
      diffs: [],
    };

    this.turns.set(context.sessionId, state);
    return state;
  }

  get(sessionId: string): StatusTurnState | undefined {
    return this.turns.get(sessionId);
  }

  update(
    sessionId: string,
    updater: (state: StatusTurnState) => void,
  ): StatusTurnState | undefined {
    const state = this.turns.get(sessionId);
    if (!state) {
      return undefined;
    }

    updater(state);
    return state;
  }

  clear(sessionId: string): StatusTurnState | undefined {
    const state = this.turns.get(sessionId);
    if (!state) {
      return undefined;
    }

    this.turns.delete(sessionId);
    return state;
  }

  clearAll(): StatusTurnState[] {
    const states = Array.from(this.turns.values());
    this.turns.clear();
    return states;
  }

  getSessionIds(): string[] {
    return Array.from(this.turns.keys());
  }
}

export const statusStore = new StatusStore();
