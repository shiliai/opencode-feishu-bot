import {
  settingsManager,
  type SessionInfo,
  type SettingsManager,
} from "../settings/manager.js";

export type { SessionInfo };

export interface SessionStore {
  clearSession(): void;
  getCurrentSession(): SessionInfo | undefined;
  setCurrentSession(sessionInfo: SessionInfo): void;
}

export class SessionManager {
  constructor(
    private readonly store: SessionStore = settingsManager as SettingsManager,
  ) {}

  setCurrentSession(sessionInfo: SessionInfo): void {
    this.store.setCurrentSession(sessionInfo);
  }

  getCurrentSession(): SessionInfo | null {
    return this.store.getCurrentSession() ?? null;
  }

  clearSession(): void {
    this.store.clearSession();
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
