/**
 * U9 A-MEM Zettelkasten auto-linking: link-builder runtime registry.
 *
 * Holds a per-session LinkBuilder instance keyed by SessionManager identity,
 * following the same WeakMap registry pattern as ingestion-runtime.ts. The Wire
 * phase reads from this registry inside attempt-hooks.ts (onTurnComplete ENGRAM
 * block) to call extractAndIndex() fire-and-forget after each turn's events are
 * ingested, and inside retrieval-runtime.ts for 1-hop backlink expansion.
 */

import type { LinkIndex, LinkRecord } from "../../memory/engram/link-index.js";
import { parseMentions } from "../../memory/engram/mention-parser.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

/**
 * Binds a session's link-index store to the parse-and-append pipeline. The Wire
 * phase calls extractAndIndex() on turn completion and getBacklinks() during
 * retrieval pack assembly.
 */
export interface LinkBuilder {
  /** Parse `content` for mentions and append a LinkRecord for each, from `eventId`. */
  extractAndIndex(eventId: string, content: string): LinkRecord[];
  /** Forward edges authored by `eventId`. */
  getLinks(eventId: string): LinkRecord[];
  /** Reverse edges pointing at `targetKey` (case-insensitive). */
  getBacklinks(targetKey: string): LinkRecord[];
  /** The underlying bidirectional link index. */
  readonly linkIndex: LinkIndex;
}

/** Construct a LinkBuilder bound to a session's link-index store. */
export function createLinkBuilder(linkIndex: LinkIndex): LinkBuilder {
  return {
    linkIndex,

    extractAndIndex(eventId: string, content: string): LinkRecord[] {
      return parseMentions(content).map((mention) => linkIndex.append(eventId, mention));
    },

    getLinks(eventId: string): LinkRecord[] {
      return linkIndex.getLinks(eventId);
    },

    getBacklinks(targetKey: string): LinkRecord[] {
      return linkIndex.getBacklinks(targetKey);
    },
  };
}

const registry = createSessionManagerRuntimeRegistry<LinkBuilder>();

/** Store a link builder for a given session manager instance. */
export const setLinkBuilderRuntime = registry.set;

/** Retrieve the link builder for a given session manager instance, or null. */
export const getLinkBuilderRuntime = registry.get;
