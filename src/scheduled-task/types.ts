export type ScheduledTaskKind = "cron" | "once";
export type ScheduledTaskStatus = "idle" | "running" | "success" | "error";

export interface ScheduledTaskModel {
  providerID: string;
  modelID: string;
  variant?: string | null;
}

export interface ScheduledTask {
  id: string;
  chatId: string;
  projectId: string;
  projectWorktree: string;
  model: ScheduledTaskModel;
  kind: ScheduledTaskKind;
  cron: string | null;
  runAt: string | null;
  scheduleText: string;
  scheduleSummary: string;
  timezone: string;
  prompt: string;
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: ScheduledTaskStatus | null;
  lastError: string | null;
}

export interface ParsedTaskSchedule {
  kind: ScheduledTaskKind;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  summary: string;
  nextRunAt: string;
}

export interface TaskExecutionResult {
  taskId: string;
  status: "success" | "error";
  startedAt: string;
  finishedAt: string;
  resultText: string | null;
  errorMessage: string | null;
}
