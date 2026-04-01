// extensions/prefrontal/denial-tracking.ts
// FORK: Denial tracking — prevents infinite tool denial loops by escalating
// to user after N consecutive denials of the same tool type.

export interface DenialTrackerConfig {
  limit: number;
}

export interface DenialTracker {
  recordDenial(toolName: string): void;
  recordApproval(toolName: string): void;
  shouldEscalate(toolName: string): boolean;
  getEscalationMessage(toolName: string): string;
  getCount(toolName: string): number;
}

export function createDenialTracker(config: DenialTrackerConfig): DenialTracker {
  const counts = new Map<string, number>();

  return {
    recordDenial(toolName: string): void {
      counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
    },
    recordApproval(toolName: string): void {
      counts.delete(toolName);
    },
    shouldEscalate(toolName: string): boolean {
      return (counts.get(toolName) ?? 0) >= config.limit;
    },
    getEscalationMessage(toolName: string): string {
      const count = counts.get(toolName) ?? 0;
      return `Tool "${toolName}" has been denied ${count} consecutive times. Please ask the user for guidance before retrying.`;
    },
    getCount(toolName: string): number {
      return counts.get(toolName) ?? 0;
    },
  };
}
