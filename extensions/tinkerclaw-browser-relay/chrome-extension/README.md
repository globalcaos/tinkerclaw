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

## Options

- `Relay port`: defaults to `18792`.

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
