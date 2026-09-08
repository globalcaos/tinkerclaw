# WordPress REST API Quick Reference

## Endpoints

| Resource | List | Single | Create | Update |
|----------|------|--------|--------|--------|
| Posts | GET posts | GET posts/ID | POST posts | PUT posts/ID |
| Pages | GET pages | GET pages/ID | POST pages | PUT pages/ID |
| Categories | GET categories | GET categories/ID | POST categories | PUT categories/ID |
| Tags | GET tags | GET tags/ID | POST tags | PUT tags/ID |
| Media | GET media | GET media/ID | POST media | PUT media/ID |
| Plugins | GET plugins | GET plugins/SLUG | POST plugins | PUT plugins/SLUG |
| Users | GET users | GET users/ID | — | PUT users/ID |
| Comments | GET comments | GET comments/ID | POST comments | PUT comments/ID |
| Settings | GET settings | — | — | PUT settings |

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
- Generate: Users → Profile → Application Passwords
- Use: HTTP Basic Auth with `username:app-password`
- Spaces in password are optional (accepted both ways)

## Rate Limits

WordPress.com hosted sites may have rate limits. Self-hosted (like HostGator) generally don't, but:
- Batch operations: add 200ms delay between requests
- Media uploads: sequential, not parallel
- Plugin installs: one at a time, wait for completion
