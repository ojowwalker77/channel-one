# Plan: the backend on Effect 4

> Owner's ask (#460): "our backend to be full Effect TS", pointing at
> https://effect.website/docs/v4/onboarding. This is the plan for review before
> any code. Effect 4.0.2 is current on npm.

## What "backend" covers

| Part | Files | Lines | Runs in |
| --- | --- | --- | --- |
| Relay core (shared) | `src/relay/room.ts`, `policy.ts`, `human.ts`, `devices.ts`, `machines.ts`, `vault.ts` | ~2,000 | Worker and Bun |
| Relay adapters | `src/relay/worker.ts` (Durable Objects), `src/relay/bun.ts` (bun:sqlite) | ~670 | one each |
| Client library | `src/client.ts`, `agent.ts`, `config.ts`, `machine.ts`, `hooks.ts` | ~2,300 | Bun (and `client.ts` in the browser) |
| CLI and MCP | `src/cli/*.ts`, `src/mcp.ts`, `src/sh.ts` | ~1,700 | Bun binary |
| Pure core | `protocol.ts`, `state.ts`, `crypto.ts`, `identity.ts`, `membership.ts`, `sas.ts`, `vault.ts`, `format.ts`, `load.ts` | ~1,900 | everywhere |

## Ground rules

1. **Nothing in `src/` moves until the 0.7.0 batch lands.** Six approved
   branches touch it; a rewrite under them means rebasing all six.
2. **The wire protocol, storage layout and crypto don't change.** A relay on
   Effect talks to 0.6 clients and vice versa, and the data on disk and in
   Durable Objects stays readable. Same routes, same JSON, same error texts.
3. **One layer per PR, behind the existing tests.** The ~180 tests are the proof
   that behaviour didn't change; each PR keeps them green unmodified, except
   where a test reached into an internal that moved.
4. **The pure core stays plain functions.** `fold`, `format`, `wellFormed`,
   crypto and `sas` are already pure and synchronous or simple async. Wrapping
   them in Effect adds cost and nothing else. Effect code calls them directly.
5. **The surface the web imports keeps working at every step** until the web's
   own move (see "The web"): the Promise methods stay until Claude-1 switches
   the web over, then they can go.

## How the pieces map

- **Errors become tagged failures** (`Schema.TaggedError`): `RelayError`
  (status + message), `ChannelGone` ("removed" | "closed"), `Rejected`,
  `VaultError`, and the relay's `HttpError` split by meaning (`NotMember`,
  `NotOwner`, `BadRequest`, `OverQuota`, `Conflict`…). Each maps to exactly
  the status and text it returns today, in one place, instead of 61 scattered
  `throw new HttpError` in `room.ts`. Callers use `catchTag`; nothing is caught
  by string matching (today `client.ts` checks `/removed|denied/` on messages).
- **Services become `Context.Service`s with Layers**, which is what lets the
  Worker and Bun relays share one room implementation honestly:
  - `RoomStore` (SQL: the DO's `ctx.storage.sql` or `bun:sqlite`)
  - `Directory`, `DeviceStore`, `MachineStore`, `VaultStore` (already
    interfaces today; they become services)
  - `HumanAuth` (WorkOS, dev sign-in, or none)
  - `Policy` (beta gate and quotas), `Clock` (Effect's own, so expiry and
    quota tests stop injecting `now` by hand)
  - Client side: `Relay` (the HTTP+signing `call`), `Keystore` (`~/.kiwi`
    files), `Cache` (the message cache), `Cursor`.
- **Resources become scoped**: the client WebSocket (open, ping, close on
  interrupt), the reconnect loop as a `Stream` with a `Schedule` (the backoff
  and the 30s quiet window become declarative), bun:sqlite handles, listener
  registration for the Stop hook, the MCP server. Interrupting `tail` closes
  everything, without the hand-written abort plumbing in `stream()` and
  `listen()`.
- **Request bodies get Schemas** at the relay boundary, replacing hand-written
  `typeof` checks (`wellFormed`, `version()`, `body()`, the vault and icon
  checks). The Schemas live next to the protocol types and are the single
  source for both decode and type. The *payload* validation inside encrypted
  messages (`wellFormedEvent`) can use the same Schemas later; not in step 1.
- **HTTP**: the relay's router becomes an Effect `HttpRouter` app, turned into
  a fetch handler with `HttpEffect.toWebHandler`. The Worker's `fetch`, the
  Durable Object's `fetch` and `Bun.serve` all call the same handler. WebSocket
  upgrades stay in the adapters (hibernation in the DO, Bun's `upgrade`), since
  they're runtime-specific by nature; the frame handling inside them uses the
  room service.

## Before step 1: two guard tests (review #473)

- **An auth table.** One test lists every relay route with the check it needs
  (owner signature, member signature, the owner's human session, a checked join
  request, a vault writer signature, sign-in only) and asserts each refuses
  without it. It runs before and after every step, so a lost `owner()` in the
  router rewrite can't slip through.
- **Error texts are API.** `client.ts` matches `/removed|denied/`, the web
  matches `/sign in required/` and shows relay messages as they are. A test
  snapshots every error text the relay can return; changing one is then a
  deliberate edit to the snapshot.

## Order (one PR each)

1. **Errors and Schemas only.** The tags are also exported from a plain module
   the browser can import without the Effect runtime (an `Error` with a `_tag`),
   so the web can branch on `NotOwner`, `SignInRequired`, `VaultExists`,
   `Conflict`… right away, instead of matching message text or DOMException
   names (#474). Add the tagged errors and request Schemas;
   `room.ts` throws them through a thin bridge so behaviour is identical. Small,
   and it sets the vocabulary.
2. **Relay core on Effect.** `room.ts`, `policy.ts`, `vault.ts`, `devices.ts`,
   `machines.ts`, `human.ts` as services and Effect handlers. Both adapters
   provide Layers. Run the suite against Bun *and* `wrangler dev`
   (`KIWI_TEST_RELAY`, plus the Worker vault test). It ships as a relay deploy
   on its own, with a canary: the workers.dev URL first, the suite run against
   it, then the custom domain; per-request CPU in the Durable Object recorded
   before and after.
3. **Client: `Relay` service and the stream.** `client.ts` internals on Effect
   (calls, signing, the reconnect `Stream`), exporting the same `Channel`
   class with Promise methods for the web and CLI.
4. **Agent session, config, hooks.** `agent.ts`, `config.ts`, `machine.ts`,
   `hooks.ts` as services over the client; `listen` becomes a scoped Stream.
5. **CLI and MCP.** Commands as Effects run by one `ManagedRuntime`, errors
   rendered in one place (today each command calls `die`). The MCP tools become
   Effects too. Optionally `@effect/cli` for argument parsing; decided then, by
   whether the help output can stay as it is.

Each step is a few days, and each is shippable on its own.

## Costs, measured

- **Bundle**: a minimal program with a service, a Layer and a tagged error,
  bundled and minified for the browser, is ~81KB (27KB gzipped); `Stream` +
  `Schedule` alone ~40KB (14KB gzipped). Schema is most of it.
- **Worker**: the relay bundle grows by about that; far under the Workers size
  limit. Cold-start cost: to measure in step 2 under `wrangler dev`.
- **Binary**: +~1MB on a 64MB `kiwi` binary; negligible.
- **Web**: ~30KB gzipped once it imports Effect code (dist is ~689KB raw
  today); accepted, since the web moves to Effect too.

## The web

Decided (#475, owner delegated to Coordinator): **the web moves to Effect too**,
as its own step after backend step 3, owned by Claude-1, with React at the edge:
the channel as an Effect `Stream` one hook subscribes to, vault and passkey steps
as typed errors, services as Layers (`Storage`, `KeyStore`, `Relay`). So there's
no `client.ts` split and no bundle check for `effect` in `web/dist`; the web
accepts the ~30KB gzipped. Step 1 still exports plain tagged errors the web can
branch on before it moves.

## Risks

- **A big diff in security-sensitive code.** Mitigation: the protocol and crypto
  don't move; every step behind the full suite plus the Worker vault test;
  Coordinator reviews each step against the old code path.
- **Durable Object specifics** (hibernation, auto-responses, alarms) don't map
  onto Effect's server abstractions. Mitigation: they stay in the adapter; only
  what's inside the handlers moves.
- **Learning curve for the other agents.** Mitigation: the LLMS.md /
  effect-solutions patterns, one style guide section in `CONTRIBUTING.md`
  written in step 1 (services, errors, `Effect.fn` naming), and small PRs.

## Done means

All of `src/` except the pure core runs on Effect; one error vocabulary; the
Worker and Bun relays share one room implementation through Layers; the suite
and the Worker test pass at every step; protocol, storage and the web's surface
unchanged (or the web moved, if that's the call).
