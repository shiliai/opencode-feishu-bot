import { describe, expect, it, vi } from "vitest";
import type {
  SessionInfo,
  SettingsManager,
} from "../../src/settings/manager.js";
import {
  resolvePromptSession,
  type OpenCodeSessionClient,
} from "../../src/feishu/handlers/session-resolution.js";

function createMockSettings(
  overrides?: Partial<SettingsManager>,
): SettingsManager {
  return {
    getCurrentProject: vi.fn().mockReturnValue(undefined),
    getChatSession: vi.fn().mockReturnValue(undefined),
    setChatSession: vi.fn(),
    clearChatSession: vi.fn(),
    clearChatStatusMessageId: vi.fn(),
    __resetSettingsForTests: vi.fn(),
    ...overrides,
  } as unknown as SettingsManager;
}

const CHAT_ID = "chat-1";

describe("resolvePromptSession", () => {
  it("returns no-project when no current project is set", async () => {
    const settings = createMockSettings();
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn(),
    };

    const result = await resolvePromptSession({
      chatId: CHAT_ID,
      settings,
      openCodeSession,
    });

    expect(result).toEqual({ kind: "no-project" });
    expect(openCodeSession.create).not.toHaveBeenCalled();
  });

  it("returns session-reset when persisted session directory differs from current project", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-2",
        worktree: "/workspace/new-project",
      }),
      getChatSession: vi.fn().mockReturnValue({
        id: "session-1",
        title: "Old session",
        directory: "/workspace/old-project",
      }),
    });
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn(),
    };

    const result = await resolvePromptSession({
      chatId: CHAT_ID,
      settings,
      openCodeSession,
    });

    expect(result).toEqual({
      kind: "session-reset",
      previousDirectory: "/workspace/old-project",
      currentDirectory: "/workspace/new-project",
    });
    expect(settings.clearChatSession).toHaveBeenCalledWith(CHAT_ID);
    expect(settings.clearChatStatusMessageId).toHaveBeenCalledWith(CHAT_ID);
    expect(openCodeSession.create).not.toHaveBeenCalled();
  });

  it("returns session-ready (not created) when existing session matches current project", async () => {
    const existingSession: SessionInfo = {
      id: "session-1",
      title: "Existing session",
      directory: "/workspace/project",
    };
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
      getChatSession: vi.fn().mockReturnValue(existingSession),
    });
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn(),
    };

    const result = await resolvePromptSession({
      chatId: CHAT_ID,
      settings,
      openCodeSession,
    });

    expect(result).toEqual({
      kind: "session-ready",
      sessionInfo: existingSession,
      directory: "/workspace/project",
      created: false,
    });
    expect(openCodeSession.create).not.toHaveBeenCalled();
  });

  it("creates a new session and persists it when no existing session exists", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
    });
    const newSession = {
      id: "session-new",
      title: "New session",
      directory: "/workspace/project",
    };
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn().mockResolvedValue({ data: newSession, error: undefined }),
    };

    const result = await resolvePromptSession({
      chatId: CHAT_ID,
      settings,
      openCodeSession,
    });

    expect(result.kind).toBe("session-ready");
    if (result.kind !== "session-ready") {
      throw new Error("unexpected result kind");
    }
    expect(result.created).toBe(true);
    expect(result.sessionInfo.id).toBe("session-new");
    expect(result.directory).toBe("/workspace/project");
    expect(openCodeSession.create).toHaveBeenCalledWith({
      directory: "/workspace/project",
    });
    expect(settings.setChatSession).toHaveBeenCalledWith(CHAT_ID, {
      id: "session-new",
      title: "New session",
      directory: "/workspace/project",
    });
  });

  it("throws when OpenCode session creation fails", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
    });
    const openCodeSession: OpenCodeSessionClient = {
      create: vi
        .fn()
        .mockResolvedValue({
          data: undefined,
          error: new Error("server down"),
        }),
    };

    await expect(
      resolvePromptSession({ chatId: CHAT_ID, settings, openCodeSession }),
    ).rejects.toThrow("Failed to create OpenCode session");
  });

  it("uses data.directory as fallback when present in create response", async () => {
    const settings = createMockSettings({
      getCurrentProject: vi.fn().mockReturnValue({
        id: "proj-1",
        worktree: "/workspace/project",
      }),
    });
    const newSession = {
      id: "session-new",
      title: "New",
      directory: "/workspace/resolved-path",
    };
    const openCodeSession: OpenCodeSessionClient = {
      create: vi.fn().mockResolvedValue({ data: newSession, error: undefined }),
    };

    const result = await resolvePromptSession({
      chatId: CHAT_ID,
      settings,
      openCodeSession,
    });

    expect(result.kind).toBe("session-ready");
    if (result.kind !== "session-ready") {
      throw new Error("unexpected result kind");
    }
    expect(result.sessionInfo.directory).toBe("/workspace/resolved-path");
  });
});
