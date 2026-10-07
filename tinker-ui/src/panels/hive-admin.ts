// FORK 2026-10-06 (the user: "Admin should have a specific panel at the right panel at the bottom, to
// create a new token for a new user, to revoke those tokens, regenerate them or simply delete the
// user's access. No user data is ever removed when a user is deleted.")
//
// The USERS panel talks to the hive door's admin API (scripts/hive-door/door.mjs, /tinker/door/api/*).
// It only exists in multi-user mode: without the door, `fetchHiveMe` answers null and the panel stays
// hidden. A new or regenerated token is shown ONCE in the panel with a copy button; the door stores
// only its hash. "Remove access" marks the person deleted: their chats and settings are kept.

import type { HiveMe } from "./hive-owner-groups.ts";

const API = "/tinker/door/api/";

type Person = {
  operatorId: string;
  displayName: string;
  admin: boolean;
  status: "active" | "revoked" | "deleted";
  chats: number;
  createdAt: string | null;
  lastLoginAt: string | null;
  /** The door keeps this person's current token, so an admin can copy it (2026-10-07). */
  hasToken?: boolean;
};

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[<&>"']/g,
    (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

/** Who am I, in multi-user mode. null when the page is not behind the hive door. */
export async function fetchHiveMe(): Promise<HiveMe | null> {
  try {
    const res = await fetch(API + "me", { credentials: "same-origin" });
    if (!res.ok) {
      return null;
    }
    const me = (await res.json()) as HiveMe;
    return me && typeof me.operatorId === "string" ? me : null;
  } catch {
    return null;
  }
}

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "?"
    : d.toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Copy text on any page. Goku is served over plain http on the LAN, where navigator.clipboard does not
 *  exist (it needs a secure context), so fall back to a hidden textarea + execCommand("copy"). */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error("[hive-admin] clipboard write failed, trying the fallback", err);
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    console.error("[hive-admin] execCommand copy failed", err);
  }
  ta.remove();
  return ok;
}

/** Deleted people go to their own folded list; everyone else stays in the main list. */
export function splitPeople<T extends { status: string }>(
  people: T[],
): { current: T[]; deleted: T[] } {
  return {
    current: people.filter((p) => p.status !== "deleted"),
    deleted: people.filter((p) => p.status === "deleted"),
  };
}

let reveal: { name: string; token: string } | null = null;
let notice = "";

function personRow(p: Person, me: HiveMe): string {
  const self = p.operatorId === me.operatorId;
  const status =
    p.status === "active"
      ? '<span class="hive-chip hive-chip--ok">active</span>'
      : `<span class="hive-chip hive-chip--off">${esc(p.status === "deleted" ? "no access" : "revoked")}</span>`;
  const btn = (action: string, label: string, hint: string) =>
    `<button class="hive-btn" data-hive-action="${action}" data-hive-id="${esc(p.operatorId)}" data-hint="${esc(hint)}">${label}</button>`;
  const actions = [
    btn(
      "rotate",
      p.status === "active" ? "New token" : "Restore",
      "Make a new token for this person; the old one stops working",
    ),
    p.status === "active" && p.hasToken
      ? btn("copytoken", "Copy token", "Copy this person's current token")
      : "",
    !self && p.status === "active"
      ? btn("revoke", "Revoke", "Stop this person's current token; a new token restores access")
      : "",
    !self && p.status !== "deleted"
      ? btn("delete", "Delete", "Delete this person: no more access. Everything they made is kept")
      : "",
    p.admin
      ? btn("unadmin", "Remove admin", "Take admin rights away")
      : btn("admin", "Make admin", "Admins see every user's chats and manage people"),
  ].join("");
  return `<div class="hive-person${p.status !== "active" ? " hive-person--off" : ""}">
    <div class="hive-person-line"><b>${esc(p.displayName)}</b>${p.admin ? ' <span class="hive-chip hive-chip--admin">admin</span>' : ""} ${status}${self ? ' <span class="hive-you">you</span>' : ""}</div>
    <div class="hive-person-meta">${esc(p.operatorId)} · ${p.chats} chats · last login ${esc(when(p.lastLoginAt))}</div>
    <div class="hive-person-actions">${actions}</div>
  </div>`;
}

export async function renderHiveUsers(body: HTMLElement, me: HiveMe, countEl?: HTMLElement | null) {
  let people: Person[] = [];
  try {
    people = (await call<{ users: Person[] }>("GET", "users")).users;
  } catch (err) {
    console.error("[hive-admin] could not load people", err);
    body.innerHTML = `<div class="hive-note hive-note--err">Could not load people: ${esc((err as Error).message)}</div>`;
    return;
  }
  if (countEl) countEl.textContent = `(${people.filter((p) => p.status === "active").length})`;
  const revealHtml = reveal
    ? `<div class="hive-reveal"><div>Token for <b>${esc(reveal.name)}</b>. It is shown <b>once</b>; send it privately.</div>
       <code class="hive-token">${esc(reveal.token)}</code>
       <div class="hive-person-actions"><button class="hive-btn" data-hive-action="copy">Copy</button><button class="hive-btn" data-hive-action="dismiss">Done</button></div></div>`
    : "";
  body.innerHTML = `${revealHtml}${notice ? `<div class="hive-note">${esc(notice)}</div>` : ""}
    <form class="hive-add" data-hive-form="add">
      <input name="name" placeholder="New person's name" maxlength="60" required>
      <label class="hive-add-admin"><input type="checkbox" name="admin"> admin</label>
      <button class="hive-btn hive-btn--primary" type="submit">Add</button>
    </form>
    ${(() => {
      const { current, deleted } = splitPeople(people);
      const folded = deleted.length
        ? `<details class="hive-deleted"><summary>Deleted people (${deleted.length})</summary>${deleted.map((p) => personRow(p, me)).join("")}</details>`
        : "";
      return current.map((p) => personRow(p, me)).join("") + folded;
    })()}`;
}

/** Wire the right-rail panel once. */
export function initHiveUsersPanel(panel: HTMLElement, body: HTMLElement, me: HiveMe) {
  wireHiveUsers(body, me, panel.querySelector<HTMLElement>("#hive-users-count"));
  panel.hidden = false;
}

/** Who this page is signed in as, with the way out. Shown to everyone behind the door. */
export function hiveWhoAmIHtml(me: HiveMe): string {
  return `Signed in as <b>${esc(me.displayName)}</b>${me.admin ? ' <span class="hive-chip hive-chip--admin">admin</span>' : ""} · <a class="hive-signout" href="/tinker/logout" data-hint="Sign out, then log in with another person's token">Sign out</a>`;
}

// FORK 2026-10-07 (the user: "build an extra left-panel tab under recipes called users, where I can
// do all the user operations"). Same people list and actions as the right-rail panel, full width.
// Everyone gets the "signed in as" line and Sign out: the user had logged in with a token that had
// become someone else's and nothing on the page said so.
export function renderHiveUsersTab(body: HTMLElement, sub: HTMLElement, me: HiveMe) {
  sub.innerHTML = hiveWhoAmIHtml(me);
  if (!me.admin) {
    body.innerHTML = `<div class="hive-note">Only an admin can add people or change their access.</div>`;
    return;
  }
  body.innerHTML = `<div class="hive-users-tab"></div>`;
  wireHiveUsers(body.firstElementChild as HTMLElement, me, null);
}

/** Attach the add form and the per-person buttons to `body`, then render. Re-renders after every action. */
function wireHiveUsers(body: HTMLElement, me: HiveMe, countEl: HTMLElement | null) {
  const rerender = () => renderHiveUsers(body, me, countEl);
  body.addEventListener("submit", async (ev) => {
    const form = (ev.target as HTMLElement).closest<HTMLFormElement>('[data-hive-form="add"]');
    if (!form) return;
    ev.preventDefault();
    const name = String(new FormData(form).get("name") ?? "").trim();
    const admin = Boolean((form.elements.namedItem("admin") as HTMLInputElement | null)?.checked);
    if (!name) return;
    try {
      const r = await call<{ user: Person; token: string }>("POST", "users", {
        displayName: name,
        admin,
      });
      reveal = { name: r.user.displayName, token: r.token };
      notice = "";
    } catch (err) {
      notice = `Could not add ${name}: ${(err as Error).message}`;
    }
    await rerender();
  });
  body.addEventListener("click", async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-hive-action]");
    if (!b) return;
    const action = b.dataset.hiveAction!;
    const id = b.dataset.hiveId ?? "";
    if (action === "copy" && reveal) {
      b.textContent = (await copyText(reveal.token)) ? "Copied" : "Select and copy it by hand";
      return;
    }
    if (action === "copytoken") {
      try {
        const r = await call<{ token: string }>("GET", `users/${encodeURIComponent(id)}/token`);
        if (await copyText(r.token)) {
          b.textContent = "Copied";
          return;
        }
        reveal = { name: id, token: r.token };
        notice = "Copying is blocked on this page; the token is shown above.";
      } catch (err) {
        notice = (err as Error).message;
      }
      await rerender();
      return;
    }
    if (action === "dismiss") {
      reveal = null;
      await rerender();
      return;
    }
    const ask: Record<string, string> = {
      rotate: `Make a new token for ${id}? Their current token stops working.`,
      revoke: `Revoke ${id}'s token? They are signed out until you make a new token.`,
      delete: `Delete ${id}? They can no longer log in. Everything they made (chats, settings) is kept, you still see their chats, and Restore brings them back.`,
      admin: `Make ${id} an admin? Admins see every user's chats and manage people.`,
      unadmin: `Take admin rights away from ${id}?`,
    };
    if (ask[action] && !window.confirm(ask[action])) return;
    try {
      const path = action === "unadmin" || action === "admin" ? "admin" : action;
      const r = await call<{ user: Person; token?: string }>(
        "POST",
        `users/${encodeURIComponent(id)}/${path}`,
        {
          admin: action === "admin",
        },
      );
      if (r.token) reveal = { name: r.user.displayName, token: r.token };
      notice = "";
    } catch (err) {
      notice = (err as Error).message;
    }
    await rerender();
  });
  void rerender();
}
