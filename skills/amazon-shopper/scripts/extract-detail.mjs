// extract-detail.mjs — parse a /dp/<ASIN>/ detail page into a spec-hint blob.

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s) {
  return decodeHtml(
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function extractBullets(html) {
  const m = html.match(/<div[^>]*id="feature-bullets"[\s\S]*?<\/div>/);
  if (!m) return [];
  const block = m[0];
  const out = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRe.exec(block)) !== null) {
    const text = stripTags(liMatch[1]);
    if (text && !/Ver más/i.test(text)) out.push(text);
  }
  return out;
}

function extractDetailTable(html) {
  const rows = {};
  const techRe = /<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g;
  let m;
  while ((m = techRe.exec(html)) !== null) {
    const k = stripTags(m[1]).toLowerCase();
    const v = stripTags(m[2]);
    if (k && v && k.length < 60) rows[k] = v;
  }
  const dbRe = /<span class="a-text-bold">\s*([^<:]+):?\s*<\/span>\s*<span>\s*([^<]+)<\/span>/g;
  while ((m = dbRe.exec(html)) !== null) {
    const k = stripTags(m[1]).toLowerCase();
    const v = stripTags(m[2]);
    if (k && v && k.length < 60 && !(k in rows)) rows[k] = v;
  }
  return rows;
}

function parseSpanishNumber(s) {
  if (!s) return null;
  const cleaned = String(s)
    .replace(/\./g, "")
    .replace(",", ".")
    .match(/[0-9]+(\.[0-9]+)?/);
  return cleaned ? Number(cleaned[0]) : null;
}

function inferWeightKg(detailRows, bullets) {
  const candidates = [];
  for (const [k, v] of Object.entries(detailRows)) {
    if (/peso|weight|kilogr|\bkg\b/i.test(k)) candidates.push(v);
  }
  for (const b of bullets) {
    const m = b.match(/([0-9]+(?:[,.]?[0-9]+)?)\s*kg\b/i);
    if (m) candidates.push(m[1] + " kg");
  }
  for (const c of candidates) {
    const n = parseSpanishNumber(c);
    if (n && n > 0 && n < 1000) return n;
  }
  return null;
}

export function extractDetailSpec(html) {
  const bullets = extractBullets(html);
  const rows = extractDetailTable(html);
  const titleMatch = html.match(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/);
  const title = titleMatch ? stripTags(titleMatch[1]) : null;
  const brand = rows["marca"] || rows["brand"] || rows["fabricante"] || null;
  const weight_kg = inferWeightKg(rows, bullets);

  return {
    title,
    brand,
    weight_kg,
    bullets,
    detail_rows: rows,
    combined_text: [
      title ? `Title: ${title}` : "",
      brand ? `Brand: ${brand}` : "",
      bullets.length ? `Bullets:\n- ${bullets.join("\n- ")}` : "",
      Object.keys(rows).length
        ? `Details:\n${Object.entries(rows)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
