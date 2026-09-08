---
name: wordpress-ultimate
version: 1.3.1
description: "Three env vars. One script. Your agent manages your WordPress site — and cannot quietly change it. Reads are free; publishing, editing live content and installing plugins are refused unless you opt in per action (WP_ALLOW_PUBLISH / WP_ALLOW_ADMIN), and every request is checked against a host allowlist before it leaves the machine. Plugin install is code execution on your site and is named as such. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent."
metadata:
  openclaw:
    emoji: "📝"
    notes:
      security: "Full-access WordPress REST client: with a valid application password it can reach any wp/v2 endpoint your user can, including posts, pages, media, comments, users, settings, plugins and themes. Installing or activating a plugin is arbitrary code execution on your site. Credentials are read at runtime from WP_ENV_FILE or the skill's own .env (no parent-directory search) and sent only to WP_URL over HTTPS; nothing is written to disk and no third party is contacted. Four controls are enforced in scripts/wp.sh, not just documented: new posts/pages are forced to draft; going live needs WP_ALLOW_PUBLISH=1; plugin/theme/user/settings writes need WP_ALLOW_ADMIN=1; permanent delete (force=true) is blocked outright. Off switch: WP_READONLY=1 blocks every non-GET call. See the Permissions, Data Flow & Consent section."
    requires:
      bins: ["curl", "jq", "bash", "python3"]
      env: ["WP_URL", "WP_USER", "WP_APP_PASSWORD"]
    # Declared capabilities — narrowly scoped, and each one is used for exactly the
    # reason given. Anything not listed here, the skill does not do.
    permissions:
      network:
        required: true
        scope: "Outbound HTTPS to $WP_URL only. Enforce with WP_ALLOWED_HOSTS; the request is refused before credentials are sent if the host is not on the list. No third-party endpoint is ever contacted."
      shell:
        required: true
        scope: "Runs curl (or curl_cffi via python3) to reach the WordPress REST API. No other external command is invoked."
      env_read:
        required: true
        scope: "WP_URL, WP_USER, WP_APP_PASSWORD, and the WP_* control flags. Only keys matching WP_[A-Z0-9_]+ are imported from an env file; PATH/LD_PRELOAD and friends cannot be injected."
      file_read:
        required: true
        scope: "The credentials file ($WP_ENV_FILE, which must be an absolute, non-symlink, owner-only 0600 file) and any media file you explicitly pass to wp-upload.sh."
      file_write:
        required: false
        scope: "None. Nothing is persisted to disk."
      credentials:
        required: true
        scope: "Your WordPress application password. Read at runtime, sent only to the allowlisted WP_URL over HTTPS, never logged and never stored."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

# WordPress Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Let your agent run the whole site — and never wake up to "wait, did that just go live?"

It writes posts, edits pages, sorts tags, and uploads media. Every new piece lands as a **draft**; going live takes an explicit, confirmed publish, and nothing can be hard-deleted — the worst it can do is move a post to trash, which you can undo.

Three environment variables and one script is the entire setup. The safety isn't a habit you have to remember — it's the default the code enforces.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

<why_this_matters>
Your AI agent can run your whole WordPress site — write posts, edit pages, sort tags, upload media — and you never wake up to "wait, did that just go live?". New content lands as a **draft**, every time, because `scripts/wp.sh` rewrites the status before the request leaves your machine. Going live is not a habit you have to remember either: publishing is **refused** unless you pass `WP_ALLOW_PUBLISH=1` for that call. And nothing can be permanently destroyed — `force=true` deletes are blocked in the query string and in the JSON body, so the worst the agent can do is move a post to **trash**, which you can undo.

Be clear-eyed about the other half: this is a full WordPress REST client. With a valid application password it can reach every `wp/v2` endpoint your user can, and installing a plugin means running someone's code on your site. That capability is real, it is useful, and it is gated behind `WP_ALLOW_ADMIN=1` rather than hidden. The whole map is in **Permissions, Data Flow & Consent** below.
</why_this_matters>

<scope>
Manage WordPress sites through the REST API with draft-by-default safety. Use when the user wants the agent to draft, edit, or organize WordPress content (posts, pages, categories, tags, media) without risking accidental publish or permanent delete. It also reaches the administrative endpoints — plugins, themes, users, settings — which are gated behind an explicit flag rather than removed.
</scope>

<capabilities>
- Draft, edit, and organize **posts** and **pages** (new content is forced to draft)
- Manage **categories** and **tags** — create, list, assign
- Upload **media** and reference it as featured images or inline
- Read and write **comments**, and read **users** and **settings**
- Install, activate and list **plugins** and **themes**, and write users/settings — gated behind `WP_ALLOW_ADMIN=1`
- Reach **any other `wp/v2` endpoint** your application password is authorized for; `wp.sh` is a generic wrapper, not a fixed menu
- Authenticates via WP Application Passwords over HTTPS — credentials read from a pinned `.env` at runtime, never hardcoded, never written anywhere
- **Four enforced safety rails:** draft-by-default on create · publish gated · site-admin writes gated · permanent delete blocked
- **One off switch:** `WP_READONLY=1` blocks every non-GET call in both scripts
</capabilities>

<setup>
Requires three environment variables. Put them in a `.env` **in the skill's own directory** (never committed), or point `WP_ENV_FILE` at any file you like — those are the only two places the scripts look:
```
WP_URL=https://example.com
WP_USER=user@example.com
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
```
Recommended, and worth the ten seconds — refuse to send that password anywhere unexpected:
```
WP_ALLOWED_HOSTS=example.com
```
Only keys matching `WP_[A-Z0-9_]+` are imported from the file. Anything else in it is ignored, so a stray `PATH=` line cannot alter how the scripts run.

Run more than one site? `WP_ENV_FILE=~/sites/blog-b.env scripts/wp.sh GET posts`.
</setup>

<core_script>
All operations go through `scripts/wp.sh`. It wraps curl with auth, JSON handling, and the safety gates below. Media uploads go through `scripts/wp-upload.sh`. Those two files are the entire package — there is nothing else to install.

```bash
# Usage: scripts/wp.sh <method> <endpoint> [json_body]
# Examples:
scripts/wp.sh GET "posts?per_page=5&status=draft,publish"
scripts/wp.sh POST "posts" '{"title":"My Post","content":"<p>Hello</p>","status":"draft"}'
scripts/wp.sh PUT "posts/42" '{"title":"Updated Title"}'

# Publishing is refused without the flag — that refusal is the consent step:
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT "posts/42" '{"status":"publish"}'
```
</core_script>

<safety_rules>
These are enforced in `scripts/wp.sh`. They are not conventions you have to follow.

1. **Draft by default** — `POST posts` / `POST pages` has `status: draft` written into the body before sending.
2. **Publishing needs consent** — any create or update carrying `"status":"publish"` exits with an error unless the call is made with `WP_ALLOW_PUBLISH=1`. Confirm with the site owner first; that is what the flag means.
3. **Site administration needs consent** — non-GET on `plugins`, `themes`, `users` or `settings` exits with an error unless `WP_ALLOW_ADMIN=1`. Reading them is always allowed.
4. **No permanent delete** — `force=true` / `force=1` is blocked whether it appears in the query string or the JSON body. Plain `DELETE posts/ID` moves the post to trash and is recoverable. (`PUT posts/ID '{"status":"trash"}'` also works on most installs, but some WooCommerce/SureCart sites reject it with `rest_invalid_param` — that is why plain DELETE stays available.)
5. **Credentials** — read at runtime from `WP_ENV_FILE` or the skill's own `.env`. Never hardcoded in commands, never logged, never written to disk by these scripts.

**Off switch:** `WP_READONLY=1` — set it in your shell or your `.env` and both scripts refuse every method except GET.
</safety_rules>

## Permissions, Data Flow & Consent

Short version: your content and your application password go to your own WordPress site over HTTPS, and nowhere else. Nothing is stored on disk, and no third party is involved. Longer version, because you should not have to take that on trust:

**What data it touches.** The post/page content you pass in, the media file you point `wp-upload.sh` at, and whatever the REST API returns (which can include draft content, comments, user records and site settings if you ask for them). All of it stays in memory and is printed to your terminal.

**Where it goes.** Exactly one destination: `${WP_URL}/wp-json/wp/v2/...`. There is no telemetry, no analytics, no vendor API, no upload of your content anywhere else. Set `WP_ALLOWED_HOSTS` and the scripts will refuse to run if `WP_URL` is ever changed to a host you did not list.

**What it writes to disk.** Nothing. No cache, no log, no export file. The only file either script reads is your env file.

**What credentials it reads.** `WP_USER` and `WP_APP_PASSWORD` — a WordPress Application Password, which you can revoke from your WP profile page at any time — plus `WP_URL`, from `WP_ENV_FILE` or `<skill>/.env`. Earlier versions walked up five parent directories looking for any `.env`; that is gone, because whichever file was found first became authoritative for where your password was sent.

**What it needs, and why.**

| Capability | Why | Scope |
| --- | --- | --- |
| Network (HTTPS) | Every operation is a WP REST call | `WP_URL` only; enforceable with `WP_ALLOWED_HOSTS` |
| Credential read | Application Password auth | `WP_ENV_FILE` or `<skill>/.env`; only `WP_*` keys imported |
| Content write | Create/update posts, pages, terms, media | Forced to draft on create; publish needs `WP_ALLOW_PUBLISH=1` |
| Media upload | Send a local file to the media library | The one file path you pass to `wp-upload.sh` |
| Site administration | Install/activate plugins and themes, write users and settings | Blocked unless `WP_ALLOW_ADMIN=1` — this is code execution on your site |
| Delete | Move content to trash | `force=true` blocked; trash is recoverable |
| File write | **None.** Neither script writes to disk | — |
| Local shell exec | `curl` and `python3` for the HTTP request itself | No other commands are run |

**The consent steps, and what each one is protecting you from:**

```bash
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT posts/42 '{"status":"publish"}'   # this becomes public
WP_ALLOW_ADMIN=1   scripts/wp.sh POST plugins '{"slug":"x","status":"active"}'  # this runs code on your site
WP_READONLY=1      scripts/wp.sh ...                                    # nothing can change anything
```

Each flag is per-call by design. An agent that wants to publish has to ask you for the flag, which is the moment you get to say no.

**Read it before you run it.** `scripts/wp.sh` is about 150 lines of bash and `scripts/wp-upload.sh` about 135. Every rule above is visible in them under a `SAFETY:` or `OFF SWITCH` comment. That is the whole security model: short enough to audit over a coffee.

### Upgrading from 1.0.x

Two behaviour changes, both deliberate: publishing and plugin/theme/user/settings writes now **fail closed** until you pass `WP_ALLOW_PUBLISH=1` or `WP_ALLOW_ADMIN=1`, and the `.env` parent-directory search is gone — if your env file lived above the skill directory, set `WP_ENV_FILE` to its path (or put `WP_ALLOW_PUBLISH=1` in the env file itself if a scripted publishing flow needs it standing).

## Common Workflows

### Create a Blog Post (Draft)
```bash
scripts/wp.sh POST posts '{
  "title": "My Article Title",
  "content": "<p>Article body in HTML.</p>",
  "status": "draft",
  "categories": [3],
  "tags": [5, 8]
}'
```

### Create a Page (Draft)
```bash
scripts/wp.sh POST pages '{
  "title": "About",
  "content": "<p>About page content.</p>",
  "status": "draft"
}'
```

### Publish a Draft (needs consent)
```bash
# 1. Show the owner what is about to go live
scripts/wp.sh GET "posts/42?context=edit"
# 2. Only after they say yes:
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT "posts/42" '{"status":"publish"}'
```

### List Posts
```bash
scripts/wp.sh GET "posts?per_page=20&status=draft,publish&orderby=date&order=desc"
```

### Create a Category
```bash
scripts/wp.sh POST categories '{"name": "AI & Agents", "slug": "ai-agents", "description": "Posts about AI agent development"}'
```

### Create a Tag
```bash
scripts/wp.sh POST tags '{"name": "OpenClaw", "slug": "openclaw"}'
```

### Upload Media
Use `scripts/wp-upload.sh` for media uploads:
```bash
scripts/wp-upload.sh /path/to/image.png "Alt text description"
```
Returns the media ID for use in posts (featured_media field).

### Install a Plugin
Installing or activating a plugin runs that plugin's code on your site, so it fails closed. Ask the site owner before you pass the flag:
```bash
WP_ALLOW_ADMIN=1 scripts/wp.sh POST plugins '{"slug": "plugin-slug", "status": "active"}'
```

### List Plugins
```bash
scripts/wp.sh GET plugins
```

### Update Yoast SEO Metadata
Only works if those meta keys are exposed to the REST API. Yoast does **not** register `_yoast_wpseo_title` / `_yoast_wpseo_metadesc` with `show_in_rest` by default, so on a stock install WordPress will accept the request and silently ignore the meta. Register them in your theme (or use a plugin that does) before relying on this; `yoast_head_json` on a GET is read-only.
```bash
scripts/wp.sh PUT "posts/42" '{
  "meta": {
    "_yoast_wpseo_title": "SEO Title Here",
    "_yoast_wpseo_metadesc": "Meta description for search engines."
  }
}'
```

### Manage Categories and Tags
```bash
# List categories
scripts/wp.sh GET categories
# List tags  
scripts/wp.sh GET tags
# Assign post to categories (by ID)
scripts/wp.sh PUT "posts/42" '{"categories": [3, 7]}'
```

<content_formatting>
WordPress REST API accepts HTML in `content` field. For rich posts:

- Use `<h2>`, `<h3>` for headings (not H1 — the title IS H1)
- Use `<p>` for paragraphs
- Use `<!-- wp:heading -->` blocks for Gutenberg compatibility
- Images: upload first via `wp-upload.sh`, then reference with `<img>` or `<!-- wp:image -->`
</content_formatting>

## Gutenberg Block Format

For full Gutenberg compatibility, wrap content in block comments:
```html
<!-- wp:paragraph -->
<p>Text here.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Section Title</h2>
<!-- /wp:heading -->

<!-- wp:image {"id":123} -->
<figure class="wp-block-image"><img src="URL" alt="desc"/></figure>
<!-- /wp:image -->
```

<error_handling>
- 401 — check WP_USER and WP_APP_PASSWORD
- 403 — application password may lack required capabilities
- 404 — check WP_URL and endpoint path
- `rest_cannot_create` — may need to enable REST API or check user role
</error_handling>

## Reference

For full WP REST API endpoint details, see `references/wp-api-reference.md`.
For SEO optimization patterns, see `references/seo-patterns.md`.

## Pairs Well With

- [coding-agent](https://clawhub.ai/globalcaos/coding-agent) — generate content with sub-agents, publish it with wordpress-ultimate
- [outlook-hack](https://clawhub.ai/globalcaos/outlook-hack) — same browser-relay philosophy applied to Microsoft; this one covers your blog

https://github.com/globalcaos/tinkerclaw

_Clone it. Fork it. Break it. Make it yours._

---

## Credits

Created by Oscar Serra with the help of Claude (Anthropic).

*Built after the third time of hand-copying blog posts from a terminal. Never again.*
