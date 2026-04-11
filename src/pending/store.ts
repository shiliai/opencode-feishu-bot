import type { PendingRequest, PendingRequestType } from "./types.js";

export class PendingInteractionStore {
  private readonly byRequestId = new Map<string, PendingRequest>();

  add(
    requestId: string,
    sessionId: string,
    directory: string,
    chatId: string,
    type: PendingRequestType,
  ): PendingRequest {
    const existing = this.byRequestId.get(requestId);
    if (existing) {
      return existing;
    }

    const entry: PendingRequest = {
      requestId,
      sessionId,
      directory,
      chatId,
      type,
      cardMessageId: null,
      createdAt: Date.now(),
    };
    this.byRequestId.set(requestId, entry);
    return entry;
  }

  setCardMessageId(requestId: string, cardMessageId: string): boolean {
    const entry = this.byRequestId.get(requestId);
    if (!entry) {
      return false;
    }
    entry.cardMessageId = cardMessageId;
    return true;
  }

  get(requestId: string): PendingRequest | undefined {
    return this.byRequestId.get(requestId);
  }

  getBySessionId(sessionId: string): PendingRequest[] {
    const result: PendingRequest[] = [];
    for (const entry of this.byRequestId.values()) {
      if (entry.sessionId === sessionId) {
        result.push(entry);
      }
    }
    return result;
  }

  getByCardMessageId(cardMessageId: string): PendingRequest | undefined {
    for (const entry of this.byRequestId.values()) {
      if (entry.cardMessageId === cardMessageId) {
        return entry;
      }
    }
    return undefined;
  }

  remove(requestId: string): boolean {
    return this.byRequestId.delete(requestId);
  }

  removeBySessionId(sessionId: string): number {
    let removed = 0;
    for (const [requestId, entry] of this.byRequestId) {
      if (entry.sessionId === sessionId) {
        this.byRequestId.delete(requestId);
        removed++;
      }
    }
    return removed;
  }

  has(requestId: string): boolean {
    return this.byRequestId.has(requestId);
  }

  size(): number {
    return this.byRequestId.size;
  }

  getAll(): PendingRequest[] {
    return [...this.byRequestId.values()];
  }

  clear(): void {
    this.byRequestId.clear();
  }
}
