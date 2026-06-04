/**
 * FORK 2026-06-04 (Browser Relay upgrade): the browser-context bootstrap that
 * (re)injects the persistent Jarvis affordances into a shared tab:
 *   - the persistent cursor      [data-tinkerclaw-cursor]
 *   - the shared-tab frame + pill [data-tinkerclaw-shared]
 *
 * Lives in its own module so BOTH consumers can import it without a circular
 * dependency:
 *   - pw-session.ts        registers it via page.addInitScript (survives
 *                          navigation/reload — runs on every fresh document)
 *   - pw-tools-core.interactions.ts  re-runs it via page.evaluate to cover the
 *                          already-loaded current document (addInitScript does
 *                          not retroactively touch it) and after a screenshot
 *                          strip/restore.
 *
 * Written as a self-invoking function-body string so it can be passed to both
 * page.addInitScript(script) and page.evaluate(script). Idempotent: it no-ops
 * when the elements already exist. Both affordances are pointer-events:none and
 * sit BELOW the transient click ring (z-index 2147483646) so they never eat a
 * click, and are stripped before page.screenshot so they don't pollute it.
 */
export const TINKERCLAW_OVERLAY_BOOTSTRAP = `(${function injectTinkerclawOverlays() {
  try {
    const doc = document;
    if (!doc || !doc.documentElement) return;
    const SHARED_Z = 2147483640;
    const CURSOR_Z = 2147483645;
    // Shared-tab frame: full-viewport outline + corner pill. Always-on while the
    // tab is shared (the relay only ever drives shared tabs).
    if (!doc.querySelector("[data-tinkerclaw-shared='frame']")) {
      const frame = doc.createElement("div");
      frame.setAttribute("data-tinkerclaw-shared", "frame");
      frame.style.cssText = [
        "position: fixed",
        "inset: 0",
        "border: 3px solid rgba(255,140,0,0.85)",
        "box-sizing: border-box",
        "box-shadow: inset 0 0 0 1px rgba(255,140,0,0.35)",
        "z-index: " + SHARED_Z,
        "pointer-events: none",
      ].join("; ");
      const pill = doc.createElement("div");
      pill.setAttribute("data-tinkerclaw-shared", "pill");
      pill.textContent = "👁 Shared with Jarvis";
      pill.style.cssText = [
        "position: fixed",
        "top: 8px",
        "right: 8px",
        "padding: 3px 9px",
        "background: rgba(255,140,0,0.92)",
        "color: #1a1a1a",
        "font: 600 12px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        "border-radius: 10px",
        "box-shadow: 0 1px 3px rgba(0,0,0,0.35)",
        "letter-spacing: 0.2px",
        "z-index: " + CURSOR_Z,
        "pointer-events: none",
      ].join("; ");
      doc.documentElement.appendChild(frame);
      doc.documentElement.appendChild(pill);
    }
    // Persistent cursor: a single pointer DOM element that the agent tweens.
    if (!doc.querySelector("[data-tinkerclaw-cursor]")) {
      const cursor = doc.createElement("div");
      cursor.setAttribute("data-tinkerclaw-cursor", "1");
      cursor.style.cssText = [
        "position: fixed",
        "left: 0px",
        "top: 0px",
        "width: 0",
        "height: 0",
        "border-left: 9px solid transparent",
        "border-right: 9px solid transparent",
        "border-top: 15px solid #ff8c00",
        "transform: rotate(-25deg) translate(-2px,-1px)",
        "transform-origin: top left",
        "z-index: " + CURSOR_Z,
        "pointer-events: none",
        "filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
        "transition: opacity 120ms linear",
        "will-change: left, top",
      ].join("; ");
      doc.documentElement.appendChild(cursor);
    }
  } catch (_e) {
    // best-effort visual; never throw into page context
  }
}.toString()})();`;
