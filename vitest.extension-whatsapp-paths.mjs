import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const whatsAppExtensionIds = ["tinkerclaw-whatsapp"];

export const whatsAppExtensionTestRoots = whatsAppExtensionIds.map((id) => bundledPluginRoot(id));

export function isWhatsAppExtensionRoot(root) {
  return whatsAppExtensionTestRoots.includes(root);
}
