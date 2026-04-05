import { describe, expect, it, vi } from "vitest";
import { PermissionCardHandler } from "../../src/feishu/handlers/permission.js";
import type { OpenCodePermissionClient } from "../../src/feishu/handlers/permission.js";
import { PermissionManager } from "../../src/permission/manager.js";
import type { PermissionRequest } from "../../src/permission/types.js";

const REQUEST: PermissionRequest = {
  id: "perm-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm test"],
  metadata: { source: "unit-test" },
  always: [],
  tool: {
    messageID: "tool-message-1",
    callID: "tool-call-1",
  },
};

function createHandler() {
  const permissionManager = new PermissionManager();
  const renderer = {
    renderPermissionCard: vi.fn().mockResolvedValue("card-msg-1"),
  };
  const openCodeClient: OpenCodePermissionClient = {
    permission: {
      reply: vi.fn().mockResolvedValue(undefined),
    },
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const handler = new PermissionCardHandler({
    permissionManager,
    renderer: renderer as never,
    openCodeClient,
    logger,
  });

  return { handler, permissionManager, openCodeClient, logger };
}

function buildCardAction(reply: string, requestId: string = "perm-1", openMessageId: string = "card-msg-1") {
  return {
    open_message_id: openMessageId,
    action: {
      value: { action: "permission_reply", reply, requestId },
    },
  };
}

describe("PermissionCardHandler duplicate rejection", () => {
  it("replayed card action after permission is already resolved does NOT trigger a second OpenCode reply", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const action = buildCardAction("approve");

    await handler.handleCardAction(action);
    expect(openCodeClient.permission.reply).toHaveBeenCalledTimes(1);
    expect(permissionManager.isActiveMessage("card-msg-1")).toBe(false);

    await handler.handleCardAction(action);
    expect(openCodeClient.permission.reply).toHaveBeenCalledTimes(1);
  });

  it("PermissionManager state is not altered by duplicate callbacks", async () => {
    const { handler, permissionManager } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const action = buildCardAction("deny");
    await handler.handleCardAction(action);

    const snapshotAfterFirst = permissionManager.getPendingCount();

    await handler.handleCardAction(action);
    const snapshotAfterSecond = permissionManager.getPendingCount();

    expect(snapshotAfterFirst).toBe(0);
    expect(snapshotAfterSecond).toBe(0);
    expect(permissionManager.isActiveMessage("card-msg-1")).toBe(false);
  });

  it("unknown messageId is safely ignored", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const action = buildCardAction("approve", "perm-1", "unknown-msg-id");
    const result = await handler.handleCardAction(action);

    expect(result).toEqual({});
    expect(openCodeClient.permission.reply).not.toHaveBeenCalled();
    expect(permissionManager.isActiveMessage("card-msg-1")).toBe(true);
  });

  it("mismatched requestId is rejected", async () => {
    const fresh = createHandler();
    fresh.permissionManager.startPermission(REQUEST, "card-msg-1");

    const action = buildCardAction("approve", "wrong-perm-id", "card-msg-1");
    const result = await fresh.handler.handleCardAction(action);

    expect(result).toEqual({});
    expect(fresh.openCodeClient.permission.reply).not.toHaveBeenCalled();
    expect(fresh.permissionManager.isActiveMessage("card-msg-1")).toBe(true);
    expect(fresh.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Request ID mismatch"),
    );
  });

  it("null messageId from open_message_id is safely ignored", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const event = {
      open_message_id: null,
      action: {
        value: { action: "permission_reply", reply: "approve", requestId: "perm-1" },
      },
    };
    const result = await handler.handleCardAction(event);

    expect(result).toEqual({});
    expect(openCodeClient.permission.reply).not.toHaveBeenCalled();
  });
});
