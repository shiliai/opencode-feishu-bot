import { computeNextCronRunAt } from "./next-run.js";
import type { ParsedTaskSchedule } from "./types.js";

function parseCommonSchedule(text: string): ParsedTaskSchedule {
  const lower = text.toLowerCase().trim();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const everyMinutesMatch = lower.match(/every\s+(\d+)\s*min/);
  if (everyMinutesMatch) {
    const mins = Number.parseInt(everyMinutesMatch[1], 10);
    const cron = `*/${Math.max(5, mins)} * * * *`;
    const nextRun = computeNextCronRunAt(cron, timezone);
    return {
      kind: "cron",
      cron,
      runAt: null,
      timezone,
      summary:
        mins >= 60
          ? `every ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`
          : `every ${mins}m`,
      nextRunAt: nextRun?.toISOString() ?? new Date().toISOString(),
    };
  }

  if (lower.includes("hour") || lower.includes("hourly")) {
    const cron = "0 * * * *";
    const nextRun = computeNextCronRunAt(cron, timezone);
    return {
      kind: "cron",
      cron,
      runAt: null,
      timezone,
      summary: "hourly",
      nextRunAt: nextRun?.toISOString() ?? new Date().toISOString(),
    };
  }

  const dailyMatch = lower.match(
    /(?:every\s+)?day(?:ly)?\s*(?:at\s+)?(\d{1,2})?[:h]?(\d{2})?/,
  );
  if (lower.includes("daily") || lower.includes("every day") || dailyMatch) {
    const hour = dailyMatch?.[1] ? Number.parseInt(dailyMatch[1], 10) : 9;
    const minute = dailyMatch?.[2] ? Number.parseInt(dailyMatch[2], 10) : 0;
    const cron = `${minute} ${hour} * * *`;
    const nextRun = computeNextCronRunAt(cron, timezone);
    return {
      kind: "cron",
      cron,
      runAt: null,
      timezone,
      summary: `daily ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      nextRunAt: nextRun?.toISOString() ?? new Date().toISOString(),
    };
  }

  if (lower.includes("weekday")) {
    const timeMatch = lower.match(/(\d{1,2})[:h]?(\d{2})?/);
    const hour = timeMatch?.[1] ? Number.parseInt(timeMatch[1], 10) : 9;
    const minute = timeMatch?.[2] ? Number.parseInt(timeMatch[2], 10) : 0;
    const cron = `${minute} ${hour} * * 1-5`;
    const nextRun = computeNextCronRunAt(cron, timezone);
    return {
      kind: "cron",
      cron,
      runAt: null,
      timezone,
      summary: `weekdays ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      nextRunAt: nextRun?.toISOString() ?? new Date().toISOString(),
    };
  }

  if (lower.includes("week")) {
    const cron = "0 9 * * 1";
    const nextRun = computeNextCronRunAt(cron, timezone);
    return {
      kind: "cron",
      cron,
      runAt: null,
      timezone,
      summary: "weekly Mon 09:00",
      nextRunAt: nextRun?.toISOString() ?? new Date().toISOString(),
    };
  }

  const now = new Date();
  return {
    kind: "once",
    cron: null,
    runAt: now.toISOString(),
    timezone,
    summary: text.slice(0, 50),
    nextRunAt: now.toISOString(),
  };
}

export function parseSchedule(text: string): ParsedTaskSchedule {
  return parseCommonSchedule(text);
}
