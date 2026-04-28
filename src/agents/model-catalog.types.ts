export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  /** FORK: optional display ordering rank from openclaw.json — lower = earlier. Used by Tinker UI model panel. */
  rank?: number;
};
