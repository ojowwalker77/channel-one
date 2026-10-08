import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, RelayError } from "../src/client.ts";
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
afterAll(async () => {
  // Close every channel the tests own, so nothing lingers on the relay (matters against a real one).
  for (const d of made) {
    try {
      const cfg = JSON.parse(readFileSync(join(d, "config.json"), "utf8")) as { channels: Record<string, { owner?: string }> };
      for (const [alias, c] of Object.entries(cfg.channels)) if (c.owner) await run(d, "-c", alias, "close", "--yes");
    } catch {}
  }
  server?.stop(true);
  // Test homes hold keys: don't leave them lying around in /tmp.
  for (const d of [dataDir, claudeDir, ...made]) rmSync(d, { recursive: true, force: true });
});

const MC = ["bun", join(import.meta.dir, "../src/cli/main.ts")];

// Tests never touch the real Claude Code settings.
const claudeDir = mkdtempSync(join(tmpdir(), "mc-claude-"));

function mc(home: string, ...args: string[]) {
  return Bun.spawn([...MC, ...args], {
    cwd: home,
    env: { ...process.env, MC_HOME: home, MC_RELAY: relay, CLAUDE_CONFIG_DIR: claudeDir },
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

const made: string[] = [];
const home = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `mc-${tag}-`));
  made.push(d);
  return d;
};

/**
 * Join through the real flow: the joiner asks and waits, the owner's machine
 * sees the request, matches the verification code and approves.
 */
async function joinVia(owner: string, joiner: string, code: string, alias: string, name: string, role?: string): Promise<string> {
  const p = mc(joiner, "join", code, alias, "--as", name, ...(role ? ["--role", role] : []));
  const l = lines(p);
  await l.until((x) => x.some((y) => /verification code \d{3}-\d{3}/.test(y)));
  const v = /verification code (\d{3}-\d{3})/.exec(l.got.join("\n"))![1]!;
  expect(await ok(owner, "requests")).toContain(`${v}  ${name}`);
  await ok(owner, "approve", v, "--yes");
  expect(await p.exited).toBe(0);
  await l.until((x) => x.some((y) => y.includes("You are agent")));
  return l.got.join("\n");
}

describe("presence over a membership channel", () => {
  test("presence is relayed between members but never stored", async () => {
    const [human, mac, win] = await Promise.all([generateIdentity("human"), generateIdentity("mac"), generateIdentity("win")]);
    const { access } = await Channel.create(relay, human, { name: "human" }, [
      { ...mac, info: { name: "mac" } },
      { ...win, info: { name: "win" } },
    ]);
    const macCh = new Channel({ ...access, keys: { ...access.keys } }, relay, mac);
    const winCh = new Channel({ ...access, keys: { ...access.keys } }, relay, win);
    await macCh.send("before");
    const got: Message[] = [];
    const seenPresence: string[] = [];
    const ac = new AbortController();
    const done = winCh.stream(0, (m) => void got.push(m), { signal: ac.signal, onPresence: (p) => void seenPresence.push(`${p.from}:${p.sigOk}`) });
    while (got.length < 1) await Bun.sleep(10);
    const ac2 = new AbortController();
    const macStream = macCh.stream(await macCh.head(), () => {}, { signal: ac2.signal, onOpen: ({ presence }) => void presence({ client: "test" }) });
    await macCh.send("live");
    while (got.length < 2 || !seenPresence.length) await Bun.sleep(10);
    ac.abort();
    ac2.abort();
    await Promise.all([done, macStream]);
    expect(got.map((m) => m.body)).toEqual(["before", "live"]);
    expect(seenPresence).toEqual(["mac:true"]);
    expect(await winCh.head()).toBe(2);
    await new Channel(access, relay, human).close();
  });
});

describe("agents coordinating through the CLI", () => {
  const lead = home("lead");
  const mac = home("mac");
  const win = home("win");
  let code = "";

  test("create, then join only with the owner's approval; names can't be taken twice", async () => {
    const created = await ok(lead, "create", "proj", "--as", "lead", "--role", "planner");
    code = /join code: (\S+)/.exec(created)![1]!;
    expect(created).toContain("owner dashboard");
    const joined = await joinVia(lead, mac, code, "proj", "mac", "macos");
    expect(joined).toContain('You are agent "mac"');
    expect(joined).toContain("mc tail");
    await joinVia(lead, win, code, "proj", "win", "windows");

    // Someone else with the leaked code asks to be "win": approval refuses the duplicate name; the owner denies.
    const evil = mc(home("evil"), "join", code, "proj", "--as", "win", "--timeout", "20s");
    const el = lines(evil);
    await el.until((x) => x.some((y) => /verification code/.test(y)));
    const v = /verification code (\d{3}-\d{3})/.exec(el.got.join("\n"))![1]!;
    const dup = await run(lead, "approve", v, "--yes");
    expect(dup.code).toBe(1);
    expect(dup.err).toContain('"win" is already a member');
    // Without --yes (and no terminal to ask on), approval refuses: an agent can't wave someone in by itself.
    expect((await run(lead, "approve", v, "--name", "win2")).err).toContain("needs your human's go-ahead");
    await ok(lead, "deny", v);
    expect(await evil.exited).toBe(1);

    // Agents can't approve: only the owner's machine sees requests.
    expect((await run(mac, "requests")).err).toContain("only the channel owner");

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

describe("leaving, removal and closing through the CLI", () => {
  test("access ends at once and every local copy is wiped", async () => {
    const owner = home("x-owner");
    const a = home("x-a");
    const b = home("x-b");
    const code = /join code: (\S+)/.exec(await ok(owner, "create", "x", "--as", "boss"))![1]!;
    await joinVia(owner, a, code, "x", "alice");
    await joinVia(owner, b, code, "x", "bob");
    await ok(a, "send", "hi from alice");

    // alice leaves: she's out and forgets the channel; the owner's next command rotates the key.
    expect(await ok(a, "leave")).toContain("left");
    expect(await ok(a, "channels")).toBe("");
    // Her keys for this channel are destroyed with it, so no backup of the relay can ever be opened with them.
    expect(readdirSync(join(a, "identities"))).toEqual([]);
    expect(await ok(owner, "members")).toContain("alice · key");
    expect(await ok(owner, "members")).toContain("(left)");
    await ok(b, "send", "after alice left");
    expect(await ok(owner, "log")).toContain("after alice left");

    // bob is kicked: his next command fails, and his machine forgets the channel.
    expect(await ok(owner, "kick", "bob")).toContain("rotated");
    const after = await run(b, "status");
    expect(after.code).toBe(4);
    expect(after.err).toContain("no longer a member");
    expect(await ok(b, "channels")).toBe("");
    expect(readdirSync(join(b, "identities"))).toEqual([]);

    // The owner closes it: deleted at the relay, nothing left locally.
    expect((await run(owner, "close")).err).toContain("go-ahead");
    expect(await ok(owner, "close", "--yes")).toContain("closed");
    expect(await ok(owner, "channels")).toBe("");
    expect(readdirSync(join(owner, "identities"))).toEqual([]);
    expect(readdirSync(join(owner, "cache"))).toEqual([]);
    if (!external) expect(readdirSync(dataDir).filter((f) => f.endsWith(".sqlite")).length).toBeGreaterThan(0);
  });
});

describe("images and cross-channel tasks through the CLI", () => {
  test("quick, send --image, log markers, save, oversize rejected, tasks --global", async () => {
    const a = home("imgcli");
    const created = await ok(a, "quick", "pics", "--as", "pic");
    const code = /join code: (\S+)/.exec(created)![1]!;
    expect(created).toContain("owner dashboard");
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
    expect(code.startsWith("mc2-")).toBe(true);
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
    await joinVia(a, b, code, "w", "peer");
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

describe("several agents on one machine", () => {
  test("each agent keeps its own name, by folder; nothing guesses between them", async () => {
    const owner = home("multi-owner");
    const shared = home("multi-shared"); // one MC_HOME, like two agents on the same Mac
    const dirA = home("multi-a");
    const dirB = home("multi-b");
    const code = /join code: (\S+)/.exec(await ok(owner, "create", "m", "--as", "boss"))![1]!;

    const inDir = (dir: string, ...args: string[]) =>
      Bun.spawn([...MC, ...args], { cwd: dir, env: { ...process.env, MC_HOME: shared, MC_RELAY: relay, CLAUDE_CONFIG_DIR: claudeDir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const runIn = async (dir: string, ...args: string[]) => {
      const p = inDir(dir, ...args);
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    const joinFrom = async (dir: string, name: string) => {
      const p = inDir(dir, "join", code, "--as", name);
      const l = lines(p);
      await l.until((x) => x.some((y) => /verification code/.test(y)));
      await ok(owner, "approve", /verification code (\d{3}-\d{3})/.exec(l.got.join("\n"))![1]!, "--yes");
      expect(await p.exited).toBe(0);
    };
    await joinFrom(dirA, "alpha");
    await joinFrom(dirB, "beta"); // beta joined last: it must not take over alpha's folder

    expect((await runIn(dirA, "send", "from a")).code).toBe(0);
    expect((await runIn(dirB, "send", "from b")).code).toBe(0);
    const log = await ok(owner, "log");
    expect(log).toMatch(/alpha → all: from a/);
    expect(log).toMatch(/beta → all: from b/);

    // Outside either folder there's no way to know who's speaking: refuse instead of guessing.
    const elsewhere = home("multi-elsewhere");
    const r = await runIn(elsewhere, "send", "who am i");
    expect(r.code).toBe(1);
    expect(r.err).toContain("several agents on this machine are in this channel");
    expect((await runIn(elsewhere, "--as", "beta", "send", "explicit")).code).toBe(0);
  });

  test("agents in different channels on one machine never touch each other's state", async () => {
    const ownerA = home("iso-owner-a");
    const ownerB = home("iso-owner-b");
    const shared = home("iso-shared"); // one MC_HOME for every agent on this "machine"
    const [dirA, dirB, dirC, elsewhere] = [home("iso-a"), home("iso-b"), home("iso-c"), home("iso-elsewhere")];
    const codeA = /join code: (\S+)/.exec(await ok(ownerA, "create", "a", "--as", "boss"))![1]!;
    const codeB = /join code: (\S+)/.exec(await ok(ownerB, "create", "b", "--as", "boss"))![1]!;

    const inDir = (dir: string, ...args: string[]) =>
      Bun.spawn([...MC, ...args], { cwd: dir, env: { ...process.env, MC_HOME: shared, MC_RELAY: relay, CLAUDE_CONFIG_DIR: claudeDir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const runIn = async (dir: string, ...args: string[]) => {
      const p = inDir(dir, ...args);
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    const joinFrom = async (dir: string, owner: string, code: string, name: string) => {
      const p = inDir(dir, "join", code, "--as", name);
      const l = lines(p);
      await l.until((x) => x.some((y) => /verification code/.test(y)));
      await ok(owner, "approve", /verification code (\d{3}-\d{3})/.exec(l.got.join("\n"))![1]!, "--yes");
      expect(await p.exited).toBe(0);
    };
    // Joined concurrently, like separate sessions: neither may lose the other's config.
    await Promise.all([joinFrom(dirA, ownerA, codeA, "alpha"), joinFrom(dirB, ownerB, codeB, "beta")]);
    await joinFrom(dirC, ownerA, codeA, "gamma"); // a second local agent in channel a

    // Outside a bound folder, with several channels here, nothing picks one for you.
    const r = await runIn(elsewhere, "send", "where does this go");
    expect(r.code).toBe(1);
    expect(r.err).toContain("isn't bound to a channel");

    // Removing gamma forgets gamma only; alpha, in the same channel, keeps its key.
    await ok(ownerA, "kick", "gamma");
    expect((await runIn(dirC, "status")).code).toBe(4);
    expect((await runIn(dirA, "send", "alpha still here")).code).toBe(0);

    // Closing b forgets b only; a is untouched.
    await ok(ownerB, "close", "--yes");
    expect((await runIn(dirB, "status")).code).toBe(4);
    expect((await runIn(dirA, "send", "a is fine")).code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(shared, "config.json"), "utf8")) as { channels: Record<string, unknown>; bindings: Record<string, { as: string }> };
    expect(Object.keys(cfg.channels)).toHaveLength(1);
    expect(Object.values(cfg.bindings).map((b) => b.as)).toEqual(["alpha"]);
    expect(await ok(ownerA, "log")).toMatch(/alpha → all: a is fine/);
  });

  test("a home folder is never bound", async () => {
    const owner = home("hb-owner");
    const h = home("hb-home");
    const code = /join code: (\S+)/.exec(await ok(owner, "create", "hb", "--as", "boss"))![1]!;
    const p = Bun.spawn([...MC, "join", code, "--as", "solo"], { cwd: h, env: { ...process.env, HOME: h, MC_HOME: h, MC_RELAY: relay, CLAUDE_CONFIG_DIR: claudeDir }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const l = lines(p);
    await l.until((x) => x.some((y) => /verification code/.test(y)));
    await ok(owner, "approve", /verification code (\d{3}-\d{3})/.exec(l.got.join("\n"))![1]!, "--yes");
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stderr).text()).toContain("too broad");
    expect(JSON.parse(readFileSync(join(h, "config.json"), "utf8")).bindings ?? {}).toEqual({});
  });
});

describe("Claude Code hooks", () => {
  async function hook(dir: string, mcHome: string, event: string, input: object): Promise<string> {
    const p = Bun.spawn([...MC, "hook", event], {
      cwd: dir,
      env: { ...process.env, MC_HOME: mcHome, MC_RELAY: relay, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_PROJECT_DIR: "" },
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    return out;
  }

  test("joining installs them; stop won't let an agent go idle behind or deaf", async () => {
    const o = home("hk-owner");
    const a = home("hk-agent");
    const code = /join code: (\S+)/.exec(await ok(o, "create", "hk", "--as", "boss"))![1]!;
    await joinVia(o, a, code, "hk", "worker");

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    for (const e of ["SessionStart", "UserPromptSubmit", "Stop"]) expect(JSON.stringify(settings.hooks[e])).toContain("# channel-one");

    // Nothing listening: the first stop is blocked, then it nags at most every 10 minutes.
    expect(await hook(a, a, "stop", { cwd: a, session_id: "s1" })).toContain("nothing listening");
    expect(await hook(a, a, "stop", { cwd: a, session_id: "s1" })).toBe("");

    // Unread messages always block a stop, and are handed to the agent.
    await ok(o, "send", "--to", "worker", "hello worker");
    const blocked = JSON.parse(await hook(a, a, "stop", { cwd: a, session_id: "s1" }));
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("boss → worker: hello worker");

    // Listening: session start says so, and a caught-up agent may stop.
    const tail = lines(mc(a, "tail"));
    await Bun.sleep(800);
    expect(await hook(a, a, "session-start", { cwd: a })).toContain("A listener is already running");
    expect(await hook(a, a, "stop", { cwd: a, session_id: "s2" })).toBe("");
    await ok(o, "send", "--to", "worker", "while listening");
    await tail.until((l) => l.some((x) => x.includes("while listening")));
    await tail.stop();

    // A directory nobody joined from: the hooks do nothing at all.
    const elsewhere = home("hk-elsewhere");
    expect(await hook(elsewhere, a, "stop", { cwd: elsewhere, session_id: "s3" })).toBe("");
    expect(await hook(elsewhere, a, "prompt", { cwd: elsewhere })).toBe("");

    // Uninstall leaves the rest of the settings alone.
    await ok(a, "hooks", "uninstall");
    expect(JSON.stringify(JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")))).not.toContain("channel-one");
  });
});

describe("MCP server", () => {
  test("exits when its client goes away", async () => {
    const h = home("mcp-exit");
    await ok(h, "create", "e", "--as", "solo");
    const p = Bun.spawn([...MC, "mcp"], { env: { ...process.env, MC_HOME: h, MC_RELAY: relay }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(500);
    p.stdin.end();
    const code = await Promise.race([p.exited, Bun.sleep(5000).then(() => "still running")]);
    if (code === "still running") p.kill();
    expect(code).toBe(0);
  });

  test("exposes the channel as tools", async () => {
    const h = home("mcp");
    const other = home("mcp-other");
    const code = /join code: (\S+)/.exec(await ok(h, "create", "m", "--as", "agent-a", "--role", "builder"))![1]!;
    await joinVia(h, other, code, "m", "agent-b");

    const p = Bun.spawn([...MC, "mcp"], { env: { ...process.env, MC_HOME: h, MC_RELAY: relay }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
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
      expect(tools).toEqual(["ask", "claim", "decide_join", "facts", "join_requests", "log", "members", "read", "release", "reply", "save", "send", "status", "task_add", "task_update", "tasks", "who"]);

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
    } finally {
      p.kill();
    }
  });
});
