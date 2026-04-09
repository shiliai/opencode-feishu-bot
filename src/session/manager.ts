import {
  settingsManager,
  type SessionInfo,
  type SettingsManager,
} from "../settings/manager.js";

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
  constructor(
    private readonly store: SessionStore = settingsManager as SettingsManager,
  ) {}

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

export const sessionManager = new SessionManager();

export function setCurrentSession(sessionInfo: SessionInfo): void {
  sessionManager.setCurrentSession(sessionInfo);
}

export function getCurrentSession(): SessionInfo | null {
  return sessionManager.getCurrentSession();
}

export function clearSession(): void {
  sessionManager.clearSession();
}

export function setChatSession(chatId: string, sessionInfo: SessionInfo): void {
  sessionManager.setChatSession(chatId, sessionInfo);
}

export function getChatSession(chatId: string): SessionInfo | undefined {
  return sessionManager.getChatSession(chatId);
}

export function clearChatSession(chatId: string): void {
  sessionManager.clearChatSession(chatId);
}
