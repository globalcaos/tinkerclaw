import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../config/types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { resolveBundledChannelOwnerDirName } from "./bundled-channel-owner-dir.js";

type BundledChannelDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type BundledChannelDoctorContractApi = {
  legacyConfigRules?: readonly LegacyConfigRule[];
  normalizeCompatibilityConfig?: (params: {
    cfg: OpenClawConfig;
  }) => BundledChannelDoctorCompatibilityMutation;
};

// FORK 2026-10-29: the upstream loop, taking the plugin directory instead of the channel id
// (it was loadBundledChannelPublicArtifact). The owner fallback is the function below.
function loadBundledChannelPublicArtifactFromDir(
  dirName: string,
  artifactBasenames: readonly string[],
): BundledChannelDoctorContractApi | undefined {
  for (const artifactBasename of artifactBasenames) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<BundledChannelDoctorContractApi>({
        dirName,
        artifactBasename,
        installRuntimeDeps: false,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
    }
  }
  return undefined;
}

// FORK 2026-10-29: on a miss, retry in the directory of the bundled plugin that owns the channel.
// The fork ships WhatsApp in extensions/tinkerclaw-whatsapp, so with channels.whatsapp configured
// the direct lookup missed and every config read loaded the whole channel plugin through
// getBootstrapChannelPlugin (3.4-4.8 s of main thread per CLI config read, measured). Same
// `dirName: channelId` pattern, left alone on purpose because resolving would change what they
// return (the first is an auth-bypass surface): src/channels/plugins/gateway-auth-bypass.ts,
// src/media/channel-inbound-roots.ts, src/secrets/channel-contract-api.ts.
function loadBundledChannelPublicArtifact(
  channelId: string,
  artifactBasenames: readonly string[],
): BundledChannelDoctorContractApi | undefined {
  const direct = loadBundledChannelPublicArtifactFromDir(channelId, artifactBasenames);
  if (direct) {
    return direct;
  }
  const ownerDirName = resolveBundledChannelOwnerDirName(channelId);
  if (!ownerDirName || ownerDirName === channelId) {
    return undefined;
  }
  return loadBundledChannelPublicArtifactFromDir(ownerDirName, artifactBasenames);
}

export function loadBundledChannelDoctorContractApi(
  channelId: string,
): BundledChannelDoctorContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["doctor-contract-api.js", "contract-api.js"]);
}
