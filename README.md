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
- `FEISHU_EVENT_DEDUP_PERSIST_PATH` — defaults to `.data/event-dedup.json` for restart-safe dedup state
- `THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS`
- `THROTTLE_STATUS_CARD_PATCH_RETRY_DELAY_MS`
- `THROTTLE_STATUS_CARD_PATCH_MAX_ATTEMPTS`
- `CONTROL_CATALOG_MODEL_STATE_PATH` — defaults to `${HOME}/.local/state/opencode/model.json` for favorites/recent enrichment ordering (when overriding, use an absolute path like `/home/your-user/.local/state/opencode/model.json`)

Copy `.env.example` and fill in the values that apply to your environment.

## Production boot

Build and run as a single process:

```bash
npm install
npm run build
npm start
```

The service exposes `/healthz` on the same HTTP server used for Feishu card callbacks. In `ws` mode, outbound connectivity is still required so the WebSocket client can connect to Feishu.

## Supported chat commands

The bridge currently supports these slash commands in Feishu chat:

| Command         | Usage                  | What it does                                                      |
| --------------- | ---------------------- | ----------------------------------------------------------------- |
| `/help`         | `/help`                | Shows the command help card                                       |
| `/new`          | `/new`                 | Creates a new OpenCode session and switches to it                 |
| `/sessions`     | `/sessions`            | Lists available/recent sessions                                   |
| `/session`      | `/session`             | Opens a session picker card                                       |
| `/session [id]` | `/session ses_xxx`     | Switches current session to the given id                          |
| `/model`        | `/model`               | Opens model picker card (shows currently available model entries) |
| `/model [name]` | `/model openai/gpt-4o` | Sets current model to `[name]`                                    |
| `/agent`        | `/agent`               | Opens agent picker card (shows currently available agent entries) |
| `/agent [name]` | `/agent build`         | Sets current agent to `[name]`                                    |
| `/status`       | `/status`              | Shows current Session / Model / Agent / State                     |
| `/abort`        | `/abort`               | Aborts the current session and clears busy state                  |

### Notes on command behavior

- `State` in `/status` is from the interaction manager (`idle` or `busy`).
- If no model/agent has been set yet, `/status` shows `Model: none` / `Agent: none`.
- During busy periods, control commands such as `/status`, `/help`, and `/abort` are still allowed.
- In group chats, normal prompt messages require `@bot` mention behavior configured by Feishu permissions and bridge settings.

## Manual test checklist (recommended order)

Use this sequence for one-by-one validation:

1. `/help` — verify command list card is rendered.
2. `/status` — verify session/model/agent/state fields are shown.
3. `/new` — verify a new session id is returned.
4. `/status` — verify session field changed.
5. `/model` — verify the model picker card renders real catalog options.
6. Click a model picker button, then `/status` — verify model field updates from picker selection.
7. `/model openai/gpt-4o` then `/status` — verify direct model selection still works.
8. `/agent` — verify the agent picker card renders real catalog options.
9. Click an agent picker button, then `/status` — verify agent field updates from picker selection.
10. `/agent <name>` then `/status` — verify direct agent selection still works.
11. `/sessions` — verify session list card appears.
12. `/session <id>` then `/status` — verify active session switches.
13. Send a normal prompt — verify OpenCode reply returns.
14. `/abort` — verify abort success and busy state clears.

## Container image

Build and run the included container:

```bash
docker build -t opencode-feishu-bridge .
docker run --env-file .env -p 3000:3000 opencode-feishu-bridge
```
