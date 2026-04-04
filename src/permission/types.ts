export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export type PermissionReply = "approve" | "always" | "deny";

export interface PermissionState {
  requestsByMessageId: Map<string, PermissionRequest>;
}
