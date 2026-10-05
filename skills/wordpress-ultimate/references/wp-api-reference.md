# WordPress REST API Quick Reference

## Endpoints

Which consent flag `scripts/wp.sh` requires for each call. GET is always free. "publish" = `WP_ALLOW_PUBLISH=1`, "admin" = `WP_ALLOW_ADMIN=1`.

| Resource | List / Single | Create | Update | Delete (trash) |
|----------|---------------|--------|--------|----------------|
| Posts | GET posts, posts/ID | POST posts — free, forced to draft | PUT posts/ID — publish | DELETE posts/ID — publish |
| Pages | GET pages, pages/ID | POST pages — free, forced to draft | PUT pages/ID — publish | DELETE pages/ID — publish |
| Categories | GET categories, categories/ID | POST categories — free | PUT categories/ID — publish | needs force, refused |
| Tags | GET tags, tags/ID | POST tags — free | PUT tags/ID — publish | needs force, refused |
| Media | GET media, media/ID | `wp-upload.sh` — publish | PUT media/ID — publish | needs force, refused |
| Comments | GET comments, comments/ID | POST comments — publish | PUT comments/ID — publish | DELETE comments/ID — publish |
| Plugins | GET plugins, plugins/SLUG | POST plugins — admin | PUT plugins/SLUG — admin | admin |
| Users | GET users, users/ID | admin | PUT users/ID — admin | needs force, refused |
| Settings | GET settings | — | PUT settings — admin | — |
| Any other route | GET | admin | admin | admin |

Any write whose body or query string sets `status` to `publish` or `future` also needs publish. `force` (permanent delete) and the `_method` / `rest_route` query parameters are refused.

## Post/Page Fields

| Field | Type | Notes |
|-------|------|-------|
| title | string | Plain text or `{rendered: ""}` object |
| content | string | HTML content |
| excerpt | string | Short summary (HTML) |
| status | string | draft, publish, pending, private, trash |
| slug | string | URL slug |
| categories | int[] | Category IDs |
| tags | int[] | Tag IDs |
| featured_media | int | Media ID for featured image |
| meta | object | Custom fields including Yoast SEO |
| date | string | ISO 8601 publish date |
| sticky | bool | Pin to front page |
| format | string | standard, aside, gallery, link, image, quote, status, video, audio, chat |

## Query Parameters (GET)

| Param | Description | Example |
|-------|-------------|---------|
| per_page | Results per page (max 100) | ?per_page=50 |
| page | Page number | ?page=2 |
| status | Filter by status | ?status=draft,publish |
| categories | Filter by category IDs | ?categories=3,7 |
| tags | Filter by tag IDs | ?tags=5 |
| search | Search term | ?search=token+tracking |
| orderby | Sort field | ?orderby=date |
| order | Sort direction | ?order=desc |
| after | Posts after date (ISO 8601) | ?after=2026-01-01T00:00:00 |
| before | Posts before date | ?before=2026-12-31T23:59:59 |

## Category Fields

| Field | Type | Notes |
|-------|------|-------|
| name | string | Display name |
| slug | string | URL slug |
| description | string | Category description |
| parent | int | Parent category ID (0 = top-level) |

## Tag Fields

| Field | Type | Notes |
|-------|------|-------|
| name | string | Display name |
| slug | string | URL slug |
| description | string | Tag description |

## Media Upload

POST to `/wp-json/wp/v2/media` with:
- Header: `Content-Disposition: attachment; filename="photo.jpg"`
- Header: `Content-Type: image/jpeg`
- Body: raw file bytes

## Plugin Management

Installing or activating a plugin runs its code on the site; every row below except the list needs `WP_ALLOW_ADMIN=1`.

| Action | Method | Endpoint |
|--------|--------|----------|
| List installed | GET | plugins |
| Install + activate | POST | plugins `{"slug":"plugin-name","status":"active"}` |
| Activate | PUT | plugins/folder/file `{"status":"active"}` |
| Deactivate | PUT | plugins/folder/file `{"status":"inactive"}` |

## Yoast SEO Meta Fields

Set via post meta:
```json
{
  "meta": {
    "_yoast_wpseo_title": "%%title%% - %%sitename%%",
    "_yoast_wpseo_metadesc": "Description for search engines",
    "_yoast_wpseo_focuskw": "focus keyword",
    "_yoast_wpseo_canonical": "https://example.com/canonical-url"
  }
}
```

## Authentication

Application Passwords (WordPress 5.6+):
- Generate: Users → Profile → Application Passwords; revoke there too
- Use: HTTP Basic Auth with `username:app-password` over HTTPS
- Spaces in password are optional (accepted both ways)
- Storage: `scripts/wp.sh --login` puts it in the OS keychain; otherwise a 0600 env file owned by you
- The scripts never put it on a command line or in their output

## Rate Limits

WordPress.com hosted sites may have rate limits. Self-hosted (like HostGator) generally don't, but:
- Batch operations: add 200ms delay between requests
- Media uploads: sequential, not parallel
- Plugin installs: one at a time, wait for completion
