import "dotenv/config";

export type ConnectionType = "ws" | "webhook";

export interface OpenCodeConfig {
  apiUrl: string;
  apiKey: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface CardCallbackConfig {
  callbackUrl: string;
  verificationToken: string;
  encryptKey: string;
}

export interface ThrottleConfig {
  statusCardUpdateIntervalMs: number;
}

export interface ServiceConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  opencode: OpenCodeConfig;
  feishu: FeishuConfig;
  connectionType: ConnectionType;
  cardCallback: CardCallbackConfig | null;
  throttle: ThrottleConfig;
  service: ServiceConfig;
  logLevel: string;
}

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

  let cardCallback: CardCallbackConfig | null = null;
  if (connectionType === "webhook") {
    const callbackUrl = getEnvVar("FEISHU_CARD_CALLBACK_URL");
    const verificationToken = getEnvVar(
      "FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN",
    );
    cardCallback = {
      callbackUrl,
      verificationToken,
      encryptKey: getEnvVar("FEISHU_CARD_CALLBACK_ENCRYPT_KEY", false),
    };
  }

  return {
    opencode: {
      apiUrl: getEnvVar("OPENCODE_API_BASE_URL", false) || "http://localhost:4096",
      apiKey: getEnvVar("OPENCODE_API_KEY", false),
    },
    feishu: {
      appId: getEnvVar("FEISHU_APP_ID"),
      appSecret: getEnvVar("FEISHU_APP_SECRET"),
    },
    connectionType,
    cardCallback,
    throttle: {
      statusCardUpdateIntervalMs: getOptionalPositiveIntEnvVar(
        "THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS",
        2_000,
      ),
    },
    service: {
      port: getOptionalPositiveIntEnvVar("SERVICE_PORT", 3000),
      host: getEnvVar("SERVICE_HOST", false) || "0.0.0.0",
    },
    logLevel: getEnvVar("LOG_LEVEL", false) || "info",
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
