// The vault on the Cloudflare Worker itself (wrangler dev), signed in through a stand-in for WorkOS.
// Slow and needs wrangler, so it runs only with KIWI_WORKER_E2E=1.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64url } from "../src/crypto.ts";
import { fetchVault, newVault, openVault, putVault, resealVault } from "../src/vault.ts";

const on = process.env.KIWI_WORKER_E2E === "1";
setDefaultTimeout(120_000);

const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as { n: string; e: string };
let jwks: ReturnType<typeof Bun.serve>;
let worker: ReturnType<typeof Bun.spawn> | undefined;
const persist = mkdtempSync(join(tmpdir(), "kiwi-worker-"));
const port = 8900 + Math.floor(Math.random() * 90);
const relay = `http://127.0.0.1:${port}`;

async function token(sub: string): Promise<string> {
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc({ sub, iss: jwks.url.origin, exp: Math.floor(Date.now() / 1000) + 300 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  if (!on) return;
  jwks = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] }) });
  worker = Bun.spawn(["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--var", "WORKOS_CLIENT_ID:client_test", "--var", `WORKOS_AUTHKIT_DOMAIN:${jwks.url.origin}`], {
    cwd: join(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${relay}/v1/config`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev didn't come up");
});
afterAll(() => {
  worker?.kill();
  jwks?.stop(true);
  rmSync(persist, { recursive: true, force: true });
});

test.skipIf(!on)("setup, a second setup, a signed save and a thief, on the Worker", async () => {
  const user = `user_${crypto.randomUUID().slice(0, 8)}`;
  const t = await token(user);
  const secret = () => ({ kind: "passkey" as const, label: "t", secret: crypto.getRandomValues(new Uint8Array(32)), credentialId: crypto.randomUUID() });
  const first = await newVault(user, { channels: [], gone: {} }, secret());
  expect(await putVault(relay, t, user, 0, first.blob, first.writer, first.writer.pk)).toEqual({ version: 1 });
  // The prod bug: a second setup with a new writer must be a 409, not a 403.
  const second = await newVault(user, { channels: [], gone: {} }, secret());
  expect(await putVault(relay, t, user, 0, second.blob, second.writer, second.writer.pk)).toEqual({ conflict: 1 });
  // The real device saves, signed by its writer.
  const got = (await fetchVault(relay, t))!;
  const opened = await openVault(got.blob, user, first.key, 1);
  expect(await putVault(relay, t, user, 1, await resealVault(got.blob, user, first.key, opened, 2, opened), opened.writer)).toEqual({ version: 2 });
  // Someone with the session but not the writer key, at the right version: 403.
  await expect(putVault(relay, t, user, 2, second.blob, second.writer)).rejects.toThrow(/writer key/);
});
