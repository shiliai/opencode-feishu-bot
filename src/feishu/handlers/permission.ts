import type { PermissionRequest } from "../../permission/types.js";
import type { PermissionManager } from "../../permission/manager.js";
import type { Logger } from "../../utils/logger.js";
import { logger as defaultLogger } from "../../utils/logger.js";

type OpenCodeReplyValue = "once" | "always" | "reject";

export interface OpenCodePermissionClient {
  permission: {
    reply(params: {
      requestID: string;
      reply: OpenCodeReplyValue;
    }): Promise<unknown>;
  };
}

export interface PermissionRenderer {
  renderPermissionCard(
    receiveId: string,
    request: PermissionRequest,
  ): Promise<string | undefined>;
}

export interface PermissionCardHandlerOptions {
  permissionManager: PermissionManager;
  renderer: PermissionRenderer;
  openCodeClient: OpenCodePermissionClient;
  interactionManager?: { clear(chatId: string, reason?: string): void };
  logger?: Logger;
}

function extractReceiveId(event: Record<string, unknown>): string | null {
  const context = isRecord(event.context) ? event.context : null;
  return typeof event.open_chat_id === "string"
    ? event.open_chat_id
    : typeof context?.open_chat_id === "string"
      ? context.open_chat_id
      : null;
}

function mapPermissionReply(cardReply: string): OpenCodeReplyValue {
  switch (cardReply) {
    case "approve":
      return "once";
    case "always":
      return "always";
    case "deny":
      return "reject";
    default:
      return "reject";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PermissionCardHandler {
  private readonly permissionManager: PermissionManager;
  private readonly renderer: PermissionRenderer;
  private readonly openCodeClient: OpenCodePermissionClient;
  private readonly interactionManager?: {
    clear(chatId: string, reason?: string): void;
  };
  private readonly logger: Logger;
  private readonly emptyResponse: Record<string, never> = {};

  constructor(options: PermissionCardHandlerOptions) {
    this.permissionManager = options.permissionManager;
    this.renderer = options.renderer;
    this.openCodeClient = options.openCodeClient;
    this.interactionManager = options.interactionManager;
    this.logger = options.logger ?? defaultLogger;
  }

  async handlePermissionEvent(
    receiveId: string,
    request: PermissionRequest,
    sourceMessageId: string,
  ): Promise<void> {
    this.permissionManager.startPermission(request, sourceMessageId);

    try {
      const cardMessageId = await this.renderer.renderPermissionCard(
        receiveId,
        request,
      );
      if (cardMessageId) {
        if (cardMessageId !== sourceMessageId) {
          this.permissionManager.removeByMessageId(sourceMessageId);
          this.permissionManager.startPermission(request, cardMessageId);
        }
        this.logger.debug(
          `[PermissionCardHandler] Permission card sent: messageId=${cardMessageId}, permission=${request.permission}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[PermissionCardHandler] Failed to render permission card for request ${request.id}`,
        error,
      );
    }
  }

  async handleCardAction(
    event: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    // Extract action value from the card action event
    const actionObj = event.action;
    if (!isRecord(actionObj)) {
      return this.emptyResponse;
    }

    const actionValue = actionObj.value;
    if (!isRecord(actionValue)) {
      return this.emptyResponse;
    }

    if (actionValue.action !== "permission_reply") {
      return this.emptyResponse;
    }

    const cardReply = actionValue.reply;
    const requestIdFromCard = actionValue.requestId;

    if (
      typeof cardReply !== "string" ||
      typeof requestIdFromCard !== "string"
    ) {
      this.logger.warn(
        "[PermissionCardHandler] Invalid card action value: missing reply or requestId",
      );
      return this.emptyResponse;
    }

    // Look up the pending request using open_message_id
    const messageId =
      typeof event.open_message_id === "string" ? event.open_message_id : null;
    if (!messageId) {
      this.logger.warn(
        "[PermissionCardHandler] Card action missing open_message_id",
      );
      return this.emptyResponse;
    }

    // Check if this message still has an active permission request
    if (!this.permissionManager.isActiveMessage(messageId)) {
      this.logger.debug(
        `[PermissionCardHandler] Ignoring stale/duplicate card action for messageId=${messageId}`,
      );
      return this.emptyResponse;
    }

    const request = this.permissionManager.getRequest(messageId);
    if (!request) {
      this.logger.warn(
        `[PermissionCardHandler] No pending request found for messageId=${messageId}`,
      );
      return this.emptyResponse;
    }

    // Verify the request ID matches (extra safety check)
    if (request.id !== requestIdFromCard) {
      this.logger.warn(
        `[PermissionCardHandler] Request ID mismatch: stored=${request.id}, card=${requestIdFromCard}`,
      );
      return this.emptyResponse;
    }

    const reply = mapPermissionReply(cardReply);

    try {
      await this.openCodeClient.permission.reply({
        requestID: request.id,
        reply,
      });
    } catch (error) {
      this.logger.error(
        `[PermissionCardHandler] Failed to forward permission reply for request ${request.id}`,
        error,
      );
      return this.emptyResponse;
    }

    this.permissionManager.removeByMessageId(messageId);
    const receiveId = extractReceiveId(event);
    if (receiveId) {
      this.interactionManager?.clear(receiveId, "permission_resolved");
    }

    this.logger.info(
      `[PermissionCardHandler] Permission resolved: id=${request.id}, reply=${reply}`,
    );

    return this.emptyResponse;
  }
}
