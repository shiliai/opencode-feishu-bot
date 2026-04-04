import "dotenv/config";

async function main(): Promise<void> {
  console.log("opencode-feishu-bridge starting...");
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
