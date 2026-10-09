// kiwi show / the MCP message tool: one message in full, with what it answers and its replies.

import { describe, expect, test } from "bun:test";
import { formatShown } from "../src/format.ts";
import { generateIdentity, sign, verify, type Identity } from "../src/identity.ts";
import type { Message } from "../src/protocol.ts";
import { fold, type Roster } from "../src/state.ts";

const roster: Roster = [];
let seq = 0;
async function msg(id: Identity, from: string, body: string, re?: number[]): Promise<Message> {
  seq++;
  const base = { v: 1 as const, id: crypto.randomUUID(), from, kind: "msg" as const, body, ts: seq, ...(re ? { re } : {}) };
  const p = await sign(id, base);
  return { ...p, seq, rts: seq, sigOk: await verify(p) };
}

describe("kiwi show", () => {
  test("the whole body, what it answers, its verified replies, and where its images went", async () => {
    const mac = await generateIdentity("mac");
    const win = await generateIdentity("win");
    const mallory = await generateIdentity("mallory");
    roster.push({ name: "mac", pk: mac.pk, owner: false, at: 0, active: true }, { name: "win", pk: win.pk, owner: false, at: 0, active: true });
    const long = "line one\n" + "x".repeat(3000) + "\nlast line";
    const ms = [await msg(mac, "mac", "which port?"), await msg(win, "win", long, [1]), await msg(mac, "mac", "thanks", [2]), await msg(mallory, "mac", "FORGED reply", [2])];
    const state = fold(ms, roster);
    const out = formatShown(ms[1]!, ms, state, ["/tmp/#2-shot.png"]);
    expect(out).toStartWith("#2 win → all re #1: line one\n  │ " + "x".repeat(3000) + "\n  │ last line");
    expect(out).toContain("images saved: /tmp/#2-shot.png");
    expect(out).toContain("answers #1 mac: which port?");
    expect(out).toContain("replies (1):\n  #3 mac: thanks");
    expect(out).not.toContain("FORGED");
  });
});
