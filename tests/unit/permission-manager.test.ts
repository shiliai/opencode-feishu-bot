import { describe, expect, it } from "vitest";
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

describe("PermissionManager", () => {
  it("tracks requests by string message ids", () => {
    const manager = new PermissionManager();

    manager.startPermission(REQUEST, "message-1");

    expect(manager.getRequest("message-1")).toEqual(REQUEST);
    expect(manager.getRequestID("message-1")).toBe("perm-1");
    expect(manager.getPermissionType("message-1")).toBe("bash");
    expect(manager.getPatterns("message-1")).toEqual(["npm test"]);
    expect(manager.isActiveMessage("message-1")).toBe(true);
    expect(manager.getMessageId()).toBe("message-1");
    expect(manager.getPendingCount()).toBe(1);
  });

  it("removes requests by message id", () => {
    const manager = new PermissionManager();

    manager.startPermission(REQUEST, "message-1");

    expect(manager.removeByMessageId("message-1")).toEqual(REQUEST);
    expect(manager.getRequest("message-1")).toBeNull();
    expect(manager.isActive()).toBe(false);
  });

  it("clears all pending requests", () => {
    const manager = new PermissionManager();

    manager.startPermission(REQUEST, "message-1");
    manager.startPermission({ ...REQUEST, id: "perm-2" }, "message-2");
    manager.clear();

    expect(manager.getMessageIds()).toEqual([]);
    expect(manager.isActive()).toBe(false);
    expect(manager.getPendingCount()).toBe(0);
  });
});
