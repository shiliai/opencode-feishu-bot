export type PendingRequestType = "question" | "permission";

export interface PendingRequest {
  requestId: string;
  sessionId: string;
  directory: string;
  chatId: string;
  type: PendingRequestType;
  cardMessageId: string | null;
  createdAt: number;
}
