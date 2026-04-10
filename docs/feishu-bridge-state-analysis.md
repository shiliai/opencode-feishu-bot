# Feishu Bridge State Analysis

This document analyzes why the current Feishu bridge can get stuck when OpenCode asks a question or permission and the user responds from a Feishu card.

It builds on these reference docs:

- `docs/opencode-server-api-reference.md`
- `docs/opencode-session-state-reference.md`
- `docs/opencode-web-client-interaction.md`
- `docs/feishu-bridge-git-hotspots.md`
- existing `docs/opencode-session-state.md`

## Bottom line

The observed no-op is real and deterministic in the **question** path: the Feishu card click is treated as stale before the bridge ever calls OpenCode’s question reply API.

The larger issue is architectural: the bridge models question/permission waits as local UI state on top of a **single-current-session** event pipeline, while OpenCode models them as first-class pending resources that must survive busy state, reconnects, and concurrent activity.

### Recommendation

- **Immediate action:** ship a narrow surgical fix for the question callback identity/contract bug.
- **Follow-up action:** refactor the orchestration subsystem (event subscription, pending-request store, busy/blocked state ownership).
- **Do not** rewrite the whole repository.

### Effort estimate

- minimal viable fix: **1–2 days**
- recommended subsystem redesign: **3+ days**

---

## 1. Root-cause model

### 1.1 What OpenCode expects

From the reference server and browser app:

- a session stays **`busy`** while waiting for a question or permission reply
- questions and permissions are separate pending resources
- those pending resources are resumed only by:
  - `POST /question/:requestID/reply`
  - `POST /question/:requestID/reject`
  - `POST /permission/:requestID/reply`
- a correct client combines:
  - runtime session status
  - pending question list
  - pending permission list
  - live event stream
- the browser client clears pending question/permission UI only after streamed follow-up events:
  - `question.replied`
  - `question.rejected`
  - `permission.replied`

### 1.2 What the bridge does today

The bridge splits state across several mismatched scopes:

- **per-chat local busy / interaction state**
- **per-session turn state**
- **global question manager**
- **global current-session summary aggregator**
- **single active OpenCode event subscriber**

That means the bridge can know “something is busy” without reliably knowing **which exact OpenCode request** is pending, who owns it, whether it was already answered elsewhere, or whether the event stream missed the ask/reply transition.

### 1.3 Direct no-op bug in the question path

This is the immediate cause of the observed bug.

#### Current behavior

- `src/feishu/cards.ts` builds question card actions with `value.messageId = associatedMessageId`
- the question handler later treats the **rendered card message id** as the active message identity
- when the callback arrives, `src/feishu/handlers/question.ts` checks the callback payload against the active rendered card id

So the actual flow becomes:

1. the source/original Feishu message id is embedded into the button payload
2. Feishu renders a new card message with a different `message_id`
3. the user clicks the card
4. callback handling compares the embedded source id against the active card message id
5. the callback is dropped as stale
6. `question.reply()` is never sent to OpenCode
7. OpenCode remains waiting
8. bridge status remains busy

That matches the user-observed symptom exactly: **Feishu click appears to work locally, but OpenCode web still waits for user confirmation**.

### 1.4 Why tests did not catch this

Current question callback tests and fixtures model an impossible happy path: they fabricate the callback payload as if the embedded `messageId` and the rendered card message id were the same thing.

That means the tests validate the bridge’s local assumption rather than the real Feishu callback contract.

### 1.5 Additional question-path contract drift

Even if the stale-click bug is fixed, the question subsystem still diverges from OpenCode’s contract:

- answers are formatted like rendered markdown summary text instead of raw selected labels/custom values
- replies are effectively handled question-by-question, while OpenCode question requests are batch-oriented
- the bridge’s local question manager models a linear poll flow, not OpenCode’s request-centric contract

### 1.6 Permission path status

The permission path does **not** appear to suffer from the same deterministic card-id mismatch, but it still shares the systemic problems below:

- no bootstrap from pending permission list
- no authoritative reconciliation from `permission.replied`
- render failure can leave OpenCode waiting
- event subscription ownership is brittle

---

## 2. Ranked weak points

This ranking considers both architectural impact and git hotspot evidence from `docs/feishu-bridge-git-hotspots.md`.

### 2.1 `src/feishu/handlers/question.ts` + `src/question/manager.ts` — critical

Why weak:

- callback identity is wrong
- question flow is global, not request-scoped
- answer contract drifts from OpenCode
- custom/guided replies are not strongly chat/session scoped
- current test model hides the real production payload shape

### 2.2 `src/feishu/response-pipeline.ts` — critical

Why weak:

- owns too much: turn lifecycle, status cards, finalization, event subscription, aggregator coupling
- `handleAggregatorCleared()` clears **all** active local turn state
- heavily churned module, indicating unstable ownership boundaries

Hotspot evidence:

- 17 overall touches
- 1505 additions / 78 deletions in the last 50 commits

### 2.3 `src/summary/aggregator.ts` + `src/app/runtime-summary-aggregator.ts` — critical

Why weak:

- single `currentSessionId`
- changing sessions clears previous local parsed state
- question/permission render paths start local interaction before guaranteed successful delivery
- `onCleared` clears all interaction state process-wide

### 2.4 `src/opencode/events.ts` — high

Why weak:

- one active directory/callback ownership model
- mismatched with OpenCode browser client, which treats event ingest as a long-lived global stream reduced into store state
- vulnerable to missed early `question.asked` / `permission.asked` events

### 2.5 `src/feishu/handlers/prompt.ts` — high

Why weak:

- prompt dispatch and event-subscription readiness are not tightly coupled
- a prompt can begin before the bridge is safely listening for the first ask event
- combines too many responsibilities: admission, session resolution, async scheduling, remote busy checks

Hotspot evidence:

- 8 overall touches
- 860 additions / 119 deletions in the last 50 commits

### 2.6 `src/app/runtime-event-handlers.ts` — high

Why weak:

- acts as the hidden runtime router for messages, callbacks, guided replies, and prompt dispatch
- coordinates too many flows through one ingress surface
- highly sensitive to ordering assumptions

Hotspot evidence:

- 10 overall touches
- 671 additions / 104 deletions in the last 50 commits

### 2.7 `src/interaction/manager.ts` — medium/high

Why weak:

- central to local busy/interaction gating
- but state semantics are too coarse: it knows “busy” without preserving authoritative pending-request identity
- cleanup depends on multiple external callers doing the right thing

### 2.8 `src/feishu/control-router.ts` — medium but strategically important

It is not the direct cause of the question no-op, but it is the highest-churn module and a strong indicator that current state ownership is spread across too many places.

Hotspot evidence:

- highest production-code commit frequency
- 2712 additions / 251 deletions in the last 50 commits

---

## 3. Minimal viable fix plan

This is the smallest credible path to stop the immediate user-visible failure.

### 3.1 Fix question callback identity

- include authoritative `requestId` in the card action payload
- use Feishu `open_message_id` / rendered card id only for stale-card protection
- stop keying question resolution off the embedded source message id

### 3.2 Align question reply payload with OpenCode

- send raw selected option labels and/or custom text
- preserve question order
- reply once per OpenCode request, not once per UI click step

### 3.3 Guarantee event-subscription readiness before prompt execution

- ensure the bridge is already listening before `session.prompt()` starts
- otherwise early `question.asked` / `permission.asked` events remain lossy

### 3.4 Reconcile with reply events

Add explicit handling for:

- `question.replied`
- `question.rejected`
- `permission.replied`

Local click success should not be treated as final state.

### 3.5 Make render failure non-silent

If card rendering fails:

- fall back to a text interaction path, **or**
- explicitly reject/abort instead of leaving OpenCode waiting invisibly

### 3.6 Fix the tests first-class

- update question callback fixtures to reflect real Feishu payload shapes
- add regression tests for the stale-click bug
- add contract tests for batch question replies and multi-select behavior

---

## 4. Recommended redesign plan

The minimal patch is necessary, but it should not be the final state.

### 4.1 Replace singleton local managers with a request-centric store

Track pending human-in-the-loop state by:

- `requestID`
- `sessionID`
- `directory`
- `chatId`
- rendered card message id

Feishu message ids should be treated as UI correlation only, not as the authoritative identity of the pending OpenCode resource.

### 4.2 Introduce a long-lived event supervisor

Mirror the OpenCode browser model:

- one durable event ingest layer
- reduce events into state
- do not let per-turn response pipeline ownership control the only valid subscription

### 4.3 Bootstrap pending state on reconnect/restart

At minimum, load:

- `session.status`
- `question.list`
- `permission.list`

before accepting new work for that session/directory.

### 4.4 Separate state dimensions cleanly

Represent at least:

- runtime execution status (`idle`, `busy`, `retry`)
- blocked-on-question(requestID)
- blocked-on-permission(requestID)
- render/delivery state of the Feishu interaction

`busy` and `blocked` are related, but they are not the same thing.

### 4.5 Demote the response pipeline to rendering

The response pipeline should react to authoritative store changes and render status/final cards.

It should **not** be the exclusive owner of:

- session event subscription
- request lifecycle truth
- cross-turn cleanup semantics

### 4.6 Preserve what still works

Do **not** rewrite the whole repository. Reuse:

- Feishu transport
- renderer/card infrastructure where possible
- control-card UX
- session resolution primitives

The broken part is the orchestration/state boundary.

---

## 5. Migration strategy

### Phase 1 — stop the current bleed

Ship the narrow fix for:

- question callback identity
- question reply payload shape
- question request batching
- regression tests

### Phase 2 — add a new pending-request store beside existing managers

Feed it from current event handling, but do not immediately delete legacy code.

### Phase 3 — move clearing logic to server-confirmed events

Switch UI cleanup from optimistic local assumptions to:

- `question.replied`
- `question.rejected`
- `permission.replied`

### Phase 4 — replace single-owner event subscription

Introduce the event supervisor/global reducer model and remove `currentSessionId` / single-active-directory assumptions.

### Phase 5 — remove legacy global managers

Retire:

- global question flow assumptions
- process-wide current-session parser ownership
- turn cleanup paths that blast unrelated session/chat state

---

## 6. Invariants to enforce

These should become explicit code invariants and test assertions.

1. Every pending OpenCode question/permission is keyed by **`requestID`**.
2. A Feishu card callback must be self-describing enough to resolve the OpenCode request without consulting mutable global singleton question state.
3. One pending question request gets exactly one terminal outcome: reply or reject.
4. Local UI success is not authoritative; server-confirmed reply/reject events are.
5. Starting a new turn must never clear unrelated active turn state.
6. Missing render or delivery must end in fallback or explicit termination, never silent waiting.
7. Busy state and blocked-by-user-input state are separate dimensions.
8. Reconnect/restart must bootstrap pending request state before the bridge resumes ordinary prompt handling.

---

## 7. Test plan

### 7.1 Contract tests

- verify real Feishu callback payload shape for question cards
- verify card action payload includes `requestId`
- verify stale-card protection is based on rendered card identity, not source message identity

### 7.2 Unit tests

- question card click reaches `question.reply()` with the real payload shape
- question reply sends raw labels/custom text, not rendered markdown text
- multi-question request produces one correctly ordered batched reply
- multi-select question does not reply after the first click
- render failure triggers fallback or explicit termination
- duplicate/stale callbacks remain idempotent

### 7.3 Integration tests

- prompt -> `question.asked` -> Feishu card click -> `question.reply` -> `question.replied` -> `session.idle`
- same for permission path
- early ask event immediately after prompt is still captured
- reconnect/bootstrap reloads pending requests correctly
- starting another turn does not clear unrelated active turn state

### 7.4 Regression tests for the current escape

- replace the current fake question callback fixture with a real one
- make the old code fail on that fixture
- confirm the fixed code passes on that same payload

---

## 8. Refactor vs rewrite decision

### Recommended decision

**Refactor overall; rewrite the orchestration/state subsystem.**

That means:

- **yes** to a targeted subsystem rewrite of pending-request + event + turn-state ownership
- **no** to a full repository rewrite

### Why not only a surgical patch?

Because the direct question bug sits on top of deeper problems:

- event ownership is wrong
- pending resources are not modeled as authoritative first-class state
- reconnect/bootstrap behavior is incomplete
- cleanup depends on several modules accidentally staying in sync

The hotspot data reinforces this: the most unstable modules are exactly the ones currently sharing orchestration responsibility.

### Why not rewrite everything?

Because large parts of the system are still reusable:

- Feishu ingress and transport
- card rendering infrastructure
- control-card UX
- much of session/project selection behavior

The right target is narrower: **rewrite the state core, not the whole bridge.**

---

## 9. Practical warning for future fixes

Do **not** try to "fix" this by simply clearing busy on click.

That would be wrong because OpenCode is supposed to remain busy until:

1. the bridge sends the correct reply/reject API call,
2. OpenCode resumes or settles,
3. the follow-up event stream confirms the change.

The goal is not to hide busy. The goal is to make the bridge track **why** it is busy and make the question/permission lifecycle authoritative.
