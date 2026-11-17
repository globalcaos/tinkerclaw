import { describe, expect, it } from "vitest";
import {
  evidenceLines,
  missingFor,
  provenByOutput,
  showsACheck,
  splitClaims,
  splitSentences,
  supportedBy,
  uncheckedAdmissions,
} from "../src/claims.js";
import type { Claim, ToolRecordEntry } from "../src/types.js";

const entry = (
  tool: string,
  effects: ToolRecordEntry["effects"],
  exit: number | null = 0,
): ToolRecordEntry => ({ tool, argsDigest: "x", exit, filesWritten: [], effects, ts: 1 });
const done = (text: string): Claim => ({ text, kind: "done", source: null, support: null });

describe("splitSentences", () => {
  it("splits on . ! ? ; newlines and bullets, not on decimals, versions or paths", () => {
    expect(splitSentences("Saved a.b to v2.3 at /tmp/x.txt. Done! Ok? yes; no")).toEqual([
      "Saved a.b to v2.3 at /tmp/x.txt.",
      "Done!",
      "Ok?",
      "yes;",
      "no",
    ]);
    expect(splitSentences("- first thing\n* second thing\n1. third thing")).toEqual([
      "first thing",
      "second thing",
      "third thing",
    ]);
    expect(splitSentences("It costs 3.5 euros e.g. today. Next.")).toEqual([
      "It costs 3.5 euros e.g. today.",
      "Next.",
    ]);
  });
});

describe("splitClaims", () => {
  const table: [string, Claim["kind"] | null][] = [
    ["I uploaded the PDF to the site.", "done"],
    ["The email was sent to the client.", "done"],
    ["I saved the notes in notes.md.", "done"],
    ["I deleted the old build directory.", "done"],
    ["The stale branch is removed.", "done"],
    ["I created the folder /tmp/out.", "done"],
    ["I wrote the parser to src/parse.ts.", "done"],
    ["The parser is written.", "done"],
    ["I pushed the branch to origin.", "done"],
    ["I committed the change as abc1234.", "done"],
    ["The PR is merged.", "done"],
    ["It is deployed to v2.3 on staging.", "done"],
    ["The package is installed.", "done"],
    ["The bug is fixed.", "done"],
    ["I tested it with 3.5 seconds of audio.", "done"],
    ["Verified against the live API.", "done"],
    ["The image is built.", "done"],
    ["The label is printed.", "done"],
    ["The invoice is paid.", "done"],
    ["I renamed the files by date.", "done"],
    ["Everything is finished.", "done"],
    ["Uploaded and verified both files.", "done"],
    ["He guardado el archivo en la carpeta.", "done"],
    ["He enviado el correo a Marta.", "done"],
    ["Ja he eliminat la còpia antiga.", "done"],
    ["Està arreglat i provat.", "done"],
    ["Ya está hecho.", "done"],
    ["I uploaded it with no errors.", "done"],
    ["The service is running on port 8080.", "state"],
    ["The gateway is up.", "state"],
    ["The timer is enabled.", "state"],
    ["The site is live.", "state"],
    ["The app now uses the new key.", "state"],
    ["The daemon has restarted.", "state"],
    ["I have not deleted anything.", null],
    ["I never sent it.", null],
    ["No he enviado nada.", null],
    ["I will send the email tomorrow.", null],
    ["I'll upload it after lunch.", null],
    ["Should I have deleted it?", null],
    ["If it is fixed we can close the ticket.", null],
    ["The function returns the sum of the two lists.", null],
    ["Here is the plan for the export.", null],
    ["The gateway is not running.", null],
    ["Nothing was restarted, and the PDF stays as it is.", null],
    ["None of the branches were deleted.", null],
    ["This should be fixed by the next rebuild.", null],
    ["It could be merged tonight.", null],
    ["It needs to be deployed first.", null],
    ["I recommend it gets pushed after review.", null],
    ["Proposed: the old copy gets deleted.", null],
    ["When the job is finally finished, the card updates.", null],
    ["Once everything on the laptop is built, restart it.", null],
    ["I'd check whether the gateway is up.", null],
    ["Si el fitxer està guardat, seguim.", null],
  ];
  for (const [sentence, kind] of table) {
    it(`${kind ?? "no claim"}: ${sentence}`, () => {
      const claims = splitClaims(sentence);
      if (kind === null) expect(claims).toEqual([]);
      else expect(claims).toEqual([{ text: sentence, kind, source: null, support: null }]);
    });
  }

  it("keeps a compound sentence as one claim", () => {
    expect(splitClaims("I uploaded and verified both files.")).toHaveLength(1);
  });

  it("a verb and a state phrase in one sentence stays a done claim", () => {
    expect(splitClaims("I pushed the fix and the site is live.")[0]?.kind).toBe("done");
  });

  it("splits a multi-sentence reply", () => {
    const c = splitClaims("Uploaded the file. The service is running. Anything else?");
    expect(c.map((x) => x.kind)).toEqual(["done", "state"]);
  });
});

describe("output as evidence", () => {
  const entries = [entry("Bash", ["local-write"])];
  it("keeps only lines that could prove something, clipped", () => {
    expect(evidenceLines("hello\nDeleted branch x (was 1a2b3c4).\n\n")).toEqual([
      "Deleted branch x (was 1a2b3c4).",
    ]);
    expect(evidenceLines(`removed ${"x".repeat(400)}`)[0]?.length).toBe(240);
  });
  it("a line must show the action and name the thing", () => {
    expect(provenByOutput(done("I deleted the old branch"), ["Deleted branch x"], [])).toBe(true);
    expect(provenByOutput(done("I deleted the old report"), ["Deleted branch x"], [])).toBe(false);
    expect(provenByOutput(done("I deleted the old branch"), ["branch x kept"], [])).toBe(false);
    expect(provenByOutput(done("I deleted the old branch"), [], [])).toBe(false);
  });
  it("a test count needs no name", () => {
    expect(provenByOutput(done("Tested it"), ["Tests  3 passed (3)"], [])).toBe(true);
    expect(provenByOutput(done("All tested"), ["Tests  3 passed (3)"], [])).toBe(true);
  });
  it("a second verb needs a line or a record entry", () => {
    const c = done("Merged the guard and deleted the branch");
    expect(provenByOutput(c, ["Deleted branch guard"], [])).toBe(false);
    expect(provenByOutput(c, ["Deleted branch guard"], entries)).toBe(true);
  });
  it("a state claim needs a line that names the thing and shows it up", () => {
    const c: Claim = { ...done("The gateway is running"), kind: "state" };
    expect(provenByOutput(c, ["gateway: active (running)"], [])).toBe(true);
    expect(provenByOutput(c, ["gateway: restart skipped"], [])).toBe(false);
  });
  it("showsACheck reads test counts and a healthy restart, not any success", () => {
    expect(showsACheck(["Tests  3 passed (3)"])).toBe(true);
    expect(showsACheck(["Gateway healthy on build abc"])).toBe(true);
    expect(showsACheck(["finished"])).toBe(false);
  });
});

describe("missingFor / supportedBy", () => {
  it("phrases what the record lacks", () => {
    expect(missingFor(done("PDF uploaded"), [])).toBe(
      "no tool call in this task uploaded anything",
    );
    expect(missingFor(done("I deleted the file"), [entry("Read", ["read"])])).toBe(
      "no successful call that deleted anything",
    );
    expect(missingFor({ ...done("service is running"), kind: "state" }, [])).toBe(
      "no check of the running state in this task",
    );
    expect(missingFor(done("all tested"), [entry("Read", ["read"])])).toBe(
      "no successful test or check run in this task",
    );
    expect(missingFor(done("Ya está hecho"), [])).toBe(
      "no tool call in this task shows the work done",
    );
    expect(missingFor(done("both PDFs uploaded"), [entry("Bash", ["send"])])).toBe(
      "no entry in the record that covers all of it",
    );
  });

  it("is deterministic and at most 90 chars", () => {
    const c = done("I uploaded the file");
    expect(missingFor(c, [])).toBe(missingFor(c, []));
    expect(missingFor(c, []).length).toBeLessThanOrEqual(90);
  });

  it("supportedBy matches an effect class or tool name with exit 0/null only", () => {
    expect(supportedBy(done("PDF uploaded"), [entry("Bash", ["send"])])).toBe(true);
    expect(supportedBy(done("PDF uploaded"), [entry("Bash", ["send"], 1)])).toBe(false);
    expect(supportedBy(done("PDF uploaded"), [entry("upload_file", ["other"], null)])).toBe(true);
    expect(supportedBy(done("invoice sent"), [entry("Bash", ["local-write"])])).toBe(false);
    expect(supportedBy(done("file deleted"), [entry("Bash", ["delete"])])).toBe(true);
    expect(supportedBy(done("uploaded and deleted it"), [entry("Bash", ["send"])])).toBe(false);
    const state: Claim = { ...done("it is running"), kind: "state" };
    expect(supportedBy(state, [entry("Bash", ["read"])])).toBe(true);
    expect(supportedBy(state, [entry("Edit", ["local-write"])])).toBe(false);
  });
});

describe("uncheckedAdmissions (2026-11-10)", () => {
  it("catches the ways a reply admits it did not check", () => {
    for (const line of [
      "The sites may have no backups (inferred).",
      "I haven't checked whether royalties fall under it.",
      "We did not verify the build on the laptop.",
      "This is from general knowledge, not the official text.",
      "Still not confirmed: that the card shows on the page.",
      "The second path is untested.",
      "I'm not sure the limit applies here.",
      "El límite sigue sin comprobar.",
    ]) {
      expect(uncheckedAdmissions(line), line).toEqual([line]);
    }
  });
  it("leaves checked statements, code blocks and quoted lines alone", () => {
    expect(uncheckedAdmissions("I checked the page: it answers 200.")).toEqual([]);
    expect(uncheckedAdmissions("All 12 tests passed.")).toEqual([]);
    expect(uncheckedAdmissions("```\n# not checked\n```\nDone.")).toEqual([]);
    expect(uncheckedAdmissions("> I haven't checked it\nHe wrote that yesterday.")).toEqual([]);
    expect(uncheckedAdmissions('The sample "The plan lapsed (inferred)." was sent back.')).toEqual(
      [],
    );
  });
  it("returns each admitting sentence of a longer reply", () => {
    const reply = "The host is up. The plan lapsed (inferred). I have not tested the revert.";
    expect(uncheckedAdmissions(reply)).toEqual([
      "The plan lapsed (inferred).",
      "I have not tested the revert.",
    ]);
  });
});
