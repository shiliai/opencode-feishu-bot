import type { Session } from "@opencode-ai/sdk/v2";
import type { SessionInfo, SettingsManager } from "../../settings/manager.js";
import type { Logger } from "../../utils/logger.js";
import { logger as defaultLogger } from "../../utils/logger.js";

export interface OpenCodeSessionClient {
  create(parameters?: {
    directory?: string;
    title?: string;
  }): Promise<{ data: Session | undefined; error: unknown }>;
}

export type SessionResolutionResult =
  | { kind: "no-project" }
  | {
      kind: "session-reset";
      previousDirectory: string;
      currentDirectory: string;
    }
  | {
      kind: "session-ready";
      sessionInfo: SessionInfo;
      directory: string;
      created: boolean;
    };

export interface SessionResolutionDependencies {
  settings: SettingsManager;
  openCodeSession: OpenCodeSessionClient;
  logger?: Logger;
}

export async function resolvePromptSession(
  dependencies: SessionResolutionDependencies,
): Promise<SessionResolutionResult> {
  const { settings, openCodeSession, logger = defaultLogger } = dependencies;

  const currentProject = settings.getCurrentProject();
  if (!currentProject) {
    return { kind: "no-project" };
  }

  const currentDirectory = currentProject.worktree;
  const existingSession = settings.getCurrentSession();

  if (existingSession && existingSession.directory !== currentDirectory) {
    logger.info(
      `[SessionResolution] Session directory mismatch: persisted=${existingSession.directory}, current=${currentDirectory}. Resetting.`,
    );

    const previousDirectory = existingSession.directory;
    settings.clearSession();
    settings.clearStatusMessageId();

    return {
      kind: "session-reset",
      previousDirectory,
      currentDirectory,
    };
  }

  if (existingSession) {
    return {
      kind: "session-ready",
      sessionInfo: existingSession,
      directory: currentDirectory,
      created: false,
    };
  }

  logger.info(
    `[SessionResolution] No existing session for project ${currentProject.id}. Creating new session.`,
  );

  const { data, error } = await openCodeSession.create({
    directory: currentDirectory,
  });

  if (error || !data) {
    logger.error(
      `[SessionResolution] Failed to create OpenCode session for directory=${currentDirectory}`,
      error,
    );
    throw new Error(
      `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sessionInfo: SessionInfo = {
    id: data.id,
    title: data.title,
    directory: data.directory ?? currentDirectory,
  };

  settings.setCurrentSession(sessionInfo);

  logger.info(
    `[SessionResolution] Created new session: id=${sessionInfo.id}, directory=${sessionInfo.directory}`,
  );

  return {
    kind: "session-ready",
    sessionInfo,
    directory: currentDirectory,
    created: true,
  };
}
