import "dotenv/config";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ConnectionType = "ws" | "webhook";

export interface OpenCodeConfig {
  apiUrl: string;
  apiKey: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  botOpenId: string;
  eventDedupTtlMs: number;
  eventDedupPersistPath: string;
}

export interface CardCallbackConfig {
  callbackUrl: string;
  verificationToken: string;
  encryptKey: string;
}

export interface ThrottleConfig {
  statusCardUpdateIntervalMs: number;
  statusCardPatchRetryDelayMs: number;
  statusCardPatchMaxAttempts: number;
}

export interface StatusCardConfig {
  recentUpdatesCount: number;
  recreateInterval: number;
}

export interface ControlCatalogConfig {
  cacheTtlMs: number;
  modelStatePath: string;
}

export interface ServiceConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  opencode: OpenCodeConfig;
  workdir: string | null;
  feishu: FeishuConfig;
  connectionType: ConnectionType;
  cardCallback: CardCallbackConfig | null;
  throttle: ThrottleConfig;
  statusCard: StatusCardConfig;
  controlCatalog: ControlCatalogConfig;
  service: ServiceConfig;
  logLevel: string;
  assistantName: string;
  scheduledTaskLimit: number;
  scheduledTaskPersistPath: string;
}

export const DEFAULT_CONTROL_CATALOG_CACHE_TTL_MS = 600_000;
export const DEFAULT_CONTROL_CATALOG_MODEL_STATE_PATH = join(
  homedir(),
  ".local",
  "state",
  "opencode",
  "model.json",
);
export const DEFAULT_FEISHU_EVENT_DEDUP_TTL_MS = 300_000;
export const DEFAULT_FEISHU_EVENT_DEDUP_PERSIST_PATH = join(
  process.cwd(),
  ".data",
  "event-dedup.json",
);
export const DEFAULT_STATUS_CARD_RECENT_UPDATES_COUNT = 5;
export const DEFAULT_STATUS_CARD_RECREATE_INTERVAL = 5;
export const DEFAULT_FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN = "";
export const DEFAULT_FEISHU_CARD_CALLBACK_ENCRYPT_KEY = "";

export const DEFAULT_ASSISTANT_NAME = "OpenCode";
export const DEFAULT_SCHEDULED_TASK_LIMIT = 10;
export const DEFAULT_SCHEDULED_TASK_PERSIST_PATH = join(
  process.cwd(),
  ".data",
  "scheduled-tasks.json",
);

export class ConfigValidationError extends Error {
  constructor(
    public readonly missingVar: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new ConfigValidationError(
      key,
      `Missing required environment variable: ${key}. Set it in your .env file or environment.`,
    );
  }
  return value ?? "";
}

function getOptionalPositiveIntEnvVar(
  key: string,
  defaultValue: number,
): number {
  const raw = getEnvVar(key, false);
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

function getOptionalNonNegativeIntEnvVar(
  key: string,
  defaultValue: number,
): number {
  const raw = getEnvVar(key, false);
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function parseConnectionType(raw: string): ConnectionType {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "ws" || normalized === "webhook") {
    return normalized;
  }
  throw new ConfigValidationError(
    "FEISHU_CONNECTION_TYPE",
    `Invalid FEISHU_CONNECTION_TYPE "${raw}". Must be "ws" or "webhook".`,
  );
}

export function loadConfig(): AppConfig {
  const connectionType = parseConnectionType(
    getEnvVar("FEISHU_CONNECTION_TYPE", false) || "ws",
  );
  const workdirRaw = getEnvVar("OPENCODE_WORKDIR", false);
  if (workdirRaw && !isAbsolute(workdirRaw)) {
    throw new ConfigValidationError(
      "OPENCODE_WORKDIR",
      "OPENCODE_WORKDIR must be an absolute path.",
    );
  }
  const workdir = workdirRaw ? resolve(workdirRaw) : null;

  const callbackUrl = getEnvVar("FEISHU_CARD_CALLBACK_URL", false);
  const verificationToken =
    getEnvVar("FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN", false) ||
    DEFAULT_FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN;
  const hasCardCallbackConfig = Boolean(callbackUrl || verificationToken);

  let cardCallback: CardCallbackConfig | null = null;
  if (connectionType === "webhook" || hasCardCallbackConfig) {
    if (!callbackUrl) {
      throw new ConfigValidationError(
        "FEISHU_CARD_CALLBACK_URL",
        "Missing required environment variable: FEISHU_CARD_CALLBACK_URL. Set it in your .env file or environment.",
      );
    }
    if (!verificationToken) {
      throw new ConfigValidationError(
        "FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN",
        "Missing required environment variable: FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN. Set it in your .env file or environment.",
      );
    }
    cardCallback = {
      callbackUrl,
      verificationToken,
      encryptKey:
        getEnvVar("FEISHU_CARD_CALLBACK_ENCRYPT_KEY", false) ||
        DEFAULT_FEISHU_CARD_CALLBACK_ENCRYPT_KEY,
    };
  }

  return {
    opencode: {
      apiUrl:
        getEnvVar("OPENCODE_API_BASE_URL", false) || "http://localhost:4096",
      apiKey: getEnvVar("OPENCODE_API_KEY", false),
    },
    workdir,
    feishu: {
      appId: getEnvVar("FEISHU_APP_ID"),
      appSecret: getEnvVar("FEISHU_APP_SECRET"),
      botOpenId: getEnvVar("FEISHU_BOT_OPEN_ID", false),
      eventDedupTtlMs: getOptionalPositiveIntEnvVar(
        "FEISHU_EVENT_DEDUP_TTL_MS",
        DEFAULT_FEISHU_EVENT_DEDUP_TTL_MS,
      ),
      eventDedupPersistPath:
        getEnvVar("FEISHU_EVENT_DEDUP_PERSIST_PATH", false) ||
        DEFAULT_FEISHU_EVENT_DEDUP_PERSIST_PATH,
    },
    connectionType,
    cardCallback,
    throttle: {
      statusCardUpdateIntervalMs: getOptionalPositiveIntEnvVar(
        "THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS",
        2_000,
      ),
      statusCardPatchRetryDelayMs: getOptionalPositiveIntEnvVar(
        "THROTTLE_STATUS_CARD_PATCH_RETRY_DELAY_MS",
        500,
      ),
      statusCardPatchMaxAttempts: getOptionalPositiveIntEnvVar(
        "THROTTLE_STATUS_CARD_PATCH_MAX_ATTEMPTS",
        3,
      ),
    },
    statusCard: {
      recentUpdatesCount: getOptionalNonNegativeIntEnvVar(
        "STATUS_CARD_RECENT_UPDATES_COUNT",
        DEFAULT_STATUS_CARD_RECENT_UPDATES_COUNT,
      ),
      recreateInterval: getOptionalNonNegativeIntEnvVar(
        "STATUS_CARD_RECREATE_INTERVAL",
        DEFAULT_STATUS_CARD_RECREATE_INTERVAL,
      ),
    },
    controlCatalog: {
      cacheTtlMs: getOptionalPositiveIntEnvVar(
        "CONTROL_CATALOG_CACHE_TTL_MS",
        DEFAULT_CONTROL_CATALOG_CACHE_TTL_MS,
      ),
      modelStatePath:
        getEnvVar("CONTROL_CATALOG_MODEL_STATE_PATH", false) ||
        DEFAULT_CONTROL_CATALOG_MODEL_STATE_PATH,
    },
    service: {
      port: getOptionalPositiveIntEnvVar("SERVICE_PORT", 3000),
      host: getEnvVar("SERVICE_HOST", false) || "0.0.0.0",
    },
    logLevel: getEnvVar("LOG_LEVEL", false) || "info",
    assistantName: getEnvVar("ASSISTANT_NAME", false) || DEFAULT_ASSISTANT_NAME,
    scheduledTaskLimit: getOptionalPositiveIntEnvVar(
      "SCHEDULED_TASK_LIMIT",
      DEFAULT_SCHEDULED_TASK_LIMIT,
    ),
    scheduledTaskPersistPath:
      getEnvVar("SCHEDULED_TASK_PERSIST_PATH", false) ||
      DEFAULT_SCHEDULED_TASK_PERSIST_PATH,
  };
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
