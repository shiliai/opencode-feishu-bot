import type { ScheduledTask } from "./types.js";

export interface TaskStore {
  listTasks(): ScheduledTask[];
  getTask(id: string): ScheduledTask | undefined;
  addTask(task: ScheduledTask): void;
  removeTask(id: string): boolean;
  updateTask(id: string, updates: Partial<ScheduledTask>): void;
}

export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, ScheduledTask>();
  private readonly onChange?: () => void;

  constructor(onChange?: () => void) {
    this.onChange = onChange;
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  addTask(task: ScheduledTask): void {
    this.tasks.set(task.id, { ...task });
    this.onChange?.();
  }

  removeTask(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) {
      this.onChange?.();
    }
    return existed;
  }

  updateTask(id: string, updates: Partial<ScheduledTask>): void {
    const existing = this.tasks.get(id);
    if (!existing) {
      return;
    }
    this.tasks.set(id, { ...existing, ...updates });
    this.onChange?.();
  }

  loadFromJSON(data: unknown): void {
    if (!Array.isArray(data)) {
      return;
    }
    this.tasks.clear();
    for (const item of data) {
      if (
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof (item as { id: unknown }).id === "string"
      ) {
        this.tasks.set((item as { id: string }).id, item as ScheduledTask);
      }
    }
  }

  toJSON(): unknown[] {
    return Array.from(this.tasks.values());
  }
}
