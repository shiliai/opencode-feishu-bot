import type { Logger } from "../utils/logger.js";
import { computeNextCronRunAt } from "./next-run.js";
import type { ParsedTaskSchedule } from "./types.js";

const SCHEDULE_PARSE_SESSION_TITLE = "Scheduled task schedule parser";

export interface ScheduleParserSessionClient {
  create(parameters?: Record<string, unknown>): Promise<{
    data?: Record<string, unknown>;
    error?: unknown;
  }>;
  prompt(parameters: Record<string, unknown>): Promise<unknown>;
  delete(parameters: { sessionID: string }): Promise<{
    data?: unknown;
    error?: unknown;
  }>;
}

export interface ScheduleParserDeps {
  sessionClient: ScheduleParserSessionClient;
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoDatetime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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

function extractJsonPayload(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Empty schedule parser response");
  }

  const directCandidates = [trimmed];
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    directCandidates.unshift(fencedMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    directCandidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of directCandidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }

  throw new Error("Schedule parser returned invalid JSON");
}

function validateParsedSchedule(value: unknown): ParsedTaskSchedule {
  if (!isRecord(value)) {
    throw new Error("Schedule parser returned an invalid payload");
  }

  const kind = value.kind;
  const summary = value.summary;
  const timezone = value.timezone;
  const nextRunAt = value.nextRunAt;

  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("Schedule summary is missing");
  }

  if (!isValidTimezone(timezone)) {
    throw new Error("Schedule timezone is invalid");
  }

  if (!isValidIsoDatetime(nextRunAt)) {
    throw new Error("Schedule nextRunAt is invalid");
  }

  if (kind === "cron") {
    if (typeof value.cron !== "string" || !value.cron.trim()) {
      throw new Error("Schedule cron expression is missing");
    }

    return {
      kind,
      cron: value.cron,
      runAt: null,
      timezone,
      summary: summary.trim(),
      nextRunAt,
    };
  }

  if (kind === "once") {
    if (!isValidIsoDatetime(value.runAt)) {
      throw new Error("Schedule runAt is invalid");
    }

    return {
      kind,
      cron: null,
      runAt: value.runAt,
      timezone,
      summary: summary.trim(),
      nextRunAt,
    };
  }

  throw new Error("Schedule kind is invalid");
}

function parseSchedulePayload(rawText: string): ParsedTaskSchedule {
  const payload = extractJsonPayload(rawText);

  if (
    isRecord(payload) &&
    typeof payload.error === "string" &&
    payload.error.trim()
  ) {
    throw new Error(payload.error.trim());
  }

  return validateParsedSchedule(payload);
}

function buildSchedulePrompt(scheduleText: string, timezone: string): string {
  const now = new Date().toISOString();

  return [
    "Parse the following natural-language task schedule and return JSON only.",
    "Do not use markdown, explanations, code fences, or any extra text.",
    `Assume the default timezone is ${timezone}.`,
    `Current date/time reference: ${now}.`,
    "Supported interpretations include recurring schedules and one-time schedules.",
    "If parsing succeeds, return exactly one JSON object with keys: kind, timezone, summary, nextRunAt, and either cron or runAt.",
    'Use kind="cron" for recurring schedules and kind="once" for one-time schedules.',
    "summary must be a concise human-readable description in the same language as the input.",
    "nextRunAt and runAt must be ISO 8601 timestamps with timezone offset.",
    'If parsing fails or input is ambiguous, return {"error":"short explanation"}.',
    "",
    `Input: ${scheduleText}`,
  ].join("\n");
}

/**
 * Parse schedule text using an AI session to handle natural-language
 * (including Chinese and other non-English) schedule expressions.
 *
 * Creates a temporary OpenCode session, sends a structured prompt for
 * JSON output, validates the result, and cleans up the session.
 */
export async function parseScheduleWithAI(
  deps: ScheduleParserDeps,
  scheduleText: string,
  directory: string,
): Promise<ParsedTaskSchedule> {
  const { sessionClient, logger } = deps;
  const trimmedText = scheduleText.trim();
  if (!trimmedText) {
    throw new Error("Schedule text is empty");
  }

  const trimmedDirectory = directory.trim();
  if (!trimmedDirectory) {
    throw new Error("Schedule parser directory is empty");
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let sessionId: string | null = null;

  try {
    const createResult = await sessionClient.create({
      directory: trimmedDirectory,
      title: SCHEDULE_PARSE_SESSION_TITLE,
    });

    if (createResult.error || !createResult.data) {
      throw (
        createResult.error ??
        new Error("Failed to create temporary schedule parser session")
      );
    }

    const data = isRecord(createResult.data) ? createResult.data : null;
    sessionId = (data?.id as string) ?? null;
    if (!sessionId) {
      throw new Error("No session ID from schedule parser session");
    }

    const promptResult = await sessionClient.prompt({
      sessionID: sessionId,
      directory: trimmedDirectory,
      system:
        "You are a schedule parser. Your only job is to convert user schedule text into strict JSON output.",
      parts: [
        { type: "text", text: buildSchedulePrompt(trimmedText, timezone) },
      ],
    } as Record<string, unknown>);

    const promptData = promptResult as {
      data?: {
        parts?: Array<{
          type?: string;
          text?: string;
          ignored?: boolean;
        }>;
      };
      error?: unknown;
    };

    if (promptData.error || !promptData.data) {
      throw promptData.error ?? new Error("Failed to parse schedule");
    }

    const responseText = collectResponseText(promptData.data.parts ?? []);
    if (!responseText) {
      throw new Error("Schedule parser returned an empty response");
    }

    return parseSchedulePayload(responseText);
  } finally {
    if (sessionId) {
      try {
        await sessionClient.delete({ sessionID: sessionId });
      } catch (deleteError) {
        logger.warn(
          `[ScheduleParser] Failed to delete temporary session: sessionId=${sessionId}`,
          deleteError,
        );
      }
    }
  }
}

/**
 * Regex-based fallback parser for common English schedule patterns.
 * Used when AI parsing is unavailable or as a quick pre-check.
 */
function parseCommonSchedule(text: string): ParsedTaskSchedule {
  const lower = text.toLowerCase().trim();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const everyMinutesMatch = lower.match(
    /^every\s+([1-9]\d*)\s*(?:m|min|mins|minute|minutes)\b/,
  );
  if (everyMinutesMatch) {
    const mins = Number.parseInt(everyMinutesMatch[1], 10);
    if (Number.isFinite(mins) && mins > 0) {
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

  return null as unknown as ParsedTaskSchedule;
}

/**
 * Synchronous regex-based parser exposed for backward compatibility.
 * Returns null when the input cannot be matched by simple patterns.
 */
export function parseScheduleRegex(text: string): ParsedTaskSchedule | null {
  return parseCommonSchedule(text);
}

/**
 * Primary entry point. Tries AI parsing first; falls back to regex
 * for simple English patterns if AI is unavailable.
 */
export async function parseSchedule(
  deps: ScheduleParserDeps,
  scheduleText: string,
  directory: string,
): Promise<ParsedTaskSchedule> {
  try {
    return await parseScheduleWithAI(deps, scheduleText, directory);
  } catch (error) {
    deps.logger.warn(
      `[ScheduleParser] AI parsing failed, trying regex fallback: ${error instanceof Error ? error.message : String(error)}`,
    );

    const regexResult = parseScheduleRegex(scheduleText);
    if (regexResult) {
      return regexResult;
    }

    throw error;
  }
}
