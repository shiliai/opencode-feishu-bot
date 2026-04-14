import type { Logger } from "../utils/logger.js";
import type { ScheduledTaskSessionTracker } from "./session-tracker.js";
import type { ScheduledTask, TaskExecutionResult } from "./types.js";

const SCHEDULED_TASK_AGENT = "build";
const SCHEDULED_TASK_SESSION_TITLE = "Scheduled task run";

export interface TaskExecutorDeps {
  sessionClient: {
    create(parameters?: Record<string, unknown>): Promise<{
      data?: unknown;
      error?: unknown;
    }>;
    prompt(parameters: Record<string, unknown>): Promise<unknown>;
    delete(parameters: { sessionID: string }): Promise<{
      data?: unknown;
      error?: unknown;
    }>;
  };
  logger: Logger;
  sessionTracker?: ScheduledTaskSessionTracker;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Unknown scheduled task execution error";
}

function collectResponseText(
  parts: Array<{ type?: string; text?: string; ignored?: boolean }>,
): string {
  return parts
    .filter(
      (part) =>
        part.type === "text" && typeof part.text === "string" && !part.ignored,
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

export async function executeTask(
  deps: TaskExecutorDeps,
  task: ScheduledTask,
): Promise<TaskExecutionResult> {
  const { sessionClient, logger, sessionTracker } = deps;
  const startedAt = new Date().toISOString();
  let sessionId: string | null = null;

  try {
    const createResult = await sessionClient.create({
      directory: task.projectWorktree,
      title: SCHEDULED_TASK_SESSION_TITLE,
    });

    if (createResult.error || !createResult.data) {
      throw (
        createResult.error ??
        new Error("Failed to create temporary scheduled task session")
      );
    }

    const data = isRecord(createResult.data) ? createResult.data : null;
    sessionId = (data?.id as string) ?? null;
    if (!sessionId) {
      throw new Error("No session ID from task session creation");
    }

    sessionTracker?.add(sessionId);

    const promptOptions: Record<string, unknown> = {
      sessionID: sessionId,
      directory: task.projectWorktree,
      parts: [{ type: "text", text: task.prompt }],
      agent: SCHEDULED_TASK_AGENT,
    };

    if (task.model.providerID && task.model.modelID) {
      promptOptions.model = {
        providerID: task.model.providerID,
        modelID: task.model.modelID,
      };
    }

    if (task.model.variant) {
      promptOptions.variant = task.model.variant;
    }

    const promptResult = await sessionClient.prompt(promptOptions);

    const response = promptResult as {
      data?: {
        parts?: Array<{
          type?: string;
          text?: string;
          ignored?: boolean;
        }>;
      };
      error?: unknown;
    };

    if (response.error || !response.data) {
      throw (
        response.error ?? new Error("Scheduled task prompt execution failed")
      );
    }

    const resultText = collectResponseText(response.data.parts ?? []);
    if (!resultText) {
      throw new Error("Scheduled task returned an empty assistant response");
    }

    logger.info(
      `[TaskExecutor] Task ${task.id} completed successfully (${resultText.length} chars)`,
    );

    return {
      taskId: task.id,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      resultText,
      errorMessage: null,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.warn(`[TaskExecutor] Task ${task.id} failed: ${errorMessage}`);

    return {
      taskId: task.id,
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      resultText: null,
      errorMessage,
    };
  } finally {
    if (sessionId) {
      sessionTracker?.remove(sessionId);
      try {
        await sessionClient.delete({ sessionID: sessionId });
      } catch (deleteError) {
        logger.warn(
          `[TaskExecutor] Failed to delete temporary session: sessionId=${sessionId}`,
          deleteError,
        );
      }
    }
  }
}
