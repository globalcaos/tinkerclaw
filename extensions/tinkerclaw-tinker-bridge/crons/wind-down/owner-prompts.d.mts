export type OwnerWords = { day: string; hm: string; label: string; text: string };
export type OwnerPrompt = { when: string; epochMs: number; chat: string; text: string };

export function labelOffsetMinutes(label: string): number | undefined;
export function stampInstant(
  day: string,
  hm: string,
  label: string,
  timeZone: string,
): { epochMs: number; offset: number };
export function ownerWords(messageText: string): OwnerWords | null;
export function defaultSourceDirs(env?: NodeJS.ProcessEnv, home?: string): string[];
export function collectOwnerPrompts(opts: {
  dirs: string[];
  sinceMs: number;
  untilMs: number;
  timeZone: string;
}): Promise<OwnerPrompt[]>;
