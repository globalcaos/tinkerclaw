// extensions/overseer/persistence.ts
import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TopologySnapshot } from "./topology.js";

export function saveState(filePath: string, snapshot: TopologySnapshot): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
  renameSync(tmp, filePath);
}

export function loadState(filePath: string): TopologySnapshot | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
      return data as TopologySnapshot;
    }
    return null;
  } catch {
    return null;
  }
}
