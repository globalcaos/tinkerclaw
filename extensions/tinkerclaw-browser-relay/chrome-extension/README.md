# Tinkerclaw Chrome Extension (Browser Relay)

Purpose: attach the gateway to an existing Chrome tab so it can automate it, via the local CDP
relay server — without launching a separate automated browser.

> **This is the only extension tree.** Until 2026-08-03 a second, stale copy lived at
> `assets/chrome-extension` (v0.1.0, last touched 2026-05-09) and the CLI installed _that_ one,
> so six weeks of relay work here never reached a browser. Its `host_permissions` were limited to
> `127.0.0.1` and `localhost`, meaning it could not relay a real website at all. It has been
> deleted, `bundledExtensionRootDir()` points here, and `fork-integrity.test.ts` now asserts the
> twin stays dead. **Do not re-create a second copy** — see `TINKER_UI_DESIGN_BIBLE/bug-log.md`.

## Dev / load unpacked

1. Run the gateway with browser control enabled.
2. Ensure the relay server is reachable at `http://127.0.0.1:18792/` (default).
3. Install the extension to a stable path:

   ```bash
   openclaw browser extension install
   openclaw browser extension path
   ```

4. Chrome → `chrome://extensions` → enable "Developer mode".
5. "Load unpacked" → select the path printed above.
6. Pin the extension. Click the icon on a tab to attach/detach.

**Linux / Raspberry Pi: always launch with `--password-store=basic`.** Without it Chromium asks the
desktop keyring for its cookie key; on a headless or remote-only box the keyring's unlock prompt is
never answered, so every page spins forever with no error (net-log stops at `COMPUTED_PRIVACY_MODE`).
Google Chrome has no arm64 Linux build: use Debian's `chromium`, loaded with
`--load-extension=<this folder>` (2026-10-20, JarvisPi: eight probes to find this; next time one).

## Options

- `Relay host`: defaults to `127.0.0.1`. Set it to the machine running the gateway when the
  browser lives elsewhere — a LAN address such as `192.168.1.100`, or `127.0.0.1` again if you
  reach it through an SSH tunnel (`ssh -N -L 18792:127.0.0.1:18792 user@host`).
- `Relay port`: defaults to `18792`.
- `Gateway token`: paste `gateway.auth.token` from `~/.openclaw/openclaw.json`. Optional for a
  loopback relay, **required** for any other host — the relay only waives the token for a
  `chrome-extension://` origin arriving over loopback.

### Remote relay

The gateway side must listen beyond loopback for this to work: set the plugin's `bindHost`
(`plugins.entries.tinkerclaw-browser-relay.config.bindHost`) to a LAN address or `0.0.0.0`.
The plugin refuses a non-loopback `bindHost` unless a gateway token is configured, because the
relay is a CDP control channel over the shared tabs. Over an SSH tunnel the relay can stay on
`127.0.0.1` and no `bindHost` change is needed.

Traffic is plain `ws://`. On an untrusted network prefer the SSH tunnel over a LAN bind.

**Gateway on a home server, browser on your laptop (Tailscale).** Bind the relay to the
server's tailnet address only, e.g. `bindHost: "100.64.0.10"`, and put the same address in
the extension's `Relay host`, with the gateway token. Tailscale already encrypts the link
(WireGuard), and nothing outside your tailnet can reach the port. The shared tab works only
while the laptop's Chrome is open: the browser stays where you are, only the agent moves.

## What this version carries

Features that exist only here, and are documented in the bible (§5.81):

- **Per-tab consent** — the relay attaches only to tabs you explicitly opt in, never silently.
- **Tab persistence + auto-reconnect** — survives a service-worker restart (hence the `alarms`
  permission) instead of dropping the attachment.
- **Cross-site `Page.navigate` blocking on shared tabs** — a background job cannot steer a tab you
  shared for something else.
- **Visible human-like cursor** — makes relay-driven interaction legible while it happens.
- **iframe filter** — avoids attaching to every nested frame.

`host_permissions` is `<all_urls>` and permissions include `tabGroups` and `alarms`; the deleted
twin had none of this.

## Local helper: files in their own app, Jarvis's voice on this speaker (2026-10-15)

When the gateway runs on another machine (the Pi), a Tinker page asks this plugin to reach a small
helper on the machine where Chrome runs: file links open with their usual app (PDF viewer,
LibreOffice, editor) and spoken lines play on this speaker. Install once on that machine:

    sh ../native-host/install.sh            # registers com.tinkerclaw.local for this plugin's id

Then reload the plugin in chrome://extensions (it asks for the new "communicate with native
applications" permission). The helper never opens executables, scripts or launchers; a file that
exists only on the gateway's machine is copied to ~/.cache/tinkerclaw-local/ (mode 600) first.
Without the helper the page falls back to showing the file in a browser tab.
