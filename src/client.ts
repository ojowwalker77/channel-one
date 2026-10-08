// Client for one channel: send, read history, and stream live messages.

import { open, seal, type ChannelKeys } from "./crypto.ts";
import {
  PING,
  PROTOCOL_VERSION,
  type Envelope,
  type Kind,
  type Message,
  type Payload,
  type ServerFrame,
} from "./protocol.ts";

export interface SendOptions {
  to?: string[];
  kind?: Kind;
  re?: number[];
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Channel {
  constructor(
    readonly keys: ChannelKeys,
    readonly relay: string,
    readonly as: string,
  ) {}

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

  async send(body: string, opts: SendOptions = {}): Promise<number> {
    const payload: Payload = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      from: this.as,
      ...(opts.to?.length ? { to: opts.to } : {}),
      kind: opts.kind ?? "msg",
      body,
      ...(opts.re?.length ? { re: opts.re } : {}),
      ts: Date.now(),
    };
    const sealed = await seal(this.keys, payload);
    return (await this.request<{ seq: number }>("/messages", { method: "POST", body: JSON.stringify(sealed) })).seq;
  }

  private async decrypt(e: Envelope): Promise<Message | null> {
    const p = await open(this.keys, e.iv, e.ct);
    return p ? { ...p, seq: e.seq } : null;
  }

  /** Messages after `since`, oldest first, following pages up to `max`. */
  async history(since: number, max = Infinity): Promise<{ head: number; messages: Message[] }> {
    const messages: Message[] = [];
    let head = since;
    for (;;) {
      const page = await this.request<{ head: number; messages: Envelope[] }>("/messages", {}, { since });
      head = page.head;
      for (const e of page.messages) {
        const m = await this.decrypt(e);
        if (m) messages.push(m);
        since = e.seq;
      }
      if (!page.messages.length || since >= head || messages.length >= max) break;
    }
    return { head, messages };
  }

  /**
   * Stream messages after `since` until `signal` aborts. Replays anything
   * missed, reconnects with backoff, and resumes from the last delivered seq,
   * so nothing is lost across drops. `onMessage` runs strictly in order.
   */
  async stream(
    since: number,
    onMessage: (m: Message) => void | Promise<void>,
    opts: { signal?: AbortSignal; onReady?: (head: number) => void; onStatus?: (s: string) => void } = {},
  ): Promise<void> {
    let last = since;
    let backoff = 500;
    while (!opts.signal?.aborted) {
      const closed = await new Promise<{ code: number; reason: string; fatal?: boolean }>((resolve) => {
        const u = this.url("/ws", { since: last });
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        // Bun's WebSocket accepts headers, which keeps the token out of URLs and logs.
        const ws = new WebSocket(u, { headers: { authorization: `Bearer ${this.keys.token}` } } as unknown as string[]);
        let queue = Promise.resolve();
        let ping: ReturnType<typeof setInterval> | undefined;
        const abort = () => ws.close(1000, "aborted");
        opts.signal?.addEventListener("abort", abort, { once: true });
        ws.onopen = () => {
          backoff = 500;
          ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(PING), 25_000);
        };
        ws.onmessage = (ev) => {
          const f = JSON.parse(String(ev.data)) as ServerFrame | { t: "pong" };
          queue = queue.then(async () => {
            if (f.t === "msg") {
              if (f.seq <= last) return;
              const m = await this.decrypt(f);
              last = f.seq;
              if (m) await onMessage(m);
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
          // Upgrade failures (bad token, missing room) surface as 1002/1006 before open.
          queue.then(() => resolve({ code: ev.code, reason: ev.reason }));
        };
        ws.onerror = () => {};
      });
      if (opts.signal?.aborted) return;
      if (closed.code === 4000) continue;
      opts.onStatus?.(`disconnected (${closed.code}${closed.reason ? ` ${closed.reason}` : ""}), retrying in ${backoff}ms`);
      // Check whether the failure is permanent (wrong token / no room) before retrying.
      try {
        await this.head();
      } catch (err) {
        if (err instanceof RelayError && [401, 403, 404].includes(err.status)) throw err;
      }
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

/** Whether a message is addressed to `agent` (directly or as a broadcast). */
export function isForAgent(m: Message, agent: string): boolean {
  return !m.to || m.to.includes(agent) || m.to.includes("*");
}

/** One-line-header rendering used by tail/wait/log. */
export function formatMessage(m: Message): string {
  const to = m.to?.length ? m.to.join(",") : "all";
  const kind = m.kind === "msg" ? "" : ` [${m.kind}]`;
  const re = m.re?.length ? ` re #${m.re.join(",#")}` : "";
  return `#${m.seq} ${m.from} → ${to}${kind}${re}: ${m.body}`;
}
