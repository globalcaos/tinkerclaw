import fs from "node:fs/promises";
import path from "node:path";

export interface KitFileEntry {
  path: string;
  content: string;
  writeMode?: "overwrite" | "append" | "skip-if-exists";
}

export class KitStore {
  constructor(private opts: { rootDir: string }) {}

  resolveSandboxPath(owner: string, slug: string, relPath: string): string {
    if (path.isAbsolute(relPath)) throw new Error(`kit-store: absolute path rejected: ${relPath}`);
    const ownerSlug = `${this.safeSegment(owner)}/${this.safeSegment(slug)}`;
    const sandboxRoot = path.resolve(this.opts.rootDir, ownerSlug);
    const target = path.resolve(sandboxRoot, relPath);
    if (target !== sandboxRoot && !target.startsWith(sandboxRoot + path.sep)) {
      throw new Error(`kit-store: path escapes sandbox: ${relPath} -> ${target}`);
    }
    return target;
  }

  private safeSegment(s: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error(`kit-store: unsafe segment: ${s}`);
    return s;
  }

  async writeKitFiles(opts: { owner: string; slug: string; files: KitFileEntry[] }): Promise<void> {
    for (const entry of opts.files) {
      const target = this.resolveSandboxPath(opts.owner, opts.slug, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const mode = entry.writeMode ?? "overwrite";
      if (mode === "skip-if-exists") {
        try {
          await fs.access(target);
          continue;
        } catch {}
      }
      if (mode === "append") {
        await fs.appendFile(target, entry.content, "utf-8");
      } else {
        await fs.writeFile(target, entry.content, "utf-8");
      }
    }
  }

  async list(
    opts: { owner?: string } = {},
  ): Promise<Array<{ owner: string; slug: string; path: string }>> {
    const out: Array<{ owner: string; slug: string; path: string }> = [];
    let owners: string[];
    try {
      owners = await fs.readdir(this.opts.rootDir);
    } catch {
      return out;
    }
    for (const owner of owners) {
      if (opts.owner && owner !== opts.owner) continue;
      const ownerDir = path.join(this.opts.rootDir, owner);
      const stat = await fs.stat(ownerDir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const slugs = await fs.readdir(ownerDir);
      for (const slug of slugs) {
        const kitMd = path.join(ownerDir, slug, "kit.md");
        try {
          await fs.access(kitMd);
          out.push({ owner, slug, path: kitMd });
        } catch {}
      }
    }
    return out;
  }

  rootDirPublic(): string {
    return this.opts.rootDir;
  }
}
