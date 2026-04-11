import type { PermissionRequest } from "../permission/types.js";
import type { Question } from "../question/types.js";

export interface SummaryTokensInfo {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SummaryFileChange {
  file: string;
  additions: number;
  deletions: number;
}

export interface SummaryToolAttachment {
  buffer: Buffer;
  filename: string;
  displayPath: string;
  operation: "write" | "edit";
}

export interface SummaryToolEvent {
  sessionId: string;
  messageId: string;
  callId: string;
  tool: string;
  status: string;
  input?: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  fileChange?: SummaryFileChange;
  attachment?: SummaryToolAttachment;
}

export interface SummaryQuestionEvent {
  sessionId: string;
  requestId: string;
  questions: Question[];
}

export interface SummaryPermissionEvent {
  sessionId: string;
  request: PermissionRequest;
}

export interface SummarySessionDiffEvent {
  sessionId: string;
  diffs: SummaryFileChange[];
}

export interface SummaryTokenEvent {
  sessionId: string;
  messageId: string;
  tokens: SummaryTokensInfo;
  isCompleted: boolean;
}

export interface SummarySessionRetryInfo {
  sessionId: string;
  attempt?: number;
  message: string;
  next?: number;
}

export interface SummaryCallbacks {
  onTypingStart?: (sessionId: string) => void;
  onTypingStop?: (sessionId: string, reason: string) => void;
  onPartial?: (
    sessionId: string,
    messageId: string,
    messageText: string,
  ) => void;
  onComplete?: (
    sessionId: string,
    messageId: string,
    messageText: string,
  ) => void;
  onSessionIdle?: (sessionId: string) => void;
  onTool?: (toolEvent: SummaryToolEvent) => void;
  onQuestion?: (questionEvent: SummaryQuestionEvent) => void;
  onQuestionError?: (sessionId: string) => void;
  onQuestionReplied?: (sessionId: string, requestId: string) => void;
  onQuestionRejected?: (sessionId: string, requestId: string) => void;
  onPermission?: (permissionEvent: SummaryPermissionEvent) => void;
  onPermissionReplied?: (sessionId: string, requestId: string) => void;
  onSessionDiff?: (diffEvent: SummarySessionDiffEvent) => void;
  onTokenUpdate?: (tokenEvent: SummaryTokenEvent) => void;
  onSessionRetry?: (retryInfo: SummarySessionRetryInfo) => void;
  onSessionCompacted?: (sessionId: string, directory: string) => void;
  onSessionError?: (sessionId: string, message: string) => void;
  onCleared?: () => void;
}
