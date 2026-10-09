// The vault: what the relay stores and refuses (relay/vault.ts), and what a
// device accepts when it opens one (vault.ts).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../src/relay/bun.ts";
import type { HumanAuth } from "../src/relay/human.ts";
import { onVaultHttp, VAULT_WINDOW_MS, VAULT_WRITES, vaultSwap, type VaultRecord, type VaultStore } from "../src/relay/vault.ts";
import {
  addWrap,
  fetchVault,
  forgetSeat,
  mergeContents,
  newRecoveryCode,
  newVault,
  openVault,
  putVault,
  recoverySecret,
  replaceSeat,
  resealVault,
  rotateVault,
  syncVault,
  unlock,
  vaultKey,
  wrapsOf,
  type VaultBlob,
  type VaultContents,
  type VaultEntry,
  type WrapInput,
} from "../src/vault.ts";

setDefaultTimeout(30_000);

// Sign-in stand-in: the token "tok:<user>" is that user.
const human: HumanAuth = { verify: async (t: string) => (t.startsWith("tok:") ? t.slice(4) : null) } as HumanAuth;
const tok = (user: string) => `tok:${user}`;

const dataDir = mkdtempSync(join(tmpdir(), "kiwi-vault-relay-"));
let server: ReturnType<typeof startRelay>;
let relay: string;
beforeAll(() => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir, human });
  relay = server.url.origin;
});
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

const entry = (code: string, pk: string, at = 1000): VaultEntry & { sk: string } => ({ code, at, identity: { pk }, sk: `secret-of-${pk}` });
const empty: VaultContents = { channels: [], gone: {} };
const passkey = (id = "cred-1"): WrapInput => ({ kind: "passkey", label: "Touch ID", secret: crypto.getRandomValues(new Uint8Array(32)), credentialId: id });

describe("relay", () => {
  test("stores one opaque blob per person, ordered by version", async () => {
    expect(await fetchVault(relay, tok("alice"))).toBeNull();
    expect(await putVault(relay, tok("alice"), 0, "not even json: the relay never parses it")).toEqual({ version: 1 });
    expect(await fetchVault(relay, tok("alice"))).toEqual({ version: 1, blob: "not even json: the relay never parses it" });
    expect(await putVault(relay, tok("alice"), 1, "v2")).toEqual({ version: 2 });
  });

  test("a stale version is refused with the current one", async () => {
    expect(await putVault(relay, tok("alice"), 1, "late")).toEqual({ conflict: 2 });
    expect(await putVault(relay, tok("alice"), 0, "recreate")).toEqual({ conflict: 2 });
    expect((await fetchVault(relay, tok("alice")))!.blob).toBe("v2");
  });

  test("nobody reads or writes another person's vault, or any vault signed out", async () => {
    expect(await fetchVault(relay, tok("bob"))).toBeNull();
    expect(await putVault(relay, tok("bob"), 0, "bob's")).toEqual({ version: 1 });
    expect((await fetchVault(relay, tok("alice")))!.blob).toBe("v2");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(`${relay}/v1/me/vault`, { method, body: method === "GET" ? undefined : JSON.stringify({ version: 2, blob: "x" }) });
      expect(res.status).toBe(401);
    }
  });

  test("size, shape and deletion", async () => {
    const put = (body: unknown) => fetch(`${relay}/v1/me/vault`, { method: "PUT", headers: { "x-human-token": tok("carol") }, body: JSON.stringify(body) });
    expect((await put({ version: 0, blob: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await put({ version: -1, blob: "x" })).status).toBe(400);
    expect((await put({ version: 0 })).status).toBe(400);
    const del = (version: number) => fetch(`${relay}/v1/me/vault`, { method: "DELETE", headers: { "x-human-token": tok("bob") }, body: JSON.stringify({ version }) });
    expect((await del(7)).status).toBe(409);
    expect(await (await del(1)).json()).toEqual({ removed: true });
    expect(await fetchVault(relay, tok("bob"))).toBeNull();
  });

  test("saves are rate-limited per person, by the record itself", async () => {
    const recs = new Map<string, VaultRecord>();
    const store: VaultStore = {
      get: async (u) => recs.get(u) ?? null,
      put: async (u, expected, rec) => (vaultSwap(recs.get(u) ?? null, expected) ? (recs.set(u, rec), { ok: true }) : { ok: false, current: recs.get(u) ?? null }),
      remove: async () => false,
    };
    const save = (v: number, now: number) =>
      onVaultHttp(new Request("http://r/v1/me/vault", { method: "PUT", headers: { "x-human-token": tok("dave") }, body: JSON.stringify({ version: v, blob: "b" }) }), store, human, now).catch((e) => e);
    let v = 0;
    for (; v < VAULT_WRITES; v++) expect(((await save(v, 1000 + v)) as Response).status).toBe(200);
    expect(((await save(v, 2000)) as { status: number }).status).toBe(429);
    expect(((await save(v, 1000 + VAULT_WINDOW_MS + 1)) as Response).status).toBe(200);
  });
});

describe("vault crypto", () => {
  test("a passkey or the recovery code opens it; nothing else does", async () => {
    const pk = passkey();
    const contents = { channels: [entry("mc2-a", "pkA")], gone: {} };
    const { key, blob } = await newVault("alice", contents, pk);
    expect(await unlock(blob, "alice", pk.secret, "cred-1")).toBe(key);
    expect(await unlock(blob, "alice", crypto.getRandomValues(new Uint8Array(32)), "cred-1")).toBeNull();
    expect(await unlock(blob, "alice", pk.secret, "cred-other")).toBeNull();

    const code = newRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const two = await addWrap(blob, "alice", key, 2, contents, { kind: "recovery", label: "Recovery code", secret: recoverySecret(code)! });
    expect(await unlock(two, "alice", recoverySecret(code.toLowerCase().replace(/-/g, ""))!)).toBe(key);
    expect(wrapsOf(two).map((w) => [w.kind, w.label, w.credentialId])).toEqual([["passkey", "Touch ID", "cred-1"], ["recovery", "Recovery code", undefined]]);
    expect(JSON.stringify(wrapsOf(two))).not.toContain("box");
    expect(await openVault(two, "alice", key, 2)).toEqual(contents);
    expect(await openVault(two, "alice", await vaultKey(key), 2)).toEqual(contents);
    expect(recoverySecret("not a code")).toBeNull();
  });

  test("the relay sees no key material: only ciphertext and public wrap labels", async () => {
    const e = entry("mc2-a", "pkA");
    const { key, blob } = await newVault("alice", { channels: [e], gone: {} }, passkey());
    for (const s of [key, e.sk, e.identity.pk, e.code]) expect(blob).not.toContain(s);
  });

  test("refuses another person's vault, another version, and moved or stripped boxes", async () => {
    const pk = passkey();
    const { key, blob } = await newVault("alice", empty, pk);
    await expect(openVault(blob, "mallory", key, 1)).rejects.toThrow();
    await expect(openVault(blob, "alice", key, 2)).rejects.toThrow();
    expect(await unlock(blob, "mallory", pk.secret, "cred-1")).toBeNull();

    // A wrap box moved under another wrap's id, or its kind relabelled, no longer opens.
    const b = JSON.parse(blob) as VaultBlob;
    const relabelled = JSON.stringify({ ...b, wraps: b.wraps.map((w) => ({ ...w, kind: "recovery" })) });
    expect(await unlock(relabelled, "alice", pk.secret)).toBeNull();
    const renamed = JSON.stringify({ ...b, wraps: b.wraps.map((w) => ({ ...w, id: crypto.randomUUID() })) });
    expect(await unlock(renamed, "alice", pk.secret, "cred-1")).toBeNull();

    // The relay strips a passkey or adds one of its own: the body's list doesn't match.
    const extra = JSON.stringify({ ...b, wraps: [...b.wraps, { ...b.wraps[0]!, id: crypto.randomUUID() }] });
    await expect(openVault(extra, "alice", key, 1)).rejects.toThrow(/passkeys were changed/);
    await expect(openVault(JSON.stringify({ ...b, wraps: [] }), "alice", key, 1)).rejects.toThrow(/passkeys were changed/);
  });

  test("a device refuses a vault older than one it already opened", async () => {
    const { key, blob } = await newVault("alice", empty, passkey());
    await expect(openVault(blob, "alice", key, 1, 3)).rejects.toThrow(/rolling your vault back/);
  });

  test("tombstones beat older entries; a later rejoin beats the tombstone", () => {
    const old = entry("mc2-a", "pkA", 1000);
    const left = forgetSeat({ channels: [old], gone: {} }, old, 2000);
    // Another device that still has the seat merges it back: the tombstone wins.
    expect(mergeContents(left, { channels: [old], gone: {} }).contents.channels).toEqual([]);
    const back = entry("mc2-a", "pkA", 3000);
    expect(mergeContents(left, { channels: [back], gone: {} }).contents.channels).toEqual([back]);
  });

  test("one join code never keeps two live keys; replaceSeat moves it to the new one", () => {
    const a = entry("mc2-a", "pkA", 1000);
    const b = entry("mc2-a", "pkB", 2000);
    const both = mergeContents({ channels: [a], gone: {} }, { channels: [b], gone: {} });
    expect(both.contents.channels).toEqual([a]);
    expect(both.conflicts).toEqual(["mc2-a"]);
    const reclaimed = replaceSeat({ channels: [a], gone: {} }, b, "pkA", 2000);
    expect(reclaimed.channels).toEqual([b]);
    // A device still holding the old key merges after the reclaim: the old seat stays gone.
    expect(mergeContents(reclaimed, { channels: [a], gone: {} })).toEqual({ contents: reclaimed, conflicts: [] });
  });

  test("removing a passkey rotates the vault key: the old key opens nothing new", async () => {
    const kept = passkey("cred-keep");
    const lost = passkey("cred-lost");
    const contents = { channels: [entry("mc2-a", "pkA")], gone: {} };
    const first = await newVault("alice", contents, kept);
    const two = await addWrap(first.blob, "alice", first.key, 2, contents, lost);
    const r = await rotateVault("alice", 3, contents, kept);
    expect(r.key).not.toBe(first.key);
    expect(await unlock(r.blob, "alice", lost.secret, "cred-lost")).toBeNull();
    expect(await unlock(r.blob, "alice", kept.secret, "cred-keep")).toBe(r.key);
    expect(await unlock(r.blob, "alice", recoverySecret(r.recoveryCode)!)).toBe(r.key);
    await expect(openVault(r.blob, "alice", first.key, 3)).rejects.toThrow();
    expect(await openVault(r.blob, "alice", r.key, 3)).toEqual(contents);
    expect(two).not.toBe(r.blob);
  });
});

describe("two devices", () => {
  test("saving at once: the second merges on 409 and both seats land", async () => {
    const pk = passkey();
    const { key, blob } = await newVault("erin", empty, pk);
    expect(await putVault(relay, tok("erin"), 0, blob)).toEqual({ version: 1 });
    const add = (e: VaultEntry) => (c: VaultContents) => mergeContents(c, { channels: [e], gone: {} }).contents;

    // Phone reads version 1, then the laptop saves first.
    const phoneRead = (await fetchVault(relay, tok("erin")))!;
    await syncVault(relay, tok("erin"), "erin", key, add(entry("mc2-laptop", "pkL")));
    const phoneBlob = await resealVault(phoneRead.blob, "erin", key, 2, add(entry("mc2-phone", "pkP"))(await openVault(phoneRead.blob, "erin", key, 1)));
    expect(await putVault(relay, tok("erin"), phoneRead.version, phoneBlob)).toEqual({ conflict: 2 });

    // The phone does what syncVault does on a conflict: read again, re-apply, save.
    const done = await syncVault(relay, tok("erin"), "erin", await vaultKey(key), add(entry("mc2-phone", "pkP")), 2);
    expect(done.version).toBe(3);
    const got = (await fetchVault(relay, tok("erin")))!;
    expect((await openVault(got.blob, "erin", key, got.version)).channels.map((c) => c.code).sort()).toEqual(["mc2-laptop", "mc2-phone"]);
  });
});
