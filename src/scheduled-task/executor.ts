import type { Logger } from "../utils/logger.js";
import type { ScheduledTask } from "./types.js";

export interface TaskExecutionResult {
  status: "success" | "error";
  error: string | null;
}

export interface TaskExecutorDeps {
  sessionClient: {
    create(parameters?: Record<string, unknown>): Promise<{
      data?: unknown;
      error?: unknown;
    }>;
    prompt(parameters: Record<string, unknown>): Promise<unknown>;
    abort(parameters: Record<string, unknown>): Promise<unknown>;
  };
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function executeTask(
  deps: TaskExecutorDeps,
  task: ScheduledTask,
): Promise<TaskExecutionResult> {
  const { sessionClient, logger } = deps;
  let sessionId: string | null = null;

  try {
    const createResult = await sessionClient.create({
      directory: task.projectWorktree,
      title: `Scheduled task: ${task.scheduleSummary}`,
    });

    if (createResult.error || !createResult.data) {
      throw createResult.error ?? new Error("Failed to create session");
    }

    const data = isRecord(createResult.data) ? createResult.data : null;
    sessionId = (data?.id as string) ?? null;
    if (!sessionId) {
      throw new Error("No session ID from task session creation");
    }

    await sessionClient.prompt({
      sessionID: sessionId,
      directory: task.projectWorktree,
      model: { providerID: task.model.providerID, modelID: task.model.modelID },
      agent: "build",
      parts: [{ type: "text", text: task.prompt }],
    } as Record<string, unknown>);

    logger.info(`[TaskExecutor] Task ${task.id} prompt dispatched`);

    return { status: "success", error: null };
  } catch (error) {
    logger.error(`[TaskExecutor] Task ${task.id} failed`, error);
    return { status: "error", error: getErrorMessage(error) };
  } finally {
    if (sessionId) {
      try {
        await sessionClient.abort({ sessionID: sessionId });
      } catch {
        // intentional: cleanup is best-effort
      }
    }
  }
}
