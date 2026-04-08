import { inspect } from "node:util";
import { getConfig } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CreateLoggerOptions {
  getLevel?: () => string | undefined;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
  now?: () => Date;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function normalizeLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return "info";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized in LOG_LEVELS) {
    return normalized as LogLevel;
  }

  return "info";
}

function formatPrefix(level: LogLevel, now: Date): string {
  return `[${now.toISOString()}] [${level.toUpperCase()}]`;
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }

  if (typeof arg === "string") {
    return arg;
  }

  return inspect(arg, {
    depth: null,
    colors: false,
    sorted: true,
  });
}

function resolveConfiguredLogLevel(
  getLevel?: () => string | undefined,
): LogLevel {
  try {
    return normalizeLogLevel(getLevel?.() ?? getConfig().logLevel);
  } catch {
    return normalizeLogLevel(process.env.LOG_LEVEL);
  }
}

function shouldLog(level: LogLevel, configuredLevel: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[configuredLevel];
}

function writeLog(
  stream: Pick<NodeJS.WritableStream, "write">,
  level: LogLevel,
  args: unknown[],
  now: Date,
): void {
  const formattedArgs = args.map((arg) => formatArg(arg));
  const prefix = formatPrefix(level, now);
  const line =
    formattedArgs.length > 0 ? `${prefix} ${formattedArgs.join(" ")}` : prefix;
  stream.write(`${line}\n`);
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());

  return {
    debug: (...args: unknown[]): void => {
      const configuredLevel = resolveConfiguredLogLevel(options.getLevel);
      if (!shouldLog("debug", configuredLevel)) {
        return;
      }

      writeLog(stdout, "debug", args, now());
    },
    info: (...args: unknown[]): void => {
      const configuredLevel = resolveConfiguredLogLevel(options.getLevel);
      if (!shouldLog("info", configuredLevel)) {
        return;
      }

      writeLog(stdout, "info", args, now());
    },
    warn: (...args: unknown[]): void => {
      const configuredLevel = resolveConfiguredLogLevel(options.getLevel);
      if (!shouldLog("warn", configuredLevel)) {
        return;
      }

      writeLog(stderr, "warn", args, now());
    },
    error: (...args: unknown[]): void => {
      const configuredLevel = resolveConfiguredLogLevel(options.getLevel);
      if (!shouldLog("error", configuredLevel)) {
        return;
      }

      writeLog(stderr, "error", args, now());
    },
  };
}

export const logger = createLogger({
  getLevel: () => getConfig().logLevel,
});
