/**
 * web-tools — Re-export barrel for web browsing agent tools
 *
 * Aggregates the web fetch and web search tool factories into a single import
 * point. `createWebFetchTool` provides URL fetching with Firecrawl and readable
 * content extraction, while `createWebSearchTool` wraps external search APIs.
 * Downstream consumers (tool registration in the agent runner) import from here
 * rather than reaching into the individual implementation files.
 *
 * Wired in by: direct import from tool registration code (e.g. agent tool setup)
 */
export { createWebFetchTool, extractReadableContent, fetchFirecrawlContent } from "./web-fetch.js";
export { createWebSearchTool } from "./web-search.js";
