// Client for one channel: send (signed), read history, stream live messages
// and ephemeral presence. Runs in Bun and in the browser.

import { open, seal, type ChannelKeys } from "./crypto.ts";
import { sign, verify, type Identity } from "./identity.ts";
import {
  PING,
  PROTOCOL_VERSION,
  WS_PROTOCOL,
  type Envelope,
  type Event,
  type Kind,
  type Message,
  type Payload,
  type Presence,
  type ServerFrame,
} from "./protocol.ts";

export interface SendOptions {
  to?: string[];
  kind?: Kind;
  re?: number[];
  ev?: Event;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  onReady?: (head: number) => void;
  onStatus?: (s: string) => void;
  /** Called on every (re)connect with a way to send ephemeral presence. */
  onOpen?: (live: { presence: (p: Omit<Presence, "v" | "type" | "from" | "ts">) => Promise<void> }) => void;
  onPresence?: (p: Presence & { sigOk: boolean }) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Channel {
  readonly name: string;

  constructor(
    readonly keys: ChannelKeys,
    readonly relay: string,
    /** Signs everything sent. Without one, messages go out unsigned. */
    readonly identity: Identity | null,
    name?: string,
  ) {
    this.name = identity?.name ?? name ?? "";
  }

  private url(path: string, params: Record<string, string | number> = {}): URL {
    const u = new URL(`/v1/rooms/${this.keys.roomId}${path}`, this.relay);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u;
  }

  private async request<T>(path: string, init: RequestInit = {}, params: Record<string, string | number> = {}): Promise<T> {
    const res = await fetch(this.url(path, params), {
      ...init,
      headers: { authorization: `Bearer ${this.keys.token}`, "content-type": "application/json", ...init.headers },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new RelayError(res.status, body.error ?? `relay returned ${res.status}`);
    return body;
  }

  /** Claim a new room on the relay (or confirm we hold its token). */
  async create(): Promise<number> {
    return (await this.request<{ head: number }>("/", {}, { create: 1 })).head;
  }

  async head(): Promise<number> {
    return (await this.request<{ head: number }>("/")).head;
  }

  private async signed<T extends object>(obj: T): Promise<T> {
    return this.identity ? sign(this.identity, obj) : obj;
  }

  async send(body: string, opts: SendOptions = {}): Promise<number> {
    if (!this.name) throw new Error("no sender name");
    const payload: Payload = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      from: this.name,
      ...(opts.to?.length ? { to: opts.to } : {}),
      kind: opts.kind ?? (opts.ev ? "event" : "msg"),
      body,
      ...(opts.re?.length ? { re: opts.re } : {}),
      ...(opts.ev ? { ev: opts.ev } : {}),
      ts: Date.now(),
    };
    const sealed = await seal(this.keys, await this.signed(payload));
    return (await this.request<{ seq: number }>("/messages", { method: "POST", body: JSON.stringify(sealed) })).seq;
  }

  async decrypt(e: Envelope): Promise<Message | null> {
    const p = (await open(this.keys, e.iv, e.ct)) as Payload | null;
    if (!p || p.v !== PROTOCOL_VERSION || typeof p.body !== "string" || typeof p.from !== "string") return null;
    return { ...p, seq: e.seq, rts: e.ts, sigOk: await verify(p) };
  }

  /** Messages after `since`, oldest first, following pages to the head. */
  async history(since: number): Promise<{ head: number; messages: Message[] }> {
    const messages: Message[] = [];
    let head = since;
    for (;;) {
      const page = await this.request<{ head: number; messages: Envelope[] }>("/messages", {}, { since });
      head = page.head;
      // Decrypt the page concurrently; envelopes stay in relay order.
      const decrypted = await Promise.all(page.messages.map((e) => this.decrypt(e)));
      for (let i = 0; i < page.messages.length; i++) {
        const m = decrypted[i];
        if (m) messages.push(m);
        since = page.messages[i]!.seq;
      }
      if (!page.messages.length || since >= head) break;
    }
    return { head, messages };
  }

  /**
   * Stream messages after `since` until `signal` aborts. Replays anything
   * missed, reconnects with backoff, and resumes from the last delivered seq,
   * so nothing is lost across drops. `onMessage` runs strictly in order.
   */
  async stream(since: number, onMessage: (m: Message) => void | Promise<void>, opts: StreamOptions = {}): Promise<void> {
    let last = since;
    let backoff = 500;
    while (!opts.signal?.aborted) {
      const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
        const u = this.url("/ws", { since: last });
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(u, [WS_PROTOCOL, this.keys.token]);
        let queue = Promise.resolve();
        let ping: ReturnType<typeof setInterval> | undefined;
        const abort = () => ws.close(1000, "aborted");
        opts.signal?.addEventListener("abort", abort, { once: true });
        ws.onopen = () => {
          backoff = 500;
          ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(PING), 25_000);
          opts.onOpen?.({
            presence: async (p) => {
              if (ws.readyState !== WebSocket.OPEN || !this.name) return;
              const full: Presence = { v: PROTOCOL_VERSION, type: "presence", from: this.name, ts: Date.now(), ...p };
              const sealed = await seal(this.keys, await this.signed(full));
              ws.send(JSON.stringify({ t: "eph", ...sealed }));
            },
          });
        };
        ws.onmessage = (ev) => {
          const f = JSON.parse(String(ev.data)) as ServerFrame | { t: "pong" };
          queue = queue.then(async () => {
            if (f.t === "msg") {
              if (f.seq <= last) return;
              const m = await this.decrypt(f);
              last = f.seq;
              if (m) await onMessage(m);
            } else if (f.t === "eph") {
              if (!opts.onPresence) return;
              const p = (await open(this.keys, f.iv, f.ct)) as Presence | null;
              if (p?.type === "presence" && typeof p.from === "string") opts.onPresence({ ...p, sigOk: await verify(p) });
            } else if (f.t === "ready") {
              opts.onReady?.(f.head);
              // The relay replays at most one page on connect; reconnect for the rest.
              if (f.more) ws.close(4000, "more");
            }
          });
        };
        ws.onclose = (ev) => {
          clearInterval(ping);
          opts.signal?.removeEventListener("abort", abort);
          queue.then(() => resolve({ code: ev.code, reason: ev.reason }));
        };
        ws.onerror = () => {};
      });
      if (opts.signal?.aborted) return;
      if (closed.code === 4000) continue;
      opts.onStatus?.(`disconnected (${closed.code}${closed.reason ? ` ${closed.reason}` : ""}), retrying in ${backoff}ms`);
      // Upgrade failures (bad token, missing room) look like plain drops; check before retrying.
      try {
        await this.head();
      } catch (err) {
        if (err instanceof RelayError && [401, 403, 404].includes(err.status)) throw err;
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

/** Whether a message is addressed to `agent` (directly, or as a broadcast). */
export function isForAgent(m: Message, agent: string): boolean {
  return !m.to || m.to.includes(agent) || m.to.includes("*");
}

/** Addressed to `agent` by name (not a broadcast). */
export function isDirectedAt(m: Message, agent: string): boolean {
  return !!m.to?.includes(agent);
}
