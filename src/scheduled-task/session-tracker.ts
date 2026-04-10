/**
 * Tracks active scheduled-task session IDs so that the prompt ingress
 * busy-state check can exclude them from the "any busy" calculation.
 *
 * Without this, a running scheduled task session would block all
 * foreground user prompts for the same project directory.
 */
export class ScheduledTaskSessionTracker {
  private readonly activeIds = new Set<string>();

  add(sessionId: string): void {
    this.activeIds.add(sessionId);
  }

  remove(sessionId: string): void {
    this.activeIds.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.activeIds.has(sessionId);
  }

  clear(): void {
    this.activeIds.clear();
  }
}
