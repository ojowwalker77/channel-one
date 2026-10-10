// Every error text the relay can send, pinned. They're API: the CLI matches some
// (removed|denied), the dashboard matches others (sign in required) and shows them
// all as they are. A guard for the Effect rewrite (docs/plans/effect.md): changing
// one is a deliberate edit to the snapshot, never a side effect.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../src/relay");

/**
 * (status, text) for every refusal: HttpError thrown, refuse() in the router, and
 * error bodies written by hand. Which file a text lives in isn't API, so it isn't pinned.
 */
function errorTexts(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/(?:new HttpError|refuse)\(\s*(\d{3}),\s*([`"'])((?:\\.|(?!\2).)*)\2/g)) out.add(`${m[1]} ${m[3]}`);
    // A text kept in a string constant counts as that text.
    const consts = new Map([...src.matchAll(/const\s+(\w+)\s*=\s*"((?:\\.|[^"])*)"/g)].map((m) => [m[1]!, m[2]!]));
    for (const m of src.matchAll(/(?:new HttpError|refuse)\(\s*(\d{3}),\s*([A-Za-z_][\w.]*(?:\([^)]*\))?)\s*(?:,\s*"\w+"\s*)?\)/g)) out.add(`${m[1]} ${consts.get(m[2]!) ?? `<${m[2]}>`}`);
    for (const m of src.matchAll(/signedInPerson\(\s*([A-Za-z_]\w*)\s*\)/g)) if (consts.has(m[1]!)) out.add(`404 ${consts.get(m[1]!)}`);
    for (const m of src.matchAll(/error:\s*([`"'])((?:\\.|(?!\1).)*)\1/g)) out.add(`body ${m[2]}`);
    // A person route's 404 on a relay without sign-in is passed to signedInPerson as its text.
    for (const m of src.matchAll(/signedInPerson\(\s*([`"'])((?:\\.|(?!\1).)*)\1/g)) out.add(`404 ${m[2]}`);
  }
  // The helper's own parameter isn't a text.
  out.delete("404 <noSignIn>");
  return [...out].sort();
}

test("the relay's error texts are exactly these", () => {
  const texts = errorTexts();
  expect(texts.length).toBeGreaterThan(50);
  expect(texts).toMatchSnapshot();
});

test("the texts clients match on are still there", () => {
  const all = errorTexts().join("\n");
  for (const needle of ["this key was removed; join with a new identity", "this key was denied", "not a member", "no such channel", "sign in required", "already a member"]) {
    expect(all).toContain(needle);
  }
});
