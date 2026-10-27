import { describe, expect, it } from "vitest";
import { hiveWhoAmIHtml, renderHiveUsersTab, splitPeople } from "./hive-admin.ts";

const me = (displayName: string, admin: boolean) => ({ operatorId: "p1", displayName, admin });

describe("Users tab: who am I", () => {
  it("names the person, marks an admin and offers the door's sign-out", () => {
    const html = hiveWhoAmIHtml(me("the architect", true));
    expect(html).toContain("Signed in as <b>the architect</b>");
    expect(html).toContain("hive-chip--admin");
    expect(html).toContain('href="/tinker/logout"');
  });

  it("a regular person gets no admin chip", () => {
    expect(hiveWhoAmIHtml(me("alex", false))).not.toContain("hive-chip--admin");
  });

  it("escapes the display name", () => {
    expect(hiveWhoAmIHtml(me("<img src=x onerror=1>", false))).toContain(
      "&lt;img src=x onerror=1&gt;",
    );
  });

  it("a regular person sees who they are but no add form or people list", () => {
    const body = { innerHTML: "" } as unknown as HTMLElement;
    const sub = { innerHTML: "" } as unknown as HTMLElement;
    renderHiveUsersTab(body, sub, me("alex", false));
    expect(sub.innerHTML).toContain("Signed in as <b>alex</b>");
    expect(body.innerHTML).toContain("Only an admin");
    expect(body.innerHTML).not.toContain("hive-add");
  });
});

describe("Users tab: deleted people fold away", () => {
  it("keeps active and revoked people in the list and moves deleted ones out", () => {
    const { current, deleted } = splitPeople([
      { id: "a", status: "active" },
      { id: "r", status: "revoked" },
      { id: "d", status: "deleted" },
    ]);
    expect(current.map((p) => p.id)).toEqual(["a", "r"]);
    expect(deleted.map((p) => p.id)).toEqual(["d"]);
  });
});
