// A throwaway PDF for tests that make marks: the README as a PDF in /tmp, served at papers/open/jarvistest/t.pdf.
// The viewer autosaves marks into the open file, so a test must never open a real paper.
import { mkdirSync, symlinkSync, readlinkSync, lstatSync, writeFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
const ROOT = new URL("..", import.meta.url).pathname;
export function fixtureUrl() {
  const LINK = `${ROOT}papers/open/jarvistest/t.pdf`;
  let copy = "/tmp/jarvis/tap-comment/t.pdf";
  try { copy = readlinkSync(LINK); } catch {}
  mkdirSync(dirname(copy), { recursive: true });
  execFileSync("python3", [`${ROOT}md2pdf.py`, `${ROOT}README.md`, copy], { stdio: "ignore" });
  mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
  try { lstatSync(LINK); } catch { symlinkSync(copy, LINK); }
  return `http://127.0.0.1:${process.env.PDF_REVIEW_PORT || 18820}/viewer/web/viewer.html?file=%2Fpapers%2Fopen%2Fjarvistest%2Ft.pdf`;
}

// A throwaway document with its own .md (2026-11-15, the contract tests): built in `dir`, linked at
// papers/open/jarvistest/<name>.pdf (so it never enters the Recent list), the source left older than the PDF.
export function fixtureDoc(dir, name, paragraphs) {
  const md = `${dir}/${name}.md`, pdf = `${dir}/${name}.pdf`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(md, `# ${name}\n\n${paragraphs.join("\n\n")}\n`);
  const env = { ...process.env };
  delete env.TC_SESSION_KEY; // a test PDF is never linked to a chat
  execFileSync("python3", [`${ROOT}md2pdf.py`, md, pdf], { stdio: "ignore", env });
  const t = statSync(pdf).mtimeMs / 1000 - 30; // no watcher rebuild
  utimesSync(md, t, t);
  const link = `${ROOT}papers/open/jarvistest/${name}.pdf`;
  mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
  try { if (readlinkSync(link) !== pdf) { rmSync(link); symlinkSync(pdf, link); } } catch { rmSync(link, { force: true }); symlinkSync(pdf, link); }
  return { md, pdf, served: `/papers/open/jarvistest/${name}.pdf` };
}
