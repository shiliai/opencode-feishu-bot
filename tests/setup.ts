const TEST_ENV_DEFAULTS: Record<string, string> = {
  FEISHU_APP_ID: "test-feishu-app-id",
  FEISHU_APP_SECRET: "test-feishu-app-secret",
  FEISHU_BOT_OPEN_ID: "bot-open-id-1",
  FEISHU_CONNECTION_TYPE: "ws",
  OPENCODE_API_BASE_URL: "http://localhost:19999",
  SERVICE_HOST: "127.0.0.1",
  SERVICE_PORT: "3000",
  LOG_LEVEL: "error",
};

for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
