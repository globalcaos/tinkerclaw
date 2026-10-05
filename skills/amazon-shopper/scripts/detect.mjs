// detect.mjs — classify HTTP responses from amazon.es into OK or BLOCKED:<reason>.

export function classifyResponse({ status, body }) {
  if (status >= 500) return { outcome: "BLOCKED", reason: "rate-limit" };
  if (status >= 400 && status !== 404) return { outcome: "BLOCKED", reason: `http-${status}` };
  if (status !== 200) return { outcome: "BLOCKED", reason: `http-${status}` };

  if (/Enter the characters you see below|Robot Check|To discuss automated access/i.test(body)) {
    return { outcome: "BLOCKED", reason: "captcha" };
  }
  if (/Lo sentimos, ha ocurrido un error|Algo salió mal|Sorry, something went wrong/i.test(body)) {
    return { outcome: "BLOCKED", reason: "amz-error" };
  }
  if (body.length < 5000) {
    return { outcome: "BLOCKED", reason: "suspicious-small-body" };
  }
  if (!/<title>[^<]*Amazon\.es/i.test(body)) {
    return { outcome: "BLOCKED", reason: "title-mismatch" };
  }
  return { outcome: "OK" };
}
