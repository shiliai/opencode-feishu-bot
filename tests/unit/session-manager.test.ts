import { describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionInfo } from "../../src/session/manager.js";

describe("SessionManager", () => {
  it("delegates session persistence to the underlying settings store", () => {
    const session: SessionInfo = {
      id: "session-1",
      title: "Bridge session",
      directory: "/workspace",
    };
    const store = {
      clearSession: vi.fn(),
      getCurrentSession: vi.fn().mockReturnValue(session),
      setCurrentSession: vi.fn(),
    };

    const manager = new SessionManager(store);

    manager.setCurrentSession(session);
    expect(store.setCurrentSession).toHaveBeenCalledWith(session);
    expect(manager.getCurrentSession()).toEqual(session);

    manager.clearSession();
    expect(store.clearSession).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no current session", () => {
    const manager = new SessionManager({
      clearSession: vi.fn(),
      getCurrentSession: vi.fn().mockReturnValue(undefined),
      setCurrentSession: vi.fn(),
    });

    expect(manager.getCurrentSession()).toBeNull();
  });
});
