import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../src/relay/bun.ts";
import { workosFromSettings } from "../src/relay/human.ts";

// A stand-in for web/dist: the app, a fingerprinted asset, an installer, and Cloudflare's config file.
const tmp = mkdtempSync(join(tmpdir(), "kiwi-web-"));
const dist = join(tmp, "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
writeFileSync(join(dist, "install.sh"), "#!/bin/sh\necho hi\n");
writeFileSync(join(dist, "_headers"), "/*\n  X-Test: 1\n");
writeFileSync(join(tmp, "secret.txt"), "outside the dashboard");

let server: ReturnType<typeof startRelay>;
let bare: ReturnType<typeof startRelay>;
let relay: string;

beforeAll(() => {
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: join(tmp, "data"), web: { dir: dist, connect: ["https://api.workos.com", "https://x.authkit.app"] } });
  bare = startRelay({ port: 0, hostname: "127.0.0.1", dataDir: join(tmp, "data2") });
  relay = server.url.origin;
});
afterAll(() => {
  server.stop(true);
  bare.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

describe("dashboard on the Bun relay", () => {
  test("pages get the app, with the dashboard's security headers", async () => {
    for (const path of ["/", "/auth/callback", "/some/page"]) {
      const res = await fetch(relay + path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>app</title>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' https://api.workos.com https://x.authkit.app;");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("files are served as they are; fingerprinted assets cache forever", async () => {
    const res = await fetch(`${relay}/assets/index-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const sh = await fetch(`${relay}/install.sh`);
    expect(sh.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("a missing file is a 404, not the app", async () => {
    expect((await fetch(`${relay}/assets/gone.js`)).status).toBe(404);
  });

  test("nothing outside the folder, and not Cloudflare's config", async () => {
    expect(await (await fetch(`${relay}/_headers`)).text()).not.toContain("X-Test");
    for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await fetch(relay + path);
      expect(await res.text()).not.toContain("outside the dashboard");
    }
  });

  test("the API still answers under /v1", async () => {
    const res = await fetch(`${relay}/v1/config`);
    expect(await res.json()).toEqual({ workosClientId: null });
    expect((await fetch(`${relay}/v1/nope`)).status).toBe(404);
  });

  test("without a dashboard, the relay answers as before", async () => {
    expect(await (await fetch(`${bare.url.origin}/`)).text()).toBe("Kiwi Channels relay (bun)\n");
    expect((await fetch(`${bare.url.origin}/auth/callback`)).status).toBe(404);
  });

  test("a dashboard folder that was never built is refused at startup", () => {
    expect(() => startRelay({ port: 0, hostname: "127.0.0.1", dataDir: join(tmp, "data3"), web: { dir: join(tmp, "nope") } })).toThrow("no index.html");
  });
});

describe("WorkOS settings", () => {
  test("no client id: no sign-in", () => {
    expect(workosFromSettings({})).toBeNull();
    expect(workosFromSettings({ authkitDomain: "https://x.authkit.app", apiKey: "sk" })).toBeNull();
  });

  test("a client id turns it on; the API key adds names", () => {
    expect(workosFromSettings({ clientId: "client_x" })?.clientId).toBe("client_x");
    expect(workosFromSettings({ clientId: "client_x" })?.profile).toBeUndefined();
    expect(workosFromSettings({ clientId: "client_x", apiKey: "sk" })?.profile).toBeFunction();
  });
});
