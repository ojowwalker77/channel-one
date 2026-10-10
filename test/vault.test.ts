// The vault: what the relay stores and refuses (relay/vault.ts), and what a
// device accepts when it opens one (vault.ts).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, sign } from "../src/identity.ts";
import { startRelay } from "../src/relay/bun.ts";
import type { HumanAuth } from "../src/relay/human.ts";
import { blobHash, onVaultHttp, VAULT_RESET_MS, VAULT_WINDOW_MS, VAULT_WRITES, vaultSwap, type VaultRecord, type VaultStore } from "../src/relay/vault.ts";
import {
  addWrap,
  deleteVault,
  fetchVault,
  forgetSeat,
  mergeContents,
  newRecoveryCode,
  newVault,
  openVault,
  putVault,
  recoverySecret,
  replaceSeat,
  requestVaultReset,
  resealVault,
  rotateVault,
  syncVault,
  unlock,
  vaultKey,
  wrapsOf,
  type VaultBlob,
  type VaultContents,
  type VaultEntry,
  type VaultWriter,
  type WrapInput,
} from "../src/vault.ts";

setDefaultTimeout(30_000);

// Sign-in stand-in: the token "tok:<user>" is that user.
const human = { clientId: "test", verify: async (t: string) => (t.startsWith("tok:") ? t.slice(4) : null) } satisfies HumanAuth;
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
const writerKey = async (): Promise<VaultWriter> => {
  const { pk, sk } = await generateIdentity("w");
  return { pk, sk };
};

describe("relay", () => {
  let w: VaultWriter;
  beforeAll(async () => {
    w = await writerKey();
  });

  test("stores one opaque blob per person, ordered by version, named writer first", async () => {
    expect(await fetchVault(relay, tok("alice"))).toBeNull();
    expect(await putVault(relay, tok("alice"), "alice", 0, "not even json: the relay never parses it", w, w.pk)).toEqual({ version: 1 });
    expect(await fetchVault(relay, tok("alice"))).toEqual({ version: 1, blob: "not even json: the relay never parses it" });
    expect(await putVault(relay, tok("alice"), "alice", 1, "v2", w)).toEqual({ version: 2 });
  });

  test("setting up again over an existing vault is a conflict (go unlock it), not a signature error", async () => {
    // Prod bug #403: a second setup, with a fresh writer key and version 0, got a 403.
    const fresh = await writerKey();
    expect(await putVault(relay, tok("alice"), "alice", 0, "a second setup", fresh, fresh.pk)).toEqual({ conflict: 2 });
    const res = await fetch(`${relay}/v1/me/vault`, { method: "PUT", headers: { "x-human-token": tok("alice") }, body: JSON.stringify({ version: 0, blob: "x", writer: fresh.pk }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ version: 2, exists: true });
    expect((await fetchVault(relay, tok("alice")))!.blob).toBe("v2");
  });

  test("a stale version is refused with the current one", async () => {
    expect(await putVault(relay, tok("alice"), "alice", 1, "late", w)).toEqual({ conflict: 2 });
    expect((await fetchVault(relay, tok("alice")))!.blob).toBe("v2");
  });

  test("a stolen sign-in can't overwrite or delete: every write is signed by the writer key", async () => {
    const thief = await writerKey();
    await expect(putVault(relay, tok("alice"), "alice", 2, "garbage", thief)).rejects.toThrow(/writer key/);
    await expect(putVault(relay, tok("alice"), "alice", 2, "garbage", thief, thief.pk)).rejects.toThrow(/writer key/);
    await expect(deleteVault(relay, tok("alice"), "alice", 2, thief)).rejects.toThrow(/writer key/);
    // A real signature, replayed over another blob or version, doesn't count either.
    const auth = await sign({ name: "w", ...w }, { user: "alice", expected: 2, hash: await blobHash("v3") });
    const replay = await fetch(`${relay}/v1/me/vault`, { method: "PUT", headers: { "x-human-token": tok("alice") }, body: JSON.stringify({ version: 2, blob: "other", auth }) });
    expect(replay.status).toBe(403);
    // Signed for alice, sent as bob.
    expect(await putVault(relay, tok("bob"), "bob", 0, "bob's", w, w.pk)).toEqual({ version: 1 });
    await expect(putVault(relay, tok("bob"), "alice", 1, "x", w)).rejects.toThrow(/writer key/);
    expect((await fetchVault(relay, tok("alice")))!.blob).toBe("v2");
  });

  test("a new writer takes over only when the current one hands over", async () => {
    const next = await writerKey();
    expect(await putVault(relay, tok("alice"), "alice", 2, "v3", w, next.pk)).toEqual({ version: 3 });
    await expect(putVault(relay, tok("alice"), "alice", 3, "v4", w)).rejects.toThrow(/writer key/);
    expect(await putVault(relay, tok("alice"), "alice", 3, "v4", next)).toEqual({ version: 4 });
  });

  test("nobody reads another person's vault, or any vault signed out", async () => {
    expect((await fetchVault(relay, tok("bob")))!.blob).toBe("bob's");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(`${relay}/v1/me/vault`, { method, body: method === "GET" ? undefined : JSON.stringify({ version: 2, blob: "x" }) });
      expect(res.status).toBe(401);
    }
  });

  test("size, shape and signed deletion", async () => {
    const put = (body: unknown) => fetch(`${relay}/v1/me/vault`, { method: "PUT", headers: { "x-human-token": tok("carol") }, body: JSON.stringify(body) });
    expect((await put({ version: 0, blob: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await put({ version: -1, blob: "x" })).status).toBe(400);
    expect((await put({ version: 0 })).status).toBe(400);
    expect((await put({ version: 0, blob: "no writer named" })).status).toBe(400);
    await expect(deleteVault(relay, tok("bob"), "bob", 7, w)).rejects.toThrow(/changed/);
    await deleteVault(relay, tok("bob"), "bob", 1, w);
    expect(await fetchVault(relay, tok("bob"))).toBeNull();
  });

  test("saves are rate-limited per person, by the record itself", async () => {
    const recs = new Map<string, VaultRecord>();
    const store: VaultStore = {
      get: async (u) => recs.get(u) ?? null,
      put: async (u, expected, rec) => (vaultSwap(recs.get(u) ?? null, expected) ? (recs.set(u, rec), { ok: true }) : { ok: false, current: recs.get(u) ?? null }),
      remove: async () => false,
    };
    const save = async (v: number, now: number) => {
      const auth = await sign({ name: "w", ...w }, { user: "dave", expected: v, hash: await blobHash("b"), ...(v === 0 ? { writer: w.pk } : {}) });
      const req = new Request("http://r/v1/me/vault", { method: "PUT", headers: { "x-human-token": tok("dave") }, body: JSON.stringify({ version: v, blob: "b", auth, ...(v === 0 ? { writer: w.pk } : {}) }) });
      return onVaultHttp(req, store, human, now).catch((e: { status: number }) => e);
    };
    let v = 0;
    for (; v < VAULT_WRITES; v++) expect(((await save(v, 1000 + v)) as Response).status).toBe(200);
    expect(((await save(v, 2000)) as { status: number }).status).toBe(429);
    expect(((await save(v, 1000 + VAULT_WINDOW_MS + 1)) as Response).status).toBe(200);
  });

  test("a reset without the writer key waits a day, shows, and a signed save cancels it", async () => {
    const recs = new Map<string, VaultRecord>();
    const store: VaultStore = {
      get: async (u) => recs.get(u) ?? null,
      put: async (u, expected, rec) => (vaultSwap(recs.get(u) ?? null, expected) ? (recs.set(u, rec), { ok: true }) : { ok: false, current: recs.get(u) ?? null }),
      remove: async (u, expected) => (vaultSwap(recs.get(u) ?? null, expected) && recs.delete(u)),
    };
    recs.set("erin", { version: 5, blob: "b", updated: 0, writer: w.pk, recent: [] });
    const at = (method: string, body: unknown, now: number) =>
      onVaultHttp(new Request("http://r/v1/me/vault", { method, headers: { "x-human-token": tok("erin") }, body: body === undefined ? undefined : JSON.stringify(body) }), store, human, now);
    const asked = (await (await at("DELETE", { reset: true }, 1000))!.json()) as { resetAt: number };
    expect(asked.resetAt).toBe(1000 + VAULT_RESET_MS);
    expect(await (await at("GET", undefined, 2000))!.json()).toMatchObject({ version: 5, resetAt: asked.resetAt });
    // A device that still holds the writer key saves: the reset is off.
    const auth = await sign({ name: "w", ...w }, { user: "erin", expected: 5, hash: await blobHash("b6") });
    expect((await at("PUT", { version: 5, blob: "b6", auth }, 3000))!.status).toBe(200);
    expect(await (await at("GET", undefined, 1000 + VAULT_RESET_MS + 1))!.json()).not.toHaveProperty("resetAt");
    // Nobody cancels: after a day the vault is gone, and a new one can start.
    await at("DELETE", { reset: true }, 4000);
    expect((await at("GET", undefined, 4000 + VAULT_RESET_MS))!.status).toBe(404);
    const fresh = await writerKey();
    const first = await sign({ name: "w", ...fresh }, { user: "erin", expected: 0, hash: await blobHash("new"), writer: fresh.pk });
    expect((await at("PUT", { version: 0, blob: "new", auth: first, writer: fresh.pk }, 5000 + VAULT_RESET_MS))!.status).toBe(200);
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
    const opened = await openVault(blob, "alice", key, 1);
    const two = await addWrap(blob, "alice", key, opened, 2, { kind: "recovery", label: "Recovery code", secret: recoverySecret(code)! });
    expect(await unlock(two, "alice", recoverySecret(code.toLowerCase().replace(/-/g, ""))!)).toBe(key);
    const reopened = await openVault(two, "alice", await vaultKey(key), 2);
    expect(reopened.channels).toEqual(contents.channels);
    expect(reopened.wraps.map((w) => [w.kind, w.label, w.credentialId])).toEqual([["passkey", "Touch ID", "cred-1"], ["recovery", "Recovery code", undefined]]);
    expect(reopened.writer).toEqual(opened.writer);
    expect(JSON.stringify(wrapsOf(two))).not.toContain("box");
    expect(recoverySecret("not a code")).toBeNull();
  });

  test("the relay sees no key material: only ciphertext and public wrap labels", async () => {
    const e = entry("mc2-a", "pkA");
    const { key, blob, writer } = await newVault("alice", { channels: [e], gone: {} }, passkey());
    for (const s of [key, writer.sk, e.sk, e.identity.pk, e.code]) expect(blob).not.toContain(s);
  });

  test("refuses another person's vault, another version, and moved, relabelled or stripped wraps", async () => {
    const pk = passkey();
    const { key, blob } = await newVault("alice", empty, pk);
    await expect(openVault(blob, "mallory", key, 1)).rejects.toThrow();
    await expect(openVault(blob, "alice", key, 2)).rejects.toThrow();
    expect(await unlock(blob, "mallory", pk.secret, "cred-1")).toBeNull();

    const b = JSON.parse(blob) as VaultBlob;
    const edit = (f: (w: VaultBlob["wraps"][number]) => object) => JSON.stringify({ ...b, wraps: b.wraps.map((w) => ({ ...w, ...f(w) })) });
    // A box under another id or kind no longer opens.
    expect(await unlock(edit(() => ({ kind: "recovery" })), "alice", pk.secret)).toBeNull();
    expect(await unlock(edit(() => ({ id: crypto.randomUUID() })), "alice", pk.secret, "cred-1")).toBeNull();
    // Relabelling a passkey, or moving it to another credential, shows as tampering once open.
    await expect(openVault(edit(() => ({ label: "Old phone (remove me)" })), "alice", key, 1)).rejects.toThrow(/passkeys were changed/);
    await expect(openVault(edit(() => ({ credentialId: "cred-relay" })), "alice", key, 1)).rejects.toThrow(/passkeys were changed/);
    // Adding a passkey of its own, or stripping one.
    await expect(openVault(JSON.stringify({ ...b, wraps: [...b.wraps, { ...b.wraps[0]!, id: crypto.randomUUID() }] }), "alice", key, 1)).rejects.toThrow(/passkeys were changed/);
    await expect(openVault(JSON.stringify({ ...b, wraps: [] }), "alice", key, 1)).rejects.toThrow(/passkeys were changed/);
  });

  test("a device refuses a vault older than one it already opened", async () => {
    const { key, blob } = await newVault("alice", empty, passkey());
    await expect(openVault(blob, "alice", key, 1, 3)).rejects.toThrow(/rolling your vault back/);
  });

  test("tombstones beat older entries; a later rejoin beats the tombstone", () => {
    const old = entry("mc2-a", "pkA", 1000);
    const left = forgetSeat({ channels: [old], gone: {} }, old, 2000);
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
    expect(mergeContents(reclaimed, { channels: [a], gone: {} })).toEqual({ contents: reclaimed, conflicts: [] });
  });

  test("removing a passkey rotates the vault key and the writer: the lost device can neither open nor save", async () => {
    const kept = passkey("cred-keep");
    const lost = passkey("cred-lost");
    const contents = { channels: [entry("mc2-a", "pkA")], gone: {} };
    const first = await newVault("frank", contents, kept);
    expect(await putVault(relay, tok("frank"), "frank", 0, first.blob, first.writer, first.writer.pk)).toEqual({ version: 1 });
    const opened = await openVault(first.blob, "frank", first.key, 1);
    const two = await addWrap(first.blob, "frank", first.key, opened, 2, lost);
    expect(await putVault(relay, tok("frank"), "frank", 1, two, opened.writer)).toEqual({ version: 2 });

    const r = await rotateVault("frank", await openVault(two, "frank", first.key, 2), 3, kept);
    expect(await putVault(relay, tok("frank"), "frank", 2, r.blob, opened.writer, r.writer.pk)).toEqual({ version: 3 });
    expect(await unlock(r.blob, "frank", lost.secret, "cred-lost")).toBeNull();
    expect(await unlock(r.blob, "frank", kept.secret, "cred-keep")).toBe(r.key);
    expect(await unlock(r.blob, "frank", recoverySecret(r.recoveryCode)!)).toBe(r.key);
    await expect(openVault(r.blob, "frank", first.key, 3)).rejects.toThrow();
    // The lost device still has the old writer key: the relay no longer takes it.
    await expect(putVault(relay, tok("frank"), "frank", 3, "overwrite", opened.writer)).rejects.toThrow(/writer key/);
    expect((await openVault(r.blob, "frank", r.key, 3)).channels).toEqual(contents.channels);
  });
});

describe("two devices", () => {
  test("saving at once: the second merges on 409 and both seats land", async () => {
    const { key, blob, writer } = await newVault("gina", empty, passkey());
    expect(await putVault(relay, tok("gina"), "gina", 0, blob, writer, writer.pk)).toEqual({ version: 1 });
    const add = (e: VaultEntry) => (c: VaultContents) => mergeContents(c, { channels: [e], gone: {} }).contents;

    // The phone reads version 1, then the laptop saves first.
    const phoneRead = (await fetchVault(relay, tok("gina")))!;
    const phoneOpened = await openVault(phoneRead.blob, "gina", key, 1);
    await syncVault(relay, tok("gina"), "gina", key, add(entry("mc2-laptop", "pkL")));
    const phoneBlob = await resealVault(phoneRead.blob, "gina", key, phoneOpened, 2, add(entry("mc2-phone", "pkP"))(phoneOpened));
    expect(await putVault(relay, tok("gina"), "gina", 1, phoneBlob, phoneOpened.writer)).toEqual({ conflict: 2 });

    // The phone does what syncVault does on a conflict: read again, re-apply, save.
    const done = await syncVault(relay, tok("gina"), "gina", await vaultKey(key), add(entry("mc2-phone", "pkP")), 2);
    expect(done.version).toBe(3);
    const got = (await fetchVault(relay, tok("gina")))!;
    expect((await openVault(got.blob, "gina", key, got.version)).channels.map((c) => c.code).sort()).toEqual(["mc2-laptop", "mc2-phone"]);
  });
});
