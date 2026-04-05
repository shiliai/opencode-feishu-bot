# OpenCode Feishu Bridge

Feishu (Lark) bridge service that receives chat events, sends prompts to OpenCode, and returns status cards plus final replies.

## Local mock mode

Use the local smoke check to verify the service boots, exposes `/healthz`, and shuts down cleanly without talking to live Feishu or OpenCode services.

```bash
npm install
npm run smoke:local
```

## Required environment

Required:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

Common optional settings:

- `FEISHU_BOT_OPEN_ID` — enables exact `@bot` matching in group chats
- `FEISHU_CONNECTION_TYPE` — `ws` or `webhook` (default `ws`)
- `FEISHU_CARD_CALLBACK_URL`
- `FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN`
- `FEISHU_CARD_CALLBACK_ENCRYPT_KEY`
- `OPENCODE_API_BASE_URL` — defaults to `http://localhost:4096`
- `OPENCODE_API_KEY`
- `SERVICE_HOST` — defaults to `0.0.0.0`
- `SERVICE_PORT` — defaults to `3000`
- `LOG_LEVEL` — defaults to `info`
- `FEISHU_EVENT_DEDUP_TTL_MS`
- `THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS`
- `THROTTLE_STATUS_CARD_PATCH_RETRY_DELAY_MS`
- `THROTTLE_STATUS_CARD_PATCH_MAX_ATTEMPTS`

Copy `.env.example` and fill in the values that apply to your environment.

## Production boot

Build and run as a single process:

```bash
npm install
npm run build
npm start
```

The service exposes `/healthz` on the same HTTP server used for Feishu card callbacks. In `ws` mode, outbound connectivity is still required so the WebSocket client can connect to Feishu.

## Container image

Build and run the included container:

```bash
docker build -t opencode-feishu-bridge .
docker run --env-file .env -p 3000:3000 opencode-feishu-bridge
```
