---
name: wiki-maintainer
description: Maintain the OpenClaw memory wiki vault with deterministic pages, managed blocks, and source-backed updates.
---

Use this skill when working inside a memory-wiki vault.

- Prefer `wiki_status` first when you need to understand the vault mode, path, or Obsidian CLI availability.
- Use `openclaw wiki ingest`, `openclaw wiki compile`, and `openclaw wiki lint` as the default maintenance loop.
- Keep generated sections inside managed markers. Do not overwrite human note blocks.
- Treat raw sources, memory artifacts, and daily notes as evidence. Do not let wiki pages become the only source of truth for new claims.
- Keep page identity stable. Favor updating existing entities and concepts over spawning duplicates with slightly different names.
- When creating or refreshing indexes, preserve Obsidian-friendly wikilinks if the vault render mode is `obsidian`.
