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

describe("PermissionCardHandler card action callbacks", () => {
  it("approve callback sends 'once' to OpenCode permission reply", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const result = await handler.handleCardAction(buildCardAction("approve"));

    expect(openCodeClient.permission.reply).toHaveBeenCalledWith({
      requestID: "perm-1",
      reply: "once",
    });
    expect(result).toEqual({});
  });

  it("always-approve callback sends 'always' to OpenCode permission reply", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    await handler.handleCardAction(buildCardAction("always"));

    expect(openCodeClient.permission.reply).toHaveBeenCalledWith({
      requestID: "perm-1",
      reply: "always",
    });
  });

  it("deny callback sends 'reject' to OpenCode permission reply", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    await handler.handleCardAction(buildCardAction("deny"));

    expect(openCodeClient.permission.reply).toHaveBeenCalledWith({
      requestID: "perm-1",
      reply: "reject",
    });
  });

  it("removes the permission from the manager after resolution", async () => {
    const { handler, permissionManager } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");
    expect(permissionManager.isActiveMessage("card-msg-1")).toBe(true);

    await handler.handleCardAction(buildCardAction("approve"));

    expect(permissionManager.isActiveMessage("card-msg-1")).toBe(false);
    expect(permissionManager.getRequest("card-msg-1")).toBeNull();
  });

  it("makes exactly ONE downstream reply call per action", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    await handler.handleCardAction(buildCardAction("approve"));

    expect(openCodeClient.permission.reply).toHaveBeenCalledTimes(1);
  });

  it("ignores card actions with non-permission_reply action type", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const event = {
      open_message_id: "card-msg-1",
      action: {
        value: { action: "question_answer", reply: "approve", requestId: "perm-1" },
      },
    };
    await handler.handleCardAction(event);

    expect(openCodeClient.permission.reply).not.toHaveBeenCalled();
    expect(permissionManager.isActiveMessage("card-msg-1")).toBe(true);
  });

  it("ignores card actions missing open_message_id", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const event = {
      action: {
        value: { action: "permission_reply", reply: "approve", requestId: "perm-1" },
      },
    };
    await handler.handleCardAction(event);

    expect(openCodeClient.permission.reply).not.toHaveBeenCalled();
  });

  it("ignores card actions with missing action value", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    const event = {
      open_message_id: "card-msg-1",
      action: {},
    };
    await handler.handleCardAction(event);

    expect(openCodeClient.permission.reply).not.toHaveBeenCalled();
  });

  it("ignores card actions with missing action object", async () => {
    const { handler, permissionManager, openCodeClient } = createHandler();
    permissionManager.startPermission(REQUEST, "card-msg-1");

    await handler.handleCardAction({ open_message_id: "card-msg-1" });

    expect(openCodeClient.permission.reply).not.toHaveBeenCalled();
  });
});
