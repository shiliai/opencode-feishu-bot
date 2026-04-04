import type { PermissionRequest, PermissionState } from "./types.js";
import { logger } from "../utils/logger.js";

export class PermissionManager {
  private state: PermissionState = {
    requestsByMessageId: new Map(),
  };

  getStateSnapshot(): PermissionState {
    return {
      requestsByMessageId: new Map(this.state.requestsByMessageId.entries()),
    };
  }

  startPermission(request: PermissionRequest, messageId: string): void {
    logger.debug(
      `[PermissionManager] startPermission: id=${request.id}, permission=${request.permission}, messageId=${messageId}`,
    );

    if (this.state.requestsByMessageId.has(messageId)) {
      logger.warn(`[PermissionManager] Message ID already tracked, replacing: ${messageId}`);
    }

    this.state.requestsByMessageId.set(messageId, request);
    logger.info(
      `[PermissionManager] New permission request: type=${request.permission}, patterns=${request.patterns.join(", ")}, pending=${this.state.requestsByMessageId.size}`,
    );
  }

  getRequest(messageId: string | null): PermissionRequest | null {
    if (messageId === null) {
      return null;
    }

    return this.state.requestsByMessageId.get(messageId) ?? null;
  }

  getRequestID(messageId: string | null): string | null {
    return this.getRequest(messageId)?.id ?? null;
  }

  getPermissionType(messageId: string | null): string | null {
    return this.getRequest(messageId)?.permission ?? null;
  }

  getPatterns(messageId: string | null): string[] {
    return this.getRequest(messageId)?.patterns ?? [];
  }

  isActiveMessage(messageId: string | null): boolean {
    return messageId !== null && this.state.requestsByMessageId.has(messageId);
  }

  getMessageId(): string | null {
    const messageIds = this.getMessageIds();
    if (messageIds.length === 0) {
      return null;
    }

    return messageIds[messageIds.length - 1] ?? null;
  }

  getMessageIds(): string[] {
    return Array.from(this.state.requestsByMessageId.keys());
  }

  removeByMessageId(messageId: string | null): PermissionRequest | null {
    const request = this.getRequest(messageId);
    if (!request || messageId === null) {
      return null;
    }

    this.state.requestsByMessageId.delete(messageId);
    logger.debug(
      `[PermissionManager] Removed permission request: id=${request.id}, messageId=${messageId}, pending=${this.state.requestsByMessageId.size}`,
    );

    return request;
  }

  getPendingCount(): number {
    return this.state.requestsByMessageId.size;
  }

  isActive(): boolean {
    return this.state.requestsByMessageId.size > 0;
  }

  clear(): void {
    logger.debug(
      `[PermissionManager] Clearing permission state: pending=${this.state.requestsByMessageId.size}`,
    );
    this.state = {
      requestsByMessageId: new Map(),
    };
  }
}

export const permissionManager = new PermissionManager();
