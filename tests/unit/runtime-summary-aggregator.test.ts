import { describe, expect, it, vi } from "vitest";
import { RuntimeSummaryAggregator } from "../../src/app/runtime-summary-aggregator.js";
import { FileStore } from "../../src/feishu/file-store.js";
import { StatusStore } from "../../src/feishu/status-store.js";
import { InteractionManager } from "../../src/interaction/manager.js";
import { PendingInteractionStore } from "../../src/pending/store.js";
import { PermissionManager } from "../../src/permission/manager.js";
import { QuestionManager } from "../../src/question/manager.js";

function createRuntimeSummaryAggregator() {
  const interactionManager = new InteractionManager();
  const questionManager = new QuestionManager();
  const permissionManager = new PermissionManager();
  const onQuestionEvent = vi.fn().mockResolvedValue(undefined);
  const onPermissionEvent = vi.fn().mockResolvedValue(undefined);
  const onEgressFile = vi.fn().mockResolvedValue(undefined);

  const aggregator = new RuntimeSummaryAggregator({
    statusStore: new StatusStore(),
    questionManager,
    permissionManager,
    interactionManager,
    pendingStore: new PendingInteractionStore(),
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
});
