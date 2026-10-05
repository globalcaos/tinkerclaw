import { describe, expect, it } from "vitest";
import { missingFor, splitClaims, splitSentences, supportedBy } from "../src/claims.js";
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
