# Feishu Bridge Git Hotspots

This document records the highest-churn files in this repository so architectural analysis can focus on the most unstable modules.

## Analysis history

Append a new entry each time this hotspot scan is refreshed so later investigations can compare against earlier baselines instead of replacing them.

| Date       | Trigger                                            | Snapshot summary                                                                                                                                                                                                                                                                                                                                                      | Follow-up use                                                                                 |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 2026-04-10 | Question-card callback stall and busy-state review | Churn is concentrated in `src/feishu/control-router.ts`, `src/feishu/response-pipeline.ts`, `src/feishu/handlers/prompt.ts`, `src/app/runtime-event-handlers.ts`, and `src/interaction/manager.ts`. The immediate bug lives in the question path, but the hotspot pattern points to a broader orchestration-boundary problem rather than an isolated callback defect. | Treat this scan as the baseline for the quick fix issue and the orchestration refactor issue. |

## Commands used

### Commit-frequency scan

```bash
git log --all --pretty=format: --name-only --diff-filter=ACRM | sort | uniq -c | sort -rn
```

### Recent line-churn scan

```bash
git log --numstat --pretty=format: -50 | awk 'NF==3 && $1 != "-" {add[$3]+=$1; del[$3]+=$2} END {for (f in add) printf "%6d+ %6d- %s\n", add[f], del[f], f}' | sort -t'+' -k1 -rn
```

### Recent-frequency scan

```bash
git log --since="2 weeks ago" --pretty=format: --name-only --diff-filter=ACRM | sort | uniq -c | sort -rn
```

---

## 1. Most frequently modified files (overall)

| Rank | File                                         | Commit count |
| ---- | -------------------------------------------- | -----------: |
| 1    | `src/feishu/control-router.ts`               |           24 |
| 2    | `tests/unit/control-commands.test.ts`        |           23 |
| 3    | `src/app/start-feishu-app.ts`                |           19 |
| 4    | `src/feishu/response-pipeline.ts`            |           17 |
| 5    | `tests/unit/control-selection-cards.test.ts` |           16 |
| 6    | `src/feishu/control-cards.ts`                |           12 |
| 7    | `src/config.ts`                              |           11 |
| 8    | `src/app/runtime-event-handlers.ts`          |           10 |
| 9    | `src/feishu/handlers/prompt.ts`              |            8 |
| 10   | `src/feishu/cards.ts`                        |            8 |
| 11   | `src/feishu/status-store.ts`                 |            7 |
| 12   | `src/feishu/control-catalog.ts`              |            6 |
| 13   | `src/summary/aggregator.ts`                  |            5 |
| 14   | `src/session/index.ts`                       |            5 |
| 15   | `src/interaction/manager.ts`                 |            5 |

---

## 2. Highest line churn in the last 50 commits

| Rank | File                                | Additions | Deletions |
| ---- | ----------------------------------- | --------: | --------: |
| 1    | `src/feishu/control-router.ts`      |      2712 |       251 |
| 2    | `src/feishu/response-pipeline.ts`   |      1505 |        78 |
| 3    | `src/summary/aggregator.ts`         |      1140 |        52 |
| 4    | `src/feishu/handlers/prompt.ts`     |       860 |       119 |
| 5    | `src/feishu/cards.ts`               |       683 |        67 |
| 6    | `src/feishu/control-cards.ts`       |       676 |       288 |
| 7    | `src/app/runtime-event-handlers.ts` |       671 |       104 |
| 8    | `src/settings/manager.ts`           |       551 |        12 |
| 9    | `src/interaction/manager.ts`        |       518 |        58 |
| 10   | `src/app/start-feishu-app.ts`       |       418 |        51 |

Notes:

- `package-lock.json` has the highest raw additions but is not architecturally meaningful.
- Tests were excluded from the table above unless directly useful for code hotspot interpretation.

---

## 3. Most active files in the last two weeks

| Rank | File                                         | Recent touches |
| ---- | -------------------------------------------- | -------------: |
| 1    | `tests/unit/control-commands.test.ts`        |             12 |
| 2    | `src/feishu/control-router.ts`               |             12 |
| 3    | `src/feishu/response-pipeline.ts`            |             11 |
| 4    | `src/app/start-feishu-app.ts`                |              9 |
| 5    | `tests/unit/response-pipeline.test.ts`       |              9 |
| 6    | `tests/unit/control-selection-cards.test.ts` |              8 |
| 7    | `src/feishu/handlers/prompt.ts`              |              7 |
| 8    | `src/config.ts`                              |              7 |
| 9    | `src/app/runtime-event-handlers.ts`          |              7 |
| 10   | `src/feishu/control-cards.ts`                |              6 |

---

## 4. What this implies

The churn pattern is concentrated around one architectural seam:

- **control flow / control UI**
- **runtime event orchestration**
- **prompt ingress**
- **response pipeline / status finalization**
- **interaction gating**

This is exactly the area where the current bug lives.

### Highest-risk modules

#### 1. `src/feishu/control-router.ts`

- highest overall commit frequency in production code
- highest recent line churn
- mixes slash commands, card actions, `/status`, `/abort`, project/model/agent control, and task operations

#### 2. `src/feishu/response-pipeline.ts`

- owns turn lifecycle, event subscription, status cards, finalization, follow-up handling
- second-highest churn among runtime modules

#### 3. `src/feishu/handlers/prompt.ts`

- owns prompt admission, busy guard interaction, session resolution, async dispatch behavior

#### 4. `src/app/runtime-event-handlers.ts`

- main ingress router for message and callback behavior
- coordinates queues, prompt dispatch, guided replies, and control handlers

#### 5. `src/interaction/manager.ts`

- lower raw commit count than the modules above, but central to all local busy/interaction semantics

---

## 5. Recommended use of this hotspot data

When analyzing or redesigning the bridge, start with these modules in this order:

1. `src/feishu/control-router.ts`
2. `src/feishu/response-pipeline.ts`
3. `src/feishu/handlers/prompt.ts`
4. `src/app/runtime-event-handlers.ts`
5. `src/interaction/manager.ts`

If a proposed fix touches several of these at once, that is a signal the current design boundary is probably wrong rather than just under-tested.
