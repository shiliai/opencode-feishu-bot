import type { Logger } from "../utils/logger.js";
import { computeNextCronRunAt } from "./next-run.js";
import type { TaskStore } from "./store.js";
import type {
  ScheduledTask,
  ScheduledTaskStatus,
  TaskExecutionResult,
} from "./types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TaskRuntimeCallbacks {
  executeTask: (task: ScheduledTask) => Promise<TaskExecutionResult>;
  onTaskUpdate: (taskId: string, updates: Partial<ScheduledTask>) => void;
  onTaskResult?: (result: TaskExecutionResult, task: ScheduledTask) => void;
}

export class ScheduledTaskRuntime {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly store: TaskStore;
  private readonly callbacks: TaskRuntimeCallbacks;
  private readonly logger: Logger;
  private started = false;

  constructor(
    store: TaskStore,
    callbacks: TaskRuntimeCallbacks,
    logger: Logger,
  ) {
    this.store = store;
    this.callbacks = callbacks;
    this.logger = logger;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const tasks = this.store.listTasks();
    for (const task of tasks) {
      if (task.lastStatus === "running") {
        this.callbacks.onTaskUpdate(task.id, {
          lastStatus: "error",
          lastError: "Interrupted by restart",
        });
      }
      this.scheduleTask(task.id);
    }

    this.logger.info(`[TaskRuntime] Started with ${tasks.length} tasks`);
  }

  stop(): void {
    for (const [taskId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    this.started = false;
    this.logger.info("[TaskRuntime] Stopped");
  }

  scheduleTask(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(taskId);
    }

    const task = this.store.getTask(taskId);
    if (!task || !task.nextRunAt) {
      return;
    }

    const nextRun = new Date(task.nextRunAt);
    if (Number.isNaN(nextRun.getTime())) {
      return;
    }

    const delay = nextRun.getTime() - Date.now();
    if (delay <= 0) {
      this.runTask(taskId).catch((err: unknown) => {
        this.logger.error(`[TaskRuntime] Error running task ${taskId}`, err);
      });
      return;
    }

    this.scheduleWithDelay(taskId, delay);
  }

  cancelTask(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  private scheduleWithDelay(taskId: string, delay: number): void {
    const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      const remainingDelay = delay - clampedDelay;

      if (remainingDelay > 0) {
        this.scheduleWithDelay(taskId, remainingDelay);
      } else {
        this.runTask(taskId).catch((err: unknown) => {
          this.logger.error(`[TaskRuntime] Error running task ${taskId}`, err);
        });
      }
    }, clampedDelay);

    this.timers.set(taskId, timer);
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) {
      return;
    }

    this.callbacks.onTaskUpdate(taskId, {
      lastStatus: "running",
      lastRunAt: new Date().toISOString(),
    });

    const result = await this.callbacks.executeTask(task);

    const updates: Partial<ScheduledTask> = {
      lastStatus: result.status as ScheduledTaskStatus,
      lastError: result.errorMessage,
      runCount: task.runCount + 1,
    };

    if (task.kind === "cron" && task.cron) {
      const nextRun = computeNextCronRunAt(task.cron, task.timezone);
      updates.nextRunAt = nextRun?.toISOString() ?? null;
      this.callbacks.onTaskUpdate(taskId, updates);
      this.scheduleTask(taskId);
    } else {
      updates.nextRunAt = null;
      this.callbacks.onTaskUpdate(taskId, updates);
      this.store.removeTask(taskId);
      this.cancelTask(taskId);
      this.logger.info(
        `[TaskRuntime] One-time task ${taskId} completed and removed`,
      );
    }

    if (this.callbacks.onTaskResult) {
      try {
        this.callbacks.onTaskResult(result, task);
      } catch (deliveryError) {
        this.logger.error(
          `[TaskRuntime] onTaskResult callback failed for task ${taskId}`,
          deliveryError,
        );
      }
    }
  }
}
