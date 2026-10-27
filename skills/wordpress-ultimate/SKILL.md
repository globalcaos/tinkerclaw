---
name: wordpress-ultimate
version: 1.4.0
description: "Three env vars. One script. Your agent manages your WordPress site — and cannot quietly change it. Reads are free and new posts land as drafts; anything visitors would see (publishing, editing or trashing live content, uploading media, moderating comments) needs WP_ALLOW_PUBLISH=1 on that call, and plugins, themes, users, settings and any route the script does not know need WP_ALLOW_ADMIN=1. WP_URL is parsed strictly and credentials go only to that HTTPS host (pin it with WP_ALLOWED_HOSTS). Plugin install is code execution on your site and is named as such. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent."
metadata:
  openclaw:
    emoji: "📝"
    notes:
      security: "Full-access WordPress REST client: with a valid application password it can reach any wp/v2 endpoint your user can, including posts, pages, media, comments, users, settings, plugins and themes. Installing or activating a plugin is arbitrary code execution on your site. Every write is gated in scripts/wp.sh: only creating a post/page (forced to draft) or a category/tag is free; every other change to posts, pages, comments, media or terms, and any status=publish/future in the body or query string, needs WP_ALLOW_PUBLISH=1; plugins/themes/users/settings and every unrecognised route need WP_ALLOW_ADMIN=1; permanent delete (force, any truthy spelling) is blocked outright; the _method and rest_route query parameters, which would make WordPress act on a different method or route than the gates checked, are refused, and so is any query key or value or path holding an encoded control character such as %00 (PHP ends a key at NUL). Consent flags are read only from the command's environment, never from an env file. WP_URL is parsed with Python's URL parser: userinfo, query, fragment, backslashes and escaped hosts are refused, and requests go to a URL rebuilt from the parsed host. Credentials come from the environment, the OS keychain (after you run wp.sh --login) or a 0600 env file, and are sent only to that host over HTTPS. The plain-curl fallback writes one 0600 netrc temp file that a trap deletes on exit. Off switch: WP_READONLY=1 blocks every non-GET call."
    requires:
      bins: ["curl", "bash", "python3", "file"]
      env: ["WP_URL", "WP_USER", "WP_APP_PASSWORD"]
    permissions:
      network:
        required: true
        scope: "Outbound HTTPS to the host parsed from $WP_URL only. If WP_ALLOWED_HOSTS is set, that host must be on it; unset, the host from WP_URL is the only one allowed. No third-party endpoint is contacted."
      shell:
        required: true
        scope: "curl or python3 (curl_cffi when installed) for the HTTP request; python3 for URL/JSON parsing; file for the upload MIME type; stat, mktemp and tr for local checks; secret-tool (Linux) or security (macOS) only for --login/--logout and reading the keychain."
      env_read:
        required: true
        scope: "WP_URL, WP_USER, WP_APP_PASSWORD, WP_ALLOWED_HOSTS and the WP_* control flags. Only keys matching WP_[A-Z0-9_]+ are imported from an env file, and WP_ALLOW_* lines in a file are ignored."
      file_read:
        required: true
        scope: "The env file ($WP_ENV_FILE or <skill>/.env; must be non-symlink, owned by you, mode 0600) and any media file you explicitly pass to wp-upload.sh."
      file_write:
        required: false
        scope: "Only in the plain-curl fallback (curl_cffi not installed): one 0600 netrc temp file in $TMPDIR holding the password for that request, deleted by an EXIT/HUP/INT/TERM trap. Nothing else is written."
      credentials:
        required: true
        scope: "Your WordPress application password, from the environment, the OS keychain, or the env file. Sent only to the parsed WP_URL host over HTTPS and never logged. wp.sh --login stores it in the OS keychain; --logout removes it."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

# WordPress Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Let your agent run the whole site — and never wake up to "wait, did that just go live?"

It writes posts, edits pages, sorts tags, and uploads media. Every new piece lands as a **draft**; anything a visitor would see needs an explicit flag on that call, and nothing can be hard-deleted — the worst a flagged call can do is move a post to trash, which you can undo.

Three environment variables and one script is the entire setup. The safety isn't a habit you have to remember — it's the default the code enforces.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

<why_this_matters>
Your AI agent can draft posts, organise tags and prepare pages — and you never wake up to "wait, did that just go live?". New content lands as a **draft**, because `scripts/wp.sh` rewrites the status before the request leaves your machine. Anything visitors would see — publishing, editing or trashing a post, uploading a file, moderating a comment — is **refused** unless that call carries `WP_ALLOW_PUBLISH=1`. Permanent deletes are blocked outright.

This is still a full WordPress REST client. With a valid application password it can reach every `wp/v2` endpoint your user can, and installing a plugin means running someone's code on your site. That is gated behind `WP_ALLOW_ADMIN=1`, together with every route the script does not specifically recognise. The whole map is in **Permissions, Data Flow & Consent** below.
</why_this_matters>

<scope>
Manage WordPress sites through the REST API with draft-by-default safety. Use when the user wants the agent to draft, edit, or organize WordPress content (posts, pages, categories, tags, media) without risking accidental publish or permanent delete. It also reaches the administrative endpoints — plugins, themes, users, settings — which are gated behind an explicit flag rather than removed.
</scope>

<capabilities>
- Draft **posts** and **pages** (new content is forced to draft) and create **categories** and **tags** — no flag needed
- Edit or trash posts/pages, edit terms, upload **media**, write **comments** — with `WP_ALLOW_PUBLISH=1`
- Install, activate and change **plugins**, **themes**, **users**, **settings**, or write to any other `wp/v2` route — with `WP_ALLOW_ADMIN=1`
- Read anything your application password can read, with no flag
- Authenticates via WP Application Passwords over HTTPS
- **One off switch:** `WP_READONLY=1` blocks every non-GET call in both scripts
- **Optional keychain storage:** `scripts/wp.sh --login` moves the application password into your OS keychain; `--logout` clears it
</capabilities>

<setup>
Requires three environment variables. Put them in a `.env` **in the skill's own directory** (never committed, mode 0600), or point `WP_ENV_FILE` at any absolute path — those are the only two files the scripts look at:
```
WP_URL=https://example.com
WP_USER=user@example.com
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
WP_ALLOWED_HOSTS=example.com
```
`WP_URL` must be a plain `https://host[:port][/path]`: user information (`user@`), query strings, fragments, backslashes and percent-escaped hosts are refused. `WP_ALLOWED_HOSTS` is a comma-separated list of exact host names; if you leave it out, the host in `WP_URL` is the only one allowed.

Only keys matching `WP_[A-Z0-9_]+` are imported from the file, and `WP_ALLOW_PUBLISH` / `WP_ALLOW_ADMIN` lines in it are ignored — consent is given per call, in the command's environment.

Run more than one site? `WP_ENV_FILE=/home/you/sites/blog-b.env scripts/wp.sh GET posts`.
</setup>

<core_script>
All REST calls go through `scripts/wp.sh`; media uploads go through `scripts/wp-upload.sh`. Both source `scripts/wp-credentials.sh`, which loads the env file, parses `WP_URL` and resolves the password. `tests/test-safety-gates.sh` exercises the gates without contacting any site.

```bash
# Usage: scripts/wp.sh <GET|POST|PUT|PATCH|DELETE> <endpoint> [json_body]
scripts/wp.sh GET "posts?per_page=5&status=draft,publish"
scripts/wp.sh POST "posts" '{"title":"My Post","content":"<p>Hello</p>"}'     # lands as draft
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT "posts/42" '{"title":"Updated Title"}'  # edits need the flag
```
</core_script>

<safety_rules>
These are enforced in `scripts/wp.sh` and `scripts/wp-upload.sh`, in this order.

1. **The method and route are what WordPress will use.** Only GET, POST, PUT, PATCH and DELETE are accepted. The endpoint is canonicalised (leading/repeated slashes collapsed, percent-decoded, lowercased) before any rule reads it, and `.`/`..` segments and encoded control characters (`%00`, `%0A`, ...) are refused. The query parameters `_method` and `rest_route` are refused, including the encoded, dotted, bracketed and mixed-case spellings PHP folds into those names (`%5fmethod`, `.method`, `_method[]`, `_METHOD`), because WordPress would otherwise act on a different method or route than the gates checked. Any query key or value containing a control character is refused too, because PHP ends a key at NUL (`_method%00=DELETE` would be read as `_method`).
2. **Off switch** — `WP_READONLY=1` refuses every method except GET.
3. **No permanent delete** — a `force` parameter with any value WordPress reads as true (`true`, `1`, `yes`, `on`, …) is refused in the query string or the JSON body, even with a flag.
4. **Free writes** — only `POST posts`, `POST pages` (the body's `status` is rewritten to `draft`) and `POST categories`, `POST tags`.
5. **`WP_ALLOW_PUBLISH=1`** — every other write to `posts/…`, `pages/…`, `comments`, `media`, `categories/…`, `tags/…` (edit, trash, upload, moderate), every `wp-upload.sh` run, and any request on any route whose body or query string sets `status` to `publish` or `future`.
6. **`WP_ALLOW_ADMIN=1`** — any write to `plugins`, `themes`, `users`, `settings`, and to every route not listed above (templates, menus, custom post types, …).
7. **Destination** — `WP_URL` is parsed with Python's URL parser, checked against `WP_ALLOWED_HOSTS`, and the request goes to a URL rebuilt from the parsed host, before the password is resolved.
8. **Credentials** — never passed on a command line. With `curl_cffi` they go to it through the environment of a child process; the plain-curl fallback uses a 0600 netrc temp file removed by an `EXIT/HUP/INT/TERM` trap.

A write body must be a single JSON object, or the call is refused.
</safety_rules>

## Permissions, Data Flow & Consent

**What data it touches.** The post/page content you pass in, the media file you point `wp-upload.sh` at, and whatever the REST API returns (which can include draft content, comments, user records and site settings if you ask for them). Responses are printed to your terminal.

**Where it goes.** One destination: `https://<host from WP_URL>/wp-json/wp/v2/...`. There is no telemetry, no analytics and no other endpoint.

**What it writes to disk.** Only in the plain-curl fallback (when `curl_cffi` is not installed): a 0600 netrc temp file holding the password for the duration of the request, deleted by a trap on exit. No cache, no log, no export file. `wp.sh --login` stores the password in your OS keychain, and only when you run it.

**What credentials it reads.** `WP_USER` and `WP_APP_PASSWORD` — a WordPress Application Password, which you can revoke from your WP profile page at any time — plus `WP_URL`. The password comes from the environment first, then the OS keychain, then the env file (with a warning suggesting `--login`).

**What it needs, and why.**

| Capability | Why | Scope |
| --- | --- | --- |
| Network (HTTPS) | Every operation is a WP REST call | Host parsed from `WP_URL`; must be in `WP_ALLOWED_HOSTS` when set |
| Credential read | Application Password auth | Environment, OS keychain, or `WP_ENV_FILE` / `<skill>/.env` (0600, owned by you) |
| Draft content | Create posts/pages, categories, tags | Free; posts/pages forced to draft |
| Visible content | Publish, edit, trash, upload media, write comments, edit terms | `WP_ALLOW_PUBLISH=1` on that call |
| Site administration | Plugins, themes, users, settings, unrecognised routes | `WP_ALLOW_ADMIN=1` on that call — plugin install is code execution on your site |
| Permanent delete | — | Refused, no flag unlocks it |
| File write | curl fallback authentication | One 0600 netrc temp file, trap-deleted |
| Local commands | HTTP request and parsing | `curl`, `python3`, `file`, `stat`, `mktemp`, `tr`; `secret-tool`/`security` for the keychain |

**The consent steps:**

```bash
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT posts/42 '{"status":"publish"}'           # visitors see this
WP_ALLOW_ADMIN=1   scripts/wp.sh POST plugins '{"slug":"x","status":"active"}'   # runs code on your site
WP_READONLY=1      scripts/wp.sh ...                                            # nothing can change
```

Each flag is per call: it is read from the command's environment and ignored in env files. An agent that wants to publish has to ask you for the flag, which is the moment you get to say no.

**Read it before you run it.** `scripts/wp.sh` is about 265 lines of bash, `scripts/wp-upload.sh` about 135, and `scripts/wp-credentials.sh` about 245. `tests/test-safety-gates.sh` runs every rule above against a throwaway copy of the scripts in dry-run mode and asserts each refusal.

## Changelog

- **1.4.0** — Fixed two gate bypasses: `?_method=` / `?rest_route=` let WordPress act on a different method or route than the gates checked (e.g. `GET posts/42?_method=DELETE&force=true` passed `WP_READONLY`), and `WP_URL=https://allowed@evil` passed the allowlist while the request went to `evil`; `WP_URL` is now parsed strictly and the request URL rebuilt from it. Also closed: publish via query-string `status`, `status=future`, updates via `POST posts/ID`, and `force=yes`/`on`. Uploads, trashing, comments and term edits now need `WP_ALLOW_PUBLISH=1`; unrecognised routes need `WP_ALLOW_ADMIN=1`; consent flags in env files are ignored; query keys, values and paths with encoded control characters (`_method%00=`) are refused.
- **1.3.2** — One shared credential loader with the same symlink/owner/0600 check for both env-file paths; route canonicalisation before gating; no password on argv; `--login` / `--logout`.
- **After 1.0.x** — Publishing and site-admin writes fail closed; the parent-directory `.env` search was removed (set `WP_ENV_FILE` if your env file lived above the skill directory).

## Common Workflows

### Create a Blog Post (Draft)
```bash
scripts/wp.sh POST posts '{
  "title": "My Article Title",
  "content": "<p>Article body in HTML.</p>",
  "categories": [3],
  "tags": [5, 8]
}'
```

### Create a Page (Draft)
```bash
scripts/wp.sh POST pages '{
  "title": "About",
  "content": "<p>About page content.</p>"
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
The uploaded file is public at its `wp-content/uploads` URL as soon as the upload finishes, so it needs the flag:
```bash
WP_ALLOW_PUBLISH=1 scripts/wp-upload.sh /path/to/image.png "Alt text description"
```
Returns the media ID for use in posts (featured_media field).

### Install a Plugin
Installing or activating a plugin runs that plugin's code on your site. Ask the site owner before you pass the flag:
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
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT "posts/42" '{
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
WP_ALLOW_PUBLISH=1 scripts/wp.sh PUT "posts/42" '{"categories": [3, 7]}'
```

<content_formatting>
WordPress REST API accepts HTML in `content` field. For rich posts:

- Use `<h2>`, `<h3>` for headings (not H1 — the title IS H1)
- Use `<p>` for paragraphs
- Use `<!-- wp:heading -->` blocks for Gutenberg compatibility
- Images: upload first via `wp-upload.sh` (needs `WP_ALLOW_PUBLISH=1`), then reference with `<img>` or `<!-- wp:image -->`
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
