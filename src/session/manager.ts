import type { SessionInfo, SettingsManager } from "../settings/manager.js";

export type { SessionInfo };

export interface SessionStore {
  clearChatSession(chatId: string): void;
  clearSession(): void;
  getChatSession(chatId: string): SessionInfo | undefined;
  getCurrentSession(): SessionInfo | undefined;
  setChatSession(chatId: string, sessionInfo: SessionInfo): void;
  setCurrentSession(sessionInfo: SessionInfo): void;
}

export class SessionManager {
  constructor(private readonly store: SessionStore | SettingsManager) {}

  setCurrentSession(sessionInfo: SessionInfo): void {
    this.store.setCurrentSession(sessionInfo);
  }

  setChatSession(chatId: string, sessionInfo: SessionInfo): void {
    this.store.setChatSession(chatId, sessionInfo);
  }

  getCurrentSession(): SessionInfo | null {
    return this.store.getCurrentSession() ?? null;
  }

  getChatSession(chatId: string): SessionInfo | undefined {
    return this.store.getChatSession(chatId);
  }

  clearSession(): void {
    this.store.clearSession();
  }

  clearChatSession(chatId: string): void {
    this.store.clearChatSession(chatId);
  }
}
