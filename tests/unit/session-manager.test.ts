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
      clearChatSession: vi.fn(),
      clearSession: vi.fn(),
      getChatSession: vi.fn().mockReturnValue(undefined),
      getCurrentSession: vi.fn().mockReturnValue(session),
      setChatSession: vi.fn(),
      setCurrentSession: vi.fn(),
    };

    const manager = new SessionManager(store);

    manager.setCurrentSession(session);
    expect(store.setCurrentSession).toHaveBeenCalledWith(session);
    expect(manager.getCurrentSession()).toEqual(session);

    manager.setChatSession("chat-1", session);
    expect(store.setChatSession).toHaveBeenCalledWith("chat-1", session);
    expect(manager.getChatSession("chat-1")).toBeUndefined();

    manager.clearSession();
    expect(store.clearSession).toHaveBeenCalledTimes(1);
    manager.clearChatSession("chat-1");
    expect(store.clearChatSession).toHaveBeenCalledWith("chat-1");
  });

  it("returns null when there is no current session", () => {
    const manager = new SessionManager({
      clearChatSession: vi.fn(),
      clearSession: vi.fn(),
      getChatSession: vi.fn().mockReturnValue(undefined),
      getCurrentSession: vi.fn().mockReturnValue(undefined),
      setChatSession: vi.fn(),
      setCurrentSession: vi.fn(),
    });

    expect(manager.getCurrentSession()).toBeNull();
    expect(manager.getChatSession("chat-1")).toBeUndefined();
  });
});
