import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, RelayError } from "../src/client.ts";
import { deriveChannel, generateCode } from "../src/crypto.ts";
import { generateIdentity } from "../src/identity.ts";
import type { Message } from "../src/protocol.ts";
import { startRelay } from "../src/relay/bun.ts";

// MC_TEST_RELAY=http://localhost:8787 runs the suite against another relay,
// e.g. the Cloudflare one under `wrangler dev`.
const external = process.env.MC_TEST_RELAY;
// Real network round trips (and process spawns) need more than Bun's 5s default.
setDefaultTimeout(60_000);

const dataDir = mkdtempSync(join(tmpdir(), "mc-relay-"));
let server: ReturnType<typeof startRelay> | undefined;
let relay: string;

beforeAll(() => {
  if (external) return void (relay = external);
  server = startRelay({ port: 0, hostname: "127.0.0.1", dataDir });
  relay = server.url.origin;
});
afterAll(() => server?.stop(true));

const MC = ["bun", join(import.meta.dir, "../src/cli/main.ts")];

function mc(home: string, ...args: string[]) {
  return Bun.spawn([...MC, ...args], {
    env: { ...process.env, MC_HOME: home, MC_RELAY: relay },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function run(home: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = mc(home, ...args);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

async function ok(home: string, ...args: string[]): Promise<string> {
  const r = await run(home, ...args);
  if (r.code !== 0) throw new Error(`mc ${args.join(" ")} exited ${r.code}: ${r.err}`);
  return r.out;
}

/** Collect a long-running process's stdout lines as they arrive. */
function lines(p: ReturnType<typeof mc>) {
  const got: string[] = [];
  let buf = "";
  const reader = p.stdout.getReader();
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) (got.push(buf.slice(0, i)), (buf = buf.slice(i + 1)));
    }
  })();
  return {
    got,
    async until(pred: (l: string[]) => boolean, ms = 15_000) {
      const end = Date.now() + ms;
      while (!pred(got)) {
        if (Date.now() > end) throw new Error(`timed out; got:\n${got.join("\n")}`);
        await Bun.sleep(25);
      }
    },
    stop: async () => {
      p.kill();
      await done;
    },
  };
}

const home = (tag: string) => mkdtempSync(join(tmpdir(), `mc-${tag}-`));

describe("relay and client", () => {
  async function newChannel() {
    const keys = await deriveChannel(generateCode());
    const mac = new Channel(keys, relay, await generateIdentity("mac"));
    await mac.create();
    const win = new Channel(keys, relay, await generateIdentity("win"));
    return { mac, win };
  }

  test("signed round trip, encrypted at rest", async () => {
    const { mac, win } = await newChannel();
    const seq = await mac.send("secret plan: ship it", { to: ["win"], kind: "ask" });
    const { messages } = await win.history(0);
    expect(messages[0]).toMatchObject({ seq, from: "mac", to: ["win"], kind: "ask", body: "secret plan: ship it", sigOk: true });
    if (external) return;
    const file = readdirSync(dataDir).find((f) => f.startsWith(mac.keys.roomId) && f.endsWith(".sqlite"))!;
    const raw = readFileSync(join(dataDir, file));
    expect(raw.includes("secret plan")).toBe(false);
    expect(raw.includes("mac")).toBe(false);
  });

  test("wrong token is rejected, unknown room is 404", async () => {
    const { mac } = await newChannel();
    const forged = new Channel({ ...mac.keys, token: "nope" }, relay, null, "x");
    await expect(forged.head()).rejects.toMatchObject({ status: 403 });
    const stranger = new Channel(await deriveChannel(generateCode()), relay, null, "x");
    await expect(stranger.head()).rejects.toBeInstanceOf(RelayError);
  });

  test("stream replays after reconnect; presence is relayed but never stored", async () => {
    const { mac, win } = await newChannel();
    await mac.send("before");
    const got: Message[] = [];
    const seenPresence: string[] = [];
    const ac = new AbortController();
    const done = win.stream(0, (m) => void got.push(m), { signal: ac.signal, onPresence: (p) => void seenPresence.push(`${p.from}:${p.sigOk}`) });
    while (got.length < 1) await Bun.sleep(10);

    const ac2 = new AbortController();
    const macStream = mac.stream(await mac.head(), () => {}, { signal: ac2.signal, onOpen: ({ presence }) => void presence({ client: "test" }) });
    await mac.send("live");
    while (got.length < 2 || !seenPresence.length) await Bun.sleep(10);
    ac.abort();
    ac2.abort();
    await Promise.all([done, macStream]);
    expect(got.map((m) => m.body)).toEqual(["before", "live"]);
    expect(seenPresence).toEqual(["mac:true"]);
    expect(await win.head()).toBe(2);
  });
});

describe("agents coordinating through the CLI", () => {
  const lead = home("lead");
  const mac = home("mac");
  const win = home("win");
  let code = "";

  test("create and join: announce roles, print agent instructions, protect names", async () => {
    const created = await ok(lead, "create", "proj", "--as", "lead", "--role", "planner");
    code = /join code: (\S+)/.exec(created)![1]!;
    const joined = await ok(mac, "join", code, "proj", "--as", "mac", "--role", "macos");
    expect(joined).toContain('You are agent "mac"');
    expect(joined).toContain("mc tail");
    await ok(win, "join", code, "proj", "--as", "win", "--role", "windows");

    const impostor = await run(home("evil"), "join", code, "proj", "--as", "win");
    expect(impostor.code).toBe(1);
    expect(impostor.err).toContain('"win" already belongs to another key');

    const status = await ok(lead, "status");
    expect(status).toContain("lead (you) — planner");
    expect(status).toContain("mac — macos");
    expect(status).toContain("win — windows");
  });

  test("tail wakes on messages for you, skips your own, and announces presence", async () => {
    const tail = lines(mc(win, "tail"));
    await Bun.sleep(800);
    expect(await ok(mac, "who")).toContain("win — windows · tail");
    await ok(win, "send", "my own message");
    await ok(mac, "send", "--to", "win", "--kind", "status", "capture is up");
    await tail.until((l) => l.some((x) => x.includes("capture is up")));
    await tail.stop();
    expect(tail.got.join("\n")).not.toContain("my own message");
    expect(tail.got.at(-1)).toMatch(/^#\d+ mac → win \[status\]: capture is up$/);
  });

  test("ask --wait returns the answer in one call, without a duplicate wake-up", async () => {
    const backlog = await ok(mac, "read");
    expect(backlog).toContain("win → all [event]: joined as windows");
    expect(backlog).not.toContain("forged");
    const asker = mc(mac, "ask", "--to", "win", "--wait", "30s", "which edge is the PC on?");
    const wait = await ok(win, "wait", "--timeout", "20s");
    const askSeq = /^#(\d+) mac → win \[ask\]/m.exec(wait)![1]!;
    await ok(win, "reply", askSeq, "the left edge");
    const answer = await new Response(asker.stdout).text();
    expect(await asker.exited).toBe(0);
    expect(answer.trim()).toMatch(new RegExp(`^#\\d+ win → mac re #${askSeq}: the left edge$`));
    expect(await ok(mac, "read")).toBe("");
  });

  test("task board: owners, races, dependencies and notifications", async () => {
    await ok(lead, "read");
    const t1 = /added (T\d+)/.exec(await ok(lead, "task", "add", "Define protocol v2"))![1]!;
    const t2 = /added (T\d+)/.exec(await ok(lead, "task", "add", "Windows client for v2", "--owner", "win", "--after", t1))![1]!;

    // win is told it was given a task.
    expect(await ok(win, "read")).toContain(`added task ${t2} “Windows client for v2” for win after ${t1}`);

    // mac claims T1; win can't take it.
    expect(await ok(mac, "task", "claim", t1)).toBe(`${t1} doing @mac: Define protocol v2\n`);
    const stolen = await run(win, "task", "claim", t1);
    expect(stolen.code).toBe(1);
    expect(stolen.err).toContain("is owned by mac");

    // Finishing T1 notifies its creator and the owner of the task waiting on it.
    await ok(mac, "task", "done", t1, "spec in docs/v2.md");
    expect(await ok(lead, "read")).toContain(`finished ${t1} “Define protocol v2”: spec in docs/v2.md`);
    expect(await ok(win, "read")).toContain(`finished ${t1}`);

    const board = await ok(win, "tasks", "--all");
    expect(board).toMatch(new RegExp(`${t2}\\s+todo\\s+@win Windows client for v2`));
    expect(await ok(win, "task", "show", t2)).toContain(`after: ${t1} (done) — all done`);
  });

  test("claims block overlapping edits until released", async () => {
    expect(await ok(win, "claim", "crates/net", "--ttl", "20m", "--note", "refactor")).toContain("crates/net  @win");
    const clash = await run(mac, "claim", "crates/net/tcp.rs");
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("crates/net is claimed by win");
    await ok(win, "release");
    expect(await ok(mac, "claim", "crates/net/tcp.rs")).toContain("crates/net/tcp.rs  @mac");
    expect(await ok(lead, "claims")).toContain("@mac");
  });

  test("facts are shared and last write wins", async () => {
    await ok(mac, "set", "mac.ip", "192.168.1.20");
    await ok(win, "set", "mac.ip", "192.168.1.21");
    expect((await ok(lead, "get", "mac.ip")).trim()).toBe("192.168.1.21");
    expect(await ok(lead, "facts")).toContain("mac.ip = 192.168.1.21  (win)");
    expect((await run(lead, "get", "nope")).code).toBe(2);
  });

  test("role addressing and the status snapshot", async () => {
    await ok(lead, "ask", "--to", "role:windows", "status of the v2 client?");
    const status = await ok(win, "status");
    expect(status).toContain("waiting on you (1)");
    expect(status).toContain("status of the v2 client?");
    expect(status).toMatch(/tasks \(\d+ open, 1 done\)/);
    expect(status).toContain("mac.ip = 192.168.1.21");
  });
});

describe("images and cross-channel tasks through the CLI", () => {
  test("quick, send --image, log markers, save, oversize rejected, tasks --global", async () => {
    const a = home("imgcli");
    const created = await ok(a, "quick", "pics", "--as", "pic");
    const code = /join code: (\S+)/.exec(created)![1]!;
    expect(created).toContain("watch it live:");
    expect(created).toContain('You are agent "pic"');

    // No --as needed: falls back to the OS user.
    const plain = await ok(home("plaincli"), "create", "plain");
    expect(plain).toMatch(/join code: \S+/);

    const dir = home("imgfiles");
    mkdirSync(dir, { recursive: true });
    const png = join(dir, "shot.png");
    await Bun.write(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const sent = await ok(a, "send", "--image", png, "the dialog");
    const seq = /sent #(\d+)/.exec(sent)![1]!;
    expect(code.startsWith("mc1-")).toBe(true);
    expect(await ok(a, "log", "-n", "3")).toContain("[image: shot.png");
    expect((await ok(a, "save", seq, dir)).trim()).toBe(join(dir, `#${seq}-shot.png`));

    const big = join(dir, "big.png");
    await Bun.write(big, Buffer.alloc(300 * 1024));
    const rej = await run(a, "send", "--image", big, "too big");
    expect(rej.code).toBe(1);
    expect(rej.err).toContain("limit");

    await ok(a, "create", "second", "--as", "pic");
    await ok(a, "task", "add", "second task");
    const all = await ok(a, "tasks", "--global");
    expect(all).toContain("## pics");
    expect(all).toContain("## second");
    expect(all).toContain("second task");
  });

  test("watch POSTs every message to a webhook", async () => {
    const a = home("watcher");
    const created = await ok(a, "create", "w", "--as", "eye");
    const code = /join code: (\S+)/.exec(created)![1]!;
    const b = home("watchsender");
    await ok(b, "join", code, "w", "--as", "peer");
    const hooks: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") hooks.push(await req.text());
        return new Response("ok");
      },
    });
    const watching = mc(a, "watch", "--webhook", `http://127.0.0.1:${server.port}/hook`);
    const linesP = lines(watching);
    await Bun.sleep(1500);
    await ok(b, "send", "ping the hook");
    const end = Date.now() + 15_000;
    while (!hooks.length && Date.now() < end) await Bun.sleep(50);
    watching.kill();
    await linesP.stop().catch(() => {});
    server.stop(true);
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    const bodies = hooks.map((h) => JSON.parse(h) as { from: string; text: string; kind: string });
    expect(bodies).toContainEqual(expect.objectContaining({ channel: "w", from: "peer", text: "ping the hook", kind: "msg" }));
  });
});

describe("MCP server", () => {
  test("exposes the channel as tools", async () => {
    const h = home("mcp");
    const other = home("mcp-other");
    const code = /join code: (\S+)/.exec(await ok(h, "create", "m", "--as", "agent-a", "--role", "builder"))![1]!;
    await ok(other, "join", code, "m", "--as", "agent-b");

    const p = Bun.spawn([...MC, "mcp"], { env: { ...process.env, MC_HOME: h, MC_RELAY: relay }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let buf = "";
    let id = 0;
    const rpc = async (method: string, params: object = {}) => {
      const myId = ++id;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      p.stdin.flush();
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line);
          if (msg.id === myId) return msg.result ?? msg.error;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("mcp exited");
        buf += new TextDecoder().decode(value);
      }
    };
    const call = async (name: string, args: object = {}) => ((await rpc("tools/call", { name, arguments: args })) as { content: { text: string }[] }).content[0]!.text;

    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })) as { instructions: string };
    expect(init.instructions).toContain('You are "agent-a"');
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = ((await rpc("tools/list")) as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["ask", "claim", "facts", "log", "read", "release", "reply", "save", "send", "status", "task_add", "task_update", "tasks", "who"]);

    expect(await call("task_add", { title: "write docs" })).toMatch(/^added T\d+$/);
    expect(await call("claim", { paths: ["docs/"], ttl: "10m" })).toContain("docs/  @agent-a");
    expect(await call("status")).toContain("agent-a (you) — builder");
    expect(await call("facts", { set: "docs.url", value: "https://example.com" })).toContain("docs.url = https://example.com");
    expect(await ok(other, "tasks")).toContain("write docs");

    // Images round-trip: send with a file, read back pixels, save to disk.
    const png = join(home("img"), "shot.png");
    mkdirSync(join(home("img")), { recursive: true });
    await Bun.write(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const sent = await call("send", { text: "the dialog", images: [png] });
    expect(sent).toMatch(/^sent #\d+$/);
    const seq = Number(/^sent #(\d+)$/.exec(sent)![1]);
    const logRes = (await rpc("tools/call", { name: "log", arguments: {} })) as {
      content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
    };
    expect(logRes.content[0]!.type).toBe("text");
    expect((logRes.content[0] as { text: string }).text).toContain("[image: shot.png");
    const imgBlock = logRes.content.find((c) => c.type === "image") as unknown as { data: string; mimeType: string };
    expect(imgBlock.mimeType).toBe("image/png");
    expect(await call("save", { seq })).toContain(`#${seq}-shot.png`);
    expect(await ok(other, "who")).toContain("nobody else is listening right now");
    p.kill();
  });
});
