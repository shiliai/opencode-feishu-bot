export type ScheduledTaskKind = "cron" | "once";
export type ScheduledTaskStatus = "idle" | "running" | "success" | "error";

export interface ScheduledTask {
  id: string;
  projectId: string;
  projectWorktree: string;
  model: { providerID: string; modelID: string };
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
