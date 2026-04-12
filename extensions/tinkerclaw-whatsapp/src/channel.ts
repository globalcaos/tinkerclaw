/**
 * FORK: tinkerclaw-whatsapp ChannelPlugin registration.
 *
 * Task 8 scope: provide a valid `whatsappPlugin` export so the plugin
 * manifest resolves and the gateway can register our tinkerclaw-whatsapp
 * channel. The upstream `extensions/whatsapp/src/channel.ts` implementation
 * is ~800 lines and pulls in 20+ supporting files (action-runtime, approval
 * auth, directory-config, group-policy, setup wizard, outbound base, etc).
 *
 * Rather than duplicate that entire graph here, Task 8 re-exports the
 * upstream `whatsappPlugin` so our side-effects (monitor.ts re-wiring,
 * send.ts copy, active-listener registry, reconnect policy, process-message
 * hooks with thinking reaction, auto-reply monitor) all compose with the
 * existing upstream plugin surface.
 *
 * Task 10 will localize the full plugin graph here and remove the
 * re-export.
 *
 * Note: OPENCLAW_WHATSAPP_BACKEND=whatsmeow is the intended runtime mode.
 * The upstream plugin's channel.ts already branches on that flag for
 * inbound, and our send.ts copy uses the in-plugin active-listener
 * registry, so outbound is fork-owned already.
 */

export { whatsappPlugin } from "../../whatsapp/src/channel.js";
