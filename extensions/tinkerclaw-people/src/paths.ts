/**
 * FORK: tinkerclaw-people — path resolution.
 *
 * Resolves the on-disk locations the plugin reads: the people dir, the
 * WhatsApp history DB, and the legacy work/people.md table that seeds emails.
 * All paths can be overridden through the plugin config.
 */
import os from "node:os";
import path from "node:path";

export type PeopleResolvedConfig = {
  peopleDir: string;
  aliasesPath: string;
  statePath: string;
  indexPath: string;
  whatsappDb: string;
  workPeopleMd: string;
  selfJid: string | undefined;
};

export type PeoplePluginConfig = {
  peopleDir?: string;
  whatsappDb?: string;
  workPeopleMd?: string;
  selfJid?: string;
};

export function resolvePeopleConfig(input?: PeoplePluginConfig | null): PeopleResolvedConfig {
  const home = os.homedir();
  const peopleDir = input?.peopleDir?.trim()
    ? input.peopleDir.trim()
    : path.join(home, ".openclaw", "workspace", "memory", "people");
  return {
    peopleDir,
    aliasesPath: path.join(peopleDir, "_aliases.json"),
    statePath: path.join(peopleDir, "_state.json"),
    indexPath: path.join(peopleDir, "_index.md"),
    whatsappDb: input?.whatsappDb?.trim()
      ? input.whatsappDb.trim()
      : path.join(home, ".openclaw", "data", "whatsapp-history.db"),
    workPeopleMd: input?.workPeopleMd?.trim()
      ? input.workPeopleMd.trim()
      : path.join(home, ".openclaw", "workspace", "memory", "work", "people.md"),
    selfJid: input?.selfJid?.trim() || undefined,
  };
}
