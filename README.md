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
- `FEISHU_CARD_CALLBACK_URL` — optional callback endpoint for Feishu card actions
- `FEISHU_CARD_CALLBACK_VERIFICATION_TOKEN` — defaults to empty when callback is disabled; required when `FEISHU_CONNECTION_TYPE=webhook` or callback URL is configured
- `FEISHU_CARD_CALLBACK_ENCRYPT_KEY` — defaults to empty (plaintext payload mode); set this when Feishu encrypted callback payloads are enabled
- `OPENCODE_API_BASE_URL` — defaults to `http://localhost:4096`
- `OPENCODE_API_KEY`
- `OPENCODE_WORKDIR` — optional absolute path; when set, `/projects` scans this directory from the bridge process and lists its immediate subdirectories as candidate projects (auto-discovery). This path must be accessible to the bridge process and must also be a valid path for the OpenCode server when passed to `session.create`.
- `ASSISTANT_NAME` — customizable name shown in card titles (default `"OpenCode"`)
- `SERVICE_HOST` — defaults to `0.0.0.0`
- `SERVICE_PORT` — defaults to `3000`
- `LOG_LEVEL` — defaults to `info`
- `FEISHU_EVENT_DEDUP_TTL_MS` — defaults to `300000` (5 minutes)
- `FEISHU_EVENT_DEDUP_PERSIST_PATH` — defaults to `.data/event-dedup.json` for restart-safe dedup state
- `THROTTLE_STATUS_CARD_UPDATE_INTERVAL_MS`
- `THROTTLE_STATUS_CARD_PATCH_RETRY_DELAY_MS`
- `THROTTLE_STATUS_CARD_PATCH_MAX_ATTEMPTS`
- `CONTROL_CATALOG_CACHE_TTL_MS` — defaults to `600000` (10 minutes)
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

| Command          | Usage                  | What it does                                                      |
| ---------------- | ---------------------- | ----------------------------------------------------------------- |
| `/help`          | `/help`                | Shows the command help card                                       |
| `/new`           | `/new`                 | Opens a confirmation card before creating and switching session   |
| `/projects`      | `/projects`            | Opens project picker card (or text list when card callbacks off)  |
| `/projects [id]` | `/projects proj_xxx`   | Sets current project to `[id]` and clears active session          |
| `/sessions`      | `/sessions`            | Lists available/recent sessions                                   |
| `/session`       | `/session`             | Opens a session picker card                                       |
| `/session [id]`  | `/session ses_xxx`     | Switches current session to the given id                          |
| `/history`       | `/history`             | Shows recent chat message history (default 10)                    |
| `/history [n]`   | `/history 20`          | Shows up to `n` recent chat messages (max 50)                     |
| `/model`         | `/model`               | Opens model picker card (shows currently available model entries) |
| `/model [name]`  | `/model openai/gpt-4o` | Sets current model to `[name]`                                    |
| `/agent`         | `/agent`               | Opens agent picker card (shows currently available agent entries) |
| `/agent [name]`  | `/agent build`         | Sets current agent to `[name]`                                    |
| `/status`        | `/status`              | Shows Session / Model / Agent / Context / State                   |
| `/version`       | `/version`             | Shows bridge version                                              |
| `/abort`         | `/abort`               | Aborts the current session and clears busy state                  |

### Notes on command behavior

- `State` in `/status` is from the interaction manager (`idle` or `busy`).
- `Context` in `/status` shows the session's peak context token usage vs the model's context window when that limit is known (e.g. `151K/400K (38%)`). If the limit is unavailable, it shows `used/unknown` without a percentage.
- `/new` now requires explicit confirmation from the card button before a new session is created.
- When Feishu card callbacks are not configured, `/new` falls back to immediate session creation to avoid callback error `200340`.
- `/history` reads recent messages from the current chat and renders them as a history card.
- If no model/agent has been set yet, `/status` shows `Model: {ASSISTANT_NAME} default` / `Agent: {ASSISTANT_NAME} default` (configurable via `ASSISTANT_NAME` env var).
- When `OPENCODE_WORKDIR` is set, `/projects` scans immediate subdirectories of that path from the bridge process. Selecting a new directory triggers auto-discovery on the OpenCode server, so the same path must also be meaningful there if the bridge and OpenCode server run on different hosts.
- During busy periods, control commands such as `/status`, `/help`, and `/abort` are still allowed.
- In group chats, normal prompt messages require `@bot` mention behavior configured by Feishu permissions and bridge settings.

## Response UX highlights

- Streaming status card now includes extracted reasoning lane, tool usage hints, and compact footer metrics.
- Final replies are markdown-optimized for card/post readability (headings/tables/code blocks).
- Remote markdown image URLs are resolved to Feishu `img_xxx` keys when possible for better inline rendering.
- Image messages sent in Feishu chat are accepted and forwarded to the OpenCode session.

## Developer docs

- [OpenCode session state](docs/opencode-session-state.md) — session lifecycle, `/status` and `/abort` semantics, module responsibilities, and same-project multi-session concurrency caveats.

## Manual test checklist (recommended order)

Use this sequence for one-by-one validation:

1. `/help` — verify command list card is rendered.
2. `/status` — verify session/model/agent/state fields are shown.
3. `/new` — verify confirmation card appears.
4. Click "✅ Confirm" on `/new` card — verify a new session id is returned.
5. `/status` — verify session field changed.
6. `/history` — verify recent message history card appears.
7. `/history 20` — verify larger history fetch works (up to max 50).
8. `/model` — verify the model picker card renders real catalog options.
9. Click a model picker button, then `/status` — verify model field updates from picker selection.
10. `/model openai/gpt-4o` then `/status` — verify direct model selection still works.
11. `/agent` — verify the agent picker card renders real catalog options.
12. Click an agent picker button, then `/status` — verify agent field updates from picker selection.
13. `/agent <name>` then `/status` — verify direct agent selection still works.
14. `/sessions` — verify session list card appears.
15. `/session <id>` then `/status` — verify active session switches.
16. Send a normal prompt — verify OpenCode reply returns with enriched streaming card UX.
17. `/abort` — verify abort success and busy state clears.

## systemd user service

Install as a user-level systemd service (no root required):

```bash
npm run service:install
```

This auto-detects the Node.js binary path and installation directory, installs the unit file, and enables the service.

Common commands:

```bash
npm run service:status          # check status
npm run service:uninstall       # stop and remove service
journalctl --user -u opencode-feishu-bridge -f   # view logs
```

For services to persist after logout:

```bash
sudo loginctl enable-linger $USER
```

See `systemd/opencode-feishu-bridge.service` for the unit file template.

## Container image

Build and run the included container:

```bash
docker build -t opencode-feishu-bridge .
docker run --env-file .env -p 3000:3000 opencode-feishu-bridge
```
