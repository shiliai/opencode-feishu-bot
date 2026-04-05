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

function createMocks() {
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

  return { permissionManager, renderer, openCodeClient, logger };
}

describe("PermissionCardHandler", () => {
  describe("handlePermissionEvent", () => {
    it("registers the permission and renders a card", async () => {
      const { permissionManager, renderer, openCodeClient, logger } = createMocks();
      const handler = new PermissionCardHandler({
        permissionManager,
        renderer: renderer as never,
        openCodeClient,
        logger,
      });

      await handler.handlePermissionEvent("chat-1", REQUEST, "source-msg-1");

      expect(permissionManager.isActiveMessage("source-msg-1")).toBe(false);
      expect(permissionManager.isActiveMessage("card-msg-1")).toBe(true);
      expect(permissionManager.getRequest("card-msg-1")).toEqual(REQUEST);
      expect(renderer.renderPermissionCard).toHaveBeenCalledWith("chat-1", REQUEST);
    });

    it("logs the card message ID when renderer returns one", async () => {
      const { permissionManager, renderer, openCodeClient, logger } = createMocks();
      const handler = new PermissionCardHandler({
        permissionManager,
        renderer: renderer as never,
        openCodeClient,
        logger,
      });

      await handler.handlePermissionEvent("chat-1", REQUEST, "source-msg-1");

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("card-msg-1"),
      );
    });

    it("does not throw when renderer throws", async () => {
      const { permissionManager, renderer, openCodeClient, logger } = createMocks();
      renderer.renderPermissionCard.mockRejectedValue(new Error("Feishu API error"));
      const handler = new PermissionCardHandler({
        permissionManager,
        renderer: renderer as never,
        openCodeClient,
        logger,
      });

      await expect(
        handler.handlePermissionEvent("chat-1", REQUEST, "source-msg-1"),
      ).resolves.toBeUndefined();

      expect(permissionManager.isActiveMessage("source-msg-1")).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to render permission card"),
        expect.any(Error),
      );
    });

    it("registers the permission even if renderer returns undefined message ID", async () => {
      const { permissionManager, renderer, openCodeClient, logger } = createMocks();
      renderer.renderPermissionCard.mockResolvedValue(undefined);
      const handler = new PermissionCardHandler({
        permissionManager,
        renderer: renderer as never,
        openCodeClient,
        logger,
      });

      await handler.handlePermissionEvent("chat-1", REQUEST, "source-msg-1");

      expect(permissionManager.isActiveMessage("source-msg-1")).toBe(true);
      expect(logger.debug).not.toHaveBeenCalled();
    });
  });
});
