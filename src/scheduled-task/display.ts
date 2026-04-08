import type { ScheduledTask } from "./types.js";

export function formatScheduleBadge(schedule: {
  kind: string;
  cron: string | null;
  scheduleSummary: string;
}): string {
  return schedule.scheduleSummary || schedule.cron || "unknown";
}

export function formatTaskStatus(status: string | null): string {
  switch (status) {
    case "running":
      return "🔄 Running";
    case "success":
      return "✅ Success";
    case "error":
      return "❌ Error";
    default:
      return "⏳ Pending";
  }
}

export function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) {
    return "—";
  }
  const date = new Date(nextRunAt);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
}

export function formatTaskListItem(task: ScheduledTask): string {
  const badge = formatScheduleBadge(task);
  const status = formatTaskStatus(task.lastStatus);
  const nextRun = formatNextRun(task.nextRunAt);
  const truncatedPrompt =
    task.prompt.length > 80 ? `${task.prompt.slice(0, 79)}…` : task.prompt;
  return `${status} **${badge}**\n   Prompt: ${truncatedPrompt}\n   Next: ${nextRun} · Runs: ${task.runCount}`;
}
