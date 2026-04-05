import { startFeishuApp } from "./app/start-feishu-app.js";

startFeishuApp().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
