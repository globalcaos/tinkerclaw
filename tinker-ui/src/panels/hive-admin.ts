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
    !self && p.status === "active"
      ? btn("revoke", "Revoke", "Stop this person's current token; a new token restores access")
      : "",
    !self && p.status !== "deleted"
      ? btn("delete", "Remove access", "No more access. Their chats and settings are kept")
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
    ${people.map((p) => personRow(p, me)).join("")}`;
}

/** Wire the panel once. Re-renders after every action. */
export function initHiveUsersPanel(panel: HTMLElement, body: HTMLElement, me: HiveMe) {
  const countEl = panel.querySelector<HTMLElement>("#hive-users-count");
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
      await navigator.clipboard?.writeText(reveal.token).catch(() => {});
      b.textContent = "Copied";
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
      delete: `Remove ${id}'s access? Their chats and settings are kept, and you will still see their chats.`,
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
  panel.hidden = false;
  void rerender();
}
