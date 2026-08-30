export type StaticExtensionAsset = {
  /** Repo-root-relative source path. */
  src: string;
  /** Repo-root-relative destination, always under `dist/`. */
  dest: string;
};

/**
 * Static (non-transpiled) runtime assets copied into `dist/` after the bundle
 * step. An extension file that is read from its own directory at run time must
 * appear here, or it ships in the repo and is absent from the deployed tree.
 */
export const STATIC_EXTENSION_ASSETS: readonly StaticExtensionAsset[];

export function listStaticExtensionAssetOutputs(params?: {
  assets?: readonly StaticExtensionAsset[];
}): string[];

export function copyStaticExtensionAssets(params?: {
  rootDir?: string;
  assets?: readonly StaticExtensionAsset[];
  fs?: unknown;
  warn?: (message: string) => void;
}): void;

export function writeStableRootRuntimeAliases(params?: { rootDir?: string }): void;

export function runRuntimePostBuild(params?: { rootDir?: string }): void;
