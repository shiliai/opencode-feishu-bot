import type { Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";
import { RuntimeSummaryAggregator } from "../../src/app/runtime-summary-aggregator.js";
import { FileStore } from "../../src/feishu/file-store.js";
import { StatusStore } from "../../src/feishu/status-store.js";
import { InteractionManager } from "../../src/interaction/manager.js";
import { PendingInteractionStore } from "../../src/pending/store.js";
import { PermissionManager } from "../../src/permission/manager.js";
import { QuestionManager } from "../../src/question/manager.js";

function makeEvent(type: string, properties: Record<string, unknown>): Event {
  return {
    type,
    properties,
  } as unknown as Event;
}

function createRuntimeSummaryAggregator() {
  const interactionManager = new InteractionManager();
  const questionManager = new QuestionManager();
  const permissionManager = new PermissionManager();
  const pendingStore = new PendingInteractionStore();
  const statusStore = new StatusStore();
  const onQuestionEvent = vi.fn().mockResolvedValue(undefined);
  const onPermissionEvent = vi.fn().mockResolvedValue(undefined);
  const onEgressFile = vi.fn().mockResolvedValue(undefined);

  const aggregator = new RuntimeSummaryAggregator({
    statusStore,
    questionManager,
    permissionManager,
    interactionManager,
    pendingStore,
    questionCardHandler: {
      handleQuestionEvent: onQuestionEvent,
    },
    permissionCardHandler: {
      handlePermissionEvent: onPermissionEvent,
    },
    fileHandler: {
      egressFile: onEgressFile,
    },
    fileStore: new FileStore(),
  });

  return {
    aggregator,
    interactionManager,
    pendingStore,
    permissionManager,
    questionManager,
    statusStore,
  };
}

describe("RuntimeSummaryAggregator", () => {
  it("session switch does not clear unrelated chat interaction state", () => {
    const { aggregator, interactionManager } = createRuntimeSummaryAggregator();

    aggregator.setCallbacks({});
    aggregator.setSession("session-A");

    interactionManager.start("chat-A", {
      kind: "question",
      expectedInput: "text",
      expiresInMs: null,
    });
    interactionManager.start("chat-B", {
      kind: "permission",
      expectedInput: "callback",
      expiresInMs: null,
    });

    aggregator.setSession("session-B");

    expect(interactionManager.isActive("chat-A")).toBe(true);
    expect(interactionManager.isActive("chat-B")).toBe(true);
  });

  it("onCleared callback is still invoked on session switch", () => {
    const { aggregator } = createRuntimeSummaryAggregator();
    const onCleared = vi.fn();

    aggregator.setCallbacks({ onCleared });
    aggregator.setSession("session-A");
    aggregator.setSession("session-B");

    expect(onCleared).toHaveBeenCalledTimes(2);
  });

  it("question reply only clears the active request and uses pending chat mapping", () => {
    const {
      aggregator,
      interactionManager,
      pendingStore,
      questionManager,
      statusStore,
    } = createRuntimeSummaryAggregator();

    aggregator.setCallbacks({});
    aggregator.setSession("session-stale");
    questionManager.startQuestions(
      [
        {
          question: "Pick one",
          header: "Pick one",
          options: [{ label: "yes", description: "continue" }],
          multiple: false,
          custom: false,
        },
      ],
      "req-active",
    );
    interactionManager.start("chat-stale", {
      kind: "question",
      expectedInput: "callback",
      expiresInMs: null,
    });
    pendingStore.add(
      "req-stale",
      "session-stale",
      "/workspace/a",
      "chat-stale",
      "question",
    );
    statusStore.startTurn({
      sessionId: "session-other",
      directory: "/workspace/b",
      receiveId: "chat-other",
      sourceMessageId: "msg-1",
    });

    aggregator.processEvent(
      makeEvent("question.replied", {
        sessionID: "session-stale",
        requestID: "req-stale",
      }),
    );

    expect(questionManager.getRequestID()).toBe("req-active");
    expect(interactionManager.isActive("chat-stale")).toBe(false);
    expect(pendingStore.has("req-stale")).toBe(false);
  });

  it("permission reply clears the pending chat even without status store entry", () => {
    const { aggregator, interactionManager, pendingStore, permissionManager } =
      createRuntimeSummaryAggregator();

    aggregator.setCallbacks({});
    aggregator.setSession("session-stale");
    permissionManager.startPermission(
      {
        id: "perm-1",
        sessionID: "session-stale",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
      "msg-perm",
    );
    interactionManager.start("chat-perm", {
      kind: "permission",
      expectedInput: "callback",
      expiresInMs: null,
    });
    pendingStore.add(
      "perm-1",
      "session-stale",
      "/workspace/a",
      "chat-perm",
      "permission",
    );

    aggregator.processEvent(
      makeEvent("permission.replied", {
        sessionID: "session-stale",
        requestID: "perm-1",
      }),
    );

    expect(interactionManager.isActive("chat-perm")).toBe(false);
    expect(pendingStore.has("perm-1")).toBe(false);
    expect(permissionManager.getRequest("msg-perm")).toBeNull();
  });
});
