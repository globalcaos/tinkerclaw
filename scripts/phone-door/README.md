# Phone door

**What it is for:** the Jarvis Android app (and a plain phone browser) opens the same Tinker page the laptop opens: same tabs, same chats. The door listens on the tailnet address only, lets nothing through without a device token, and pipes everything else, HTTP and WebSocket, to the loopback `tinker-prod-ui` (127.0.0.1:18793).

**How it works:** a device token arrives as cookie `jarvis_device` or header `X-Jarvis-Device`; when both come, either one may match, so a stale cookie cannot hide a good header. The door keeps only the sha256 in `~/.openclaw/data/phone-door/devices.json` and compares it timing-safe. Before forwarding, it rewrites Host, Origin and Referer to `127.0.0.1:18793`, so prod-ui and the gateway see the laptop's own page, and it removes the device cookie and header. Eight different bad credentials from one address within 10 minutes get a 429 for the rest of that window; one stale token replayed by a reconnect loop counts once, and a valid token is never refused. Logins, pairings, revocations and 429s (one line per address per window) go to `audit.jsonl`. Tokens never do.

**Origin check:** cookies are not port-scoped, so any other web server on the door's IP is "same-site" and its pages get the device cookie. Because the door rewrites Origin to the loopback one, it checks first: a request whose Origin (or, on a write with no Origin, Referer) is not the door's own host gets 403, HTTP and WebSocket alike. Clients that send no Origin, like the app's native node, pass. Even so, run no other web service on the door's IP: whatever listens there receives the device cookie from the phone's browser. On the laptop today a `trip-review` server listens on `0.0.0.0:8740`.

**What would change it:** the gateway getting its own per-device auth, or the phone needing its own tab list (then the door would send an `x-tinker-seat`, as `scripts/hive-door` does).

## Routes

| Route                                                    | Auth          | What                                                                           |
| -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `GET /door/health`                                       | open          | `ok` (the app probes door candidates with it)                                  |
| `GET/POST /door/login`                                   | open          | paste a token, get the cookie, go to `/tinker/`                                |
| `GET /door/pair?code=`, `POST /door/pair`                | one-time code | sets the cookie, offers the APK and the `jarvis://pair?door=&device=&gw=` link |
| `GET /door/whoami`                                       | device        | id, name, last seen                                                            |
| `GET /door/app/latest.json`, `/door/app/<file>.apk`      | device        | from `<dir>/app/`                                                              |
| `GET /door/app/pack.json`, `/door/app/pack-<v>.zip`      | device        | the signed content pack, from `<dir>/app/` (see below)                         |
| `GET /door/app/installed`, `/door/app/pack-installed`    | device        | the app reports a build / a pack outcome; one `audit.jsonl` line each          |
| `GET /trip/`, `/trip/trip.json`, `/trip/trip-state.json` | device        | from `TRIP_DIR` (`~/.openclaw/data/trip`)                                      |
| anything else                                            | device        | proxied to tinker-prod-ui                                                      |

## Run

```bash
node scripts/phone-door/devices.mjs add "the architect Flip6"   # prints the token ONCE and a pairing URL (15 min, one use)
PHONE_DOOR_BIND=100.64.0.20 node scripts/phone-door/door.mjs
```

On the phone, in this order (2026-10-19: the architect's scan gave a blank page because Tailscale was off, then the app asked for its own QR):

1. Turn Tailscale on. The pairing URL is a tailnet address, so without it the page is blank. `tailscale status` on the laptop shows the phone as offline when this is the cause, and `audit.jsonl` has no request from it.
2. Open the pairing URL in the phone's browser, then tap **Download the Jarvis app** and install it.
3. Go back to the browser and tap **Open in Jarvis**. Never use the app's own setup QR scanner: the `jarvis://pair` link is what configures the app.

As a service: copy `phone-door.service` to `~/.config/systemd/user/`, fill in `<node>`, `<repo>` and the bind IP, then `systemctl --user enable --now phone-door`.

Also: `devices.mjs list`, `devices.mjs revoke <id>` (the next request is refused; open WebSockets and open HTTP streams such as the event stream are cut within 5 s), `devices.mjs pair-code <id>` (new pairing URL for a device you already have). The pairing URL's host comes from `--door http://host:port`, `PHONE_DOOR_PUBLIC_URL`, `PHONE_DOOR_BIND`, or `tailscale ip -4`, in that order.

The door will not start without `PHONE_DOOR_BIND`. It takes only an IP address, and it refuses `0.0.0.0`, `::` and their other spellings unless `PHONE_DOOR_ALLOW_ANY=1`; after `listen()` it checks the address it actually got as well.

## Pairing codes and the raw token

The app needs the raw device token, but the door stores only hashes. So a pairing code row in `pair-codes.json` (0600, like `devices.json`) holds the token it will hand out, and that row is deleted when the code is used. While the door runs it also drops expired rows within a minute (and once at start), so a raw token stays on disk about 15 minutes at most, and only for a code nobody has used yet.

Opening the pairing URL does not spend the code. The GET shows a form that posts the code at once by script (a button does it without script), and only that POST pairs. A link preview (WhatsApp Web on the laptop, say) only GETs the URL, so it cannot use up the code before the phone does. `add` puts the new device's token behind its first code. `pair-code` mints a fresh token instead, and it becomes the device's token when the code is used, so re-pairing rotates the device and the old token stops working. Revoking a device deletes its pending codes. Reloading the pair page after the code is spent still works, because the cookie the first visit set is enough to rebuild the page.

The `gw=` part of the deep link is the gateway token, read from `~/.openclaw/openclaw.json` (`gateway.auth.token`) on every pair page. The gateway stays on loopback, so that token only works through the door. The trade-off: `jarvis://` is a custom scheme, and any app on the phone can register it and receive both tokens. A verified https App Link, or the app fetching the gateway token from the door after pairing, would close that; neither is built.

## Content pack (2026-10-23)

What changes on the phone without an APK: `voice-fx.json` (the voice numbers the page and the app share), `main.js` (scripts the app runs in its sandboxed JavaScript engine, which can only call the six phone verbs `buzz`, `say`, `play`, `notify`, `open`, `keepAwake`) and anything else in the pack source, `apps/android/app/src/thirdParty/assets/pack/` (the same folder is the factory pack inside the APK).

- Once per signer machine: `node scripts/phone-door/pack.mjs keygen` writes `~/.config/jarvis-pack/private.pem` (mode 600, never in git) and `public.b64`. The next APK build bakes `public.b64` in; an APK built without it never takes a pack.
- Publish: `bash scripts/phone-door/pack-publish.sh`. It signs the zip (ed25519 over the zip bytes), writes `pack-<version>.zip` and `pack.json` (`{version, file, sha256, size, sig}`) into `<dir>/app/`, sends `jarvis.pack.update` to the phone and waits for the `pack-installed` audit line. Versions only grow (minutes since 2026-01-01, or the last one plus one).
- The app checks size, sha256 and signature, unpacks into its own `files/pack/<version>`, runs the pack's `start` handler and only then switches; a throw there drops the pack and keeps the previous one. It looks for a new pack at start and on every Firebase wake. `jarvis.pack.status` shows the active, previous and refused versions and whether the phone has the JS engine.

## Tests

`node --test scripts/phone-door/door.test.mjs scripts/phone-door/pack.test.mjs`

## Looking at the phone from the host

`scripts/phone-door/phone-look.sh --eval '<js>'` runs JavaScript in the Tinker page on the paired phone and
prints the result; `--shot out.jpg` saves a screenshot; `--eval-file f.js` reads the JS from a file. A UI
change for the phone is checked with it, not with a hand-built script in `/tmp`. Touch handlers can be
exercised by dispatching synthetic `PointerEvent`s (`pointerType:"touch"`) through `--eval`, as long as the
needed view is already on screen: never switch the architect's view to set up a test.
