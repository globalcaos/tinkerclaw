import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import { listPluginDoctorLegacyConfigRules } from "../../plugins/doctor-contract-registry.js";
import { getBootstrapChannelPlugin } from "./bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";
import type { ChannelId } from "./types.public.js";

function collectConfiguredChannelIds(raw: unknown): ChannelId[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const channels = (raw as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .map((channelId) => channelId as ChannelId);
}

export function collectChannelLegacyConfigRules(raw?: unknown): LegacyConfigRule[] {
  const channelIds = collectConfiguredChannelIds(raw);
  const rules: LegacyConfigRule[] = [];
  const unresolvedChannelIds: ChannelId[] = [];
  for (const channelId of channelIds) {
    const contractRules = loadBundledChannelDoctorContractApi(channelId)?.legacyConfigRules;
    if (Array.isArray(contractRules) && contractRules.length > 0) {
      rules.push(...contractRules);
      continue;
    }

    const plugin = getBootstrapChannelPlugin(channelId);
    if (plugin?.doctor?.legacyConfigRules?.length) {
      rules.push(...plugin.doctor.legacyConfigRules);
      continue;
    }

    unresolvedChannelIds.push(channelId);
  }
  if (unresolvedChannelIds.length > 0) {
    rules.push(...listPluginDoctorLegacyConfigRules({ pluginIds: unresolvedChannelIds }));
  }

  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.path.join(".")}::${rule.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
