/**
 * ENGRAM Phase 1A: Artifact store for large blobs.
 * Content-type-aware preview generation (ENGRAM §4.4).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ArtifactPreview } from "./event-types.js";
import { generateULID } from "./event-store.js";

export interface ArtifactStoreOptions {
	baseDir: string;
}

export interface ArtifactStore {
	store(content: string, contentType: ArtifactPreview["contentType"]): ArtifactPreview;
	read(artifactId: string): string | undefined;
	preview(artifactId: string): ArtifactPreview | undefined;
	readonly baseDir: string;
}

function artifactPath(baseDir: string, artifactId: string): string {
	return join(baseDir, "artifacts", artifactId);
}

function metaPath(baseDir: string, artifactId: string): string {
	return join(baseDir, "artifacts", `${artifactId}.meta.json`);
}

export function tailLines(content: string, n: number): string {
	const lines = content.split("\n");
	if (lines.length <= n) {return content;}
	const tail = lines.slice(-n).join("\n");
	return `... (${lines.length - n} lines omitted)\n${tail}`;
}

export function jsonSkeleton(content: string, maxLines: number): string {
	try {
		const parsed = JSON.parse(content);
		const pretty = JSON.stringify(parsed, null, 2);
		const lines = pretty.split("\n");
		if (lines.length <= maxLines) {return pretty;}
		return lines.slice(0, maxLines).join("\n") + "\n... (truncated)";
	} catch {
		return tailLines(content, maxLines);
	}
}

export function headerPlusRows(content: string, rowCount: number): string {
	const lines = content.split("\n").filter(Boolean);
	if (lines.length <= rowCount + 1) {return content;}
	const header = lines[0];
	const rows = lines.slice(1, 1 + rowCount);
	return [header, ...rows].join("\n") + `\n... (${lines.length - 1 - rowCount} more rows)`;
}

export function matchContext(content: string): string {
	// For search results, show first few results
	return tailLines(content, 10);
}

export function generatePreview(
	content: string,
	type: ArtifactPreview["contentType"],
): string {
	switch (type) {
		case "log":
			return tailLines(content, 10);
		case "json":
			return jsonSkeleton(content, 7);
		case "csv":
			return headerPlusRows(content, 2);
		case "search":
			return matchContext(content);
		default:
			return tailLines(content, 10);
	}
}

export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
	const { baseDir } = options;
	mkdirSync(join(baseDir, "artifacts"), { recursive: true });

	return {
		baseDir,

		store(content: string, contentType: ArtifactPreview["contentType"]): ArtifactPreview {
			const artifactId = generateULID();
			const path = artifactPath(baseDir, artifactId);
			const meta: ArtifactPreview = {
				artifactId,
				contentType,
				preview: generatePreview(content, contentType),
				totalSize: content.length,
				lineCount: content.split("\n").length,
			};

			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			writeFileSync(metaPath(baseDir, artifactId), JSON.stringify(meta));

			return meta;
		},

		read(artifactId: string): string | undefined {
			const path = artifactPath(baseDir, artifactId);
			if (!existsSync(path)) {return undefined;}
			return readFileSync(path, "utf-8");
		},

		preview(artifactId: string): ArtifactPreview | undefined {
			const path = metaPath(baseDir, artifactId);
			if (!existsSync(path)) {return undefined;}
			return JSON.parse(readFileSync(path, "utf-8")) as ArtifactPreview;
		},
	};
}
