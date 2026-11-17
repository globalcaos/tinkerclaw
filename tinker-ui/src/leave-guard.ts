// FORK 2026-11-12: the Tinker page is never replaced by a link.
//
// The rule: every link shown in the page opens in a new tab. The page is a single-page app: when a
// link loads in its place, the live chat, the open panels and the runs in flight are gone, and the
// only way back is the browser's Back button and a full reload.
//
// How it got here: md-links.ts marks every link the markdown renderer writes with target="_blank",
// and for five months that was the whole defence. It does not cover a link that reaches the page
// another way (raw HTML in a rendered card, a handler that takes the click, a script that sets
// location). On 2026-11-12 a handler written for the phone took a click on a desktop page and laid
// a reader over the whole chat with no way to close it; the page was left twice with Back.
//
// So the rule is enforced here, at the moment of leaving, whatever produced the link:
//   1. a click on a link that would load in this tab is sent to a new tab instead;
//   2. a navigation started by script or by a form is stopped (where the browser lets a page stop it);
//   3. leaving a desktop page in any way that was not planned (Back, closing the tab, typing an address)
//      asks first, with the browser's own "Leave site?" question. Planned leaves say so beforehand
//      (allowLeave): the page's own reload, the sign-in page, a reload from the keyboard.
// Each time 1 or 2 acts, a bug is logged with the evidence, a notice says so on screen, and a fix is
// asked for (at most once per cause in 12 hours), because the guard acting means some code broke the rule.
//
// What would change it: a part of the app that must load in this tab (add its path to `appBase`
// handling below, never weaken the click rule), or a browser without the Navigation API (2 is then
// off; 1 and 3 still hold). The browser tells a page that Back was pressed only after it has asked
// the page whether it may leave, so 3 cannot single out Back: it asks for every unplanned leave.

let leaveAllowedUntil = 0;
/** A planned leave of the page is about to start: the question in rule 3 is skipped for `ms`. */
export function allowLeave(ms = 5000): void {
  leaveAllowedUntil = Date.now() + ms;
}

/** The cure at the source, for HTML that did not come through the markdown renderer (a rendered card):
 *  a cleaner hook that marks every link that loads a page for a new tab. In-page anchors ("#...") stay. */
export function markLinkForNewTab(node: unknown): void {
  const el = node as Element;
  if (!el || el.nodeType !== 1 || el.tagName !== "A") return;
  const href = el.getAttribute("href");
  if (!href || href.trim().startsWith("#")) return;
  el.setAttribute("target", "_blank");
  el.setAttribute("rel", "noopener noreferrer");
}

/** What a click carries that decides where the browser would load the link. */
export type ClickFacts = {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

/** The parts of a link that decide where it loads. `rawHref` is the attribute as written. */
export type LinkFacts = { rawHref: string; href: string; target: string; download: boolean };

/** Would following this link, with this click, load it in place of the page at `here`? */
export function linkReplacesPage(link: LinkFacts, click: ClickFacts, here: string): boolean {
  if (click.defaultPrevented) return false; // some handler already took the click
  if (click.button !== 0 || click.ctrlKey || click.metaKey || click.shiftKey || click.altKey)
    return false; // the browser opens these elsewhere itself
  if (link.download) return false;
  const raw = link.rawHref.trim();
  if (!raw || raw.startsWith("#")) return false;
  const target = link.target.trim().toLowerCase();
  if (target && target !== "_self" && target !== "_top" && target !== "_parent") return false; // _blank or a named window
  let to: URL, from: URL;
  try {
    to = new URL(link.href, here);
    from = new URL(here);
  } catch {
    return false;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return false; // mailto:, tel:, javascript: leave the page where it is
  if (to.origin === from.origin && to.pathname === from.pathname && to.search === from.search)
    return false; // same document, another anchor
  return true;
}

/** What the browser says about a navigation of this page (the Navigation API's navigate event). */
export type NavFacts = {
  navigationType: string; // "push" | "replace" | "reload" | "traverse"
  sameDocument: boolean;
  hashChange: boolean;
  download: boolean;
  url: string;
};

/** "stay": the page is not left. "stop": a script or a form is replacing the page. "planned": the page's own
 *  reload or one of the app's own pages. "unplanned": Back or Forward (the browser will not let a page stop those). */
export function navigationVerdict(
  nav: NavFacts,
  here: string,
  appBase: string,
  hostOpensOtherSites = false,
): "stay" | "stop" | "planned" | "unplanned" {
  if (nav.sameDocument || nav.hashChange || nav.download) return "stay";
  if (nav.navigationType === "reload") return "planned"; // a reload comes back to this page
  if (nav.navigationType === "traverse") return "unplanned";
  let to: URL, from: URL;
  try {
    to = new URL(nav.url, here);
    from = new URL(here);
  } catch {
    return "stay";
  }
  // The app's own pages (sign-in and back) load in this tab on purpose.
  if (to.origin === from.origin && to.pathname.startsWith(appBase)) return "planned";
  // The Jarvis phone app's WebView has no tabs: it loads a new-tab link here first, then hands any
  // other site to the phone's browser before the page changes (TinkerScreen.kt shouldOverrideUrlLoading).
  if (hostOpensOtherSites && to.origin !== from.origin) return "stay";
  return "stop";
}

/** One cause of a leave, short and stable, so the same fault asks for a fix once and not at every click. */
export function causeSignature(kind: string, url: string): string {
  try {
    const u = new URL(url);
    return `${kind}:${u.origin}${u.pathname.replace(/\/[^/]*$/, "/")}`;
  } catch {
    return `${kind}:${url.slice(0, 80)}`;
  }
}

const FIX_EVERY_MS = 12 * 3600_000;
const FIX_KEY = "tinker.leaveGuard.fixAsked";

/** True when no fix was asked for this cause in the last 12 hours; records the ask. */
export function fixDue(
  signature: string,
  now: number,
  store: Pick<Storage, "getItem" | "setItem">,
): boolean {
  let asked: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(store.getItem(FIX_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") asked = parsed as Record<string, number>;
  } catch {
    asked = {};
  }
  for (const k of Object.keys(asked)) if (now - asked[k] > FIX_EVERY_MS) delete asked[k];
  if (signature in asked) return false;
  asked[signature] = now;
  try {
    store.setItem(FIX_KEY, JSON.stringify(asked));
  } catch {
    // storage blocked: the fix is asked for again at the next leave, which is the safer fault
  }
  return true;
}

export type LeaveReport = {
  kind: "page-leave";
  headline: string;
  how: "link" | "script" | "asked";
  url: string;
  element: string | null; // the link as written, cut short
  inside: string | null; // what part of the page held it
  page: string;
  sessionKey: string | null;
  at: string;
  trace?: LeaveTrace; // a script or form leave only: what can name its source
};

/**
 * FORK 2026-11-12 — who started a navigation no link click explains. The first report of this kind (a
 * script navigation to an address written in a chat reply) named the address and nothing else, so its
 * cause could not be found from the file. The navigate event runs inside the call that started the
 * navigation, so the stack taken there names the script; the browser also says whether a person
 * started it and from which element.
 */
export type LeaveTrace = {
  userInitiated: boolean;
  form: boolean; // a form was submitted
  source: string | null; // the element the browser names as the source, cut short
  lastClick: string | null; // the last element clicked, when that was under 5 s before
  lastClickAgoMs: number | null;
  framed: boolean; // this page runs inside another page
  stack: string | null; // the script frames that started it, without the guard's own
  // 2026-11-16: which browser it happened in. A report of a new-tab link clicked by a person could not
  // say whether it came from the phone app (whose WebView has no tabs) or from a desktop browser.
  browser: string | null;
};

export function leaveTrace(
  nav: {
    userInitiated?: boolean;
    formData?: unknown;
    sourceElement?: { outerHTML?: string } | null;
  },
  lastClick: { html: string; at: number } | null,
  now: number,
  stack: string | undefined,
  framed: boolean,
  userAgent?: string,
): LeaveTrace {
  const ago = lastClick ? now - lastClick.at : null;
  const recent = ago !== null && ago >= 0 && ago < 5000;
  const frames = (stack ?? "")
    .split("\n")
    .slice(1)
    .filter((l) => l.trim() && !l.includes("leave-guard") && !l.includes("onNavigate"));
  return {
    userInitiated: nav.userInitiated === true,
    form: nav.formData !== null && nav.formData !== undefined,
    source: nav.sourceElement?.outerHTML ? nav.sourceElement.outerHTML.slice(0, 400) : null,
    lastClick: recent && lastClick ? lastClick.html.slice(0, 400) : null,
    lastClickAgoMs: recent ? ago : null,
    framed,
    stack: frames.length ? frames.slice(0, 12).join("\n").slice(0, 1500) : null,
    browser: userAgent ? userAgent.slice(0, 300) : null,
  };
}

export type LeaveGuardDeps = {
  win: Window;
  doc: Document;
  appBase: string;
  /** Rule 3 applies (a desktop layout). On the phone, Back is the app's own key and must not be asked about. */
  askOnLeave: () => boolean;
  /** The chat on screen, which gets the request for a fix. */
  sessionKey: () => string | null;
  /** Files the report; resolves to the file's path. */
  report: (r: LeaveReport) => Promise<string>;
  /** Says it on screen until dismissed; `url` adds a link that opens it in a new tab. */
  notify: (text: string, url: string | null) => void;
  /** Asks the chat for a fix (an agent prompt, named as the guard's). */
  askFix: (sessionKey: string, text: string) => Promise<void>;
};

/** What held the link: the nearest named ancestor, for the report. */
function holder(el: Element): string | null {
  const box = el.closest("[data-message-id], .chat-html-inline, .msg, [id]");
  if (!box) return null;
  const id = box.getAttribute("data-message-id") ?? box.id;
  return `${box.tagName.toLowerCase()}${id ? `#${id}` : ""}${box.className && typeof box.className === "string" ? `.${box.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`;
}

export function installLeaveGuard(deps: LeaveGuardDeps): () => void {
  const { win, doc } = deps;
  let lastHandled = { url: "", at: 0 };
  let lastClick: { html: string; at: number } | null = null;
  const inJarvisApp = /\bJarvisApp\//.test(win.navigator?.userAgent ?? "");

  const acted = (
    how: LeaveReport["how"],
    url: string,
    el: Element | null,
    opened: boolean,
    trace?: LeaveTrace,
  ): void => {
    lastHandled = { url, at: Date.now() };
    const sessionKey = deps.sessionKey();
    const report: LeaveReport = {
      kind: "page-leave",
      headline:
        how === "link"
          ? "A link would have replaced the Tinker page; it was sent to a new tab"
          : how === "script"
            ? "A script or form tried to replace the Tinker page; it was stopped"
            : "The Tinker page was about to be left; the browser asked first",
      how,
      url,
      element: el ? el.outerHTML.slice(0, 600) : null,
      inside: el ? holder(el) : null,
      page: win.location.href,
      sessionKey,
      at: new Date().toISOString(),
      ...(trace ? { trace } : {}),
    };
    if (how !== "asked") {
      deps.notify(
        how === "link"
          ? "A link tried to replace this page. I opened it in a new tab. The fault is logged and a fix is requested."
          : "Something tried to replace this page. I stopped it. The fault is logged and a fix is requested.",
        opened ? null : url,
      );
    }
    void deps
      .report(report)
      .catch((err) => {
        console.error("[leave-guard] report failed", err, report);
        return "(the report could not be written)";
      })
      .then((path) => {
        if (how === "asked" || !sessionKey) return;
        if (!fixDue(causeSignature(how, url), Date.now(), win.localStorage)) return;
        const what =
          how === "link"
            ? `a link without a new-tab mark was clicked: ${report.element ?? url}`
            : `a script or a form started a navigation to ${url}` +
              (trace
                ? ` (started by a person: ${trace.userInitiated ? "yes" : "no"}; last click: ${trace.lastClick ?? "none in 5 s"}; script: ${trace.stack ?? "no script frame"})`
                : "");
        return deps.askFix(
          sessionKey,
          `⟦AGENT:🛡 Leave guard · a link tried to replace the page⟧ The Tinker page's leave guard acted: ${what}. ` +
            `Held in: ${report.inside ?? "unknown"}. The rule is that every link opens in a new tab and nothing replaces the page (tinker-ui/src/leave-guard.ts). ` +
            `The guard sent it to a new tab or stopped it, so nothing was lost. Evidence: ${path}. ` +
            `Find what produced this link or navigation without the new-tab mark, fix that cause in tinker-ui so the guard has nothing to do, add a test, ` +
            `and tell the owner in plain words what it was. If the cause is text an agent wrote into a chat (a raw link in an HTML card), say so and fix the rendering, not the chat.`,
        );
      })
      .catch((err) => console.error("[leave-guard] fix request failed", err));
  };

  // 1. A click on a link that would load in this tab: mark it for a new tab and let the click go on.
  const onClick = (e: MouseEvent): void => {
    const hit = e.target as Element | null;
    if (hit?.outerHTML) lastClick = { html: hit.outerHTML, at: Date.now() };
    const a = hit?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.ownerDocument !== doc) return;
    const leaves = linkReplacesPage(
      {
        rawHref: a.getAttribute("href") ?? "",
        href: a.href,
        target: a.target,
        download: a.hasAttribute("download"),
      },
      e,
      win.location.href,
    );
    if (!leaves) return;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    acted("link", a.href, a, true);
  };
  doc.addEventListener("click", onClick, true);

  // 2 and 3. A navigation of this page that no link click explains.
  type NavEvent = Event & {
    navigationType: string;
    hashChange: boolean;
    downloadRequest: string | null;
    cancelable: boolean;
    userInitiated: boolean;
    formData?: unknown;
    sourceElement?: Element | null;
    destination: { url: string; sameDocument: boolean };
  };
  const navigation = (win as unknown as { navigation?: EventTarget }).navigation;
  const onNavigate = (ev: Event): void => {
    const e = ev as NavEvent;
    const verdict = navigationVerdict(
      {
        navigationType: e.navigationType,
        sameDocument: e.destination.sameDocument,
        hashChange: e.hashChange,
        download: e.downloadRequest !== null && e.downloadRequest !== undefined,
        url: e.destination.url,
      },
      win.location.href,
      deps.appBase,
      inJarvisApp,
    );
    if (verdict === "planned") allowLeave(3000);
    if (verdict !== "stop" || !e.cancelable) return;
    e.preventDefault();
    const url = e.destination.url;
    if (lastHandled.url === url && Date.now() - lastHandled.at < 1500) return; // the click rule already handled it
    let opened = false;
    if (e.userInitiated) {
      win.open(url, "_blank", "noopener,noreferrer");
      opened = true;
    }
    acted(
      "script",
      url,
      null,
      opened,
      leaveTrace(
        e,
        lastClick,
        Date.now(),
        new Error("leave").stack,
        win.top !== win,
        win.navigator?.userAgent,
      ),
    );
  };
  navigation?.addEventListener("navigate", onNavigate);

  // 3. An unplanned leave asks first. A reload from the keyboard is the reader's own plan.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"))
      allowLeave(2000);
  };
  win.addEventListener("keydown", onKey, true);
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (Date.now() < leaveAllowedUntil || !deps.askOnLeave()) return;
    e.preventDefault();
    e.returnValue = ""; // the browser shows its own "Leave site?" question
    acted("asked", win.location.href, null, false);
  };
  win.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    doc.removeEventListener("click", onClick, true);
    navigation?.removeEventListener("navigate", onNavigate);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("beforeunload", onBeforeUnload);
  };
}
