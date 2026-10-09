import { Cancel01Icon, Copy01Icon } from "@hugeicons/core-free-icons"
import { useState, type ReactNode } from "react"

import { loadLine, memberLoad, showsLoad, type Load } from "@mc/load.ts"
import { NAME_RE, type JoinRequest, type Member as RosterMember } from "@mc/membership.ts"
import { TOO_MANY_REQUESTS } from "@mc/sas.ts"
import { taskId } from "@mc/state.ts"
import type { Event } from "@mc/protocol.ts"
import type { ChannelState } from "@mc/state.ts"
import { useAuth } from "@/lib/auth"
import { formatAgo, memberLine, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { Alert, Button, IconButton, Monogram, TextField, errorText, toast } from "./kit"

export type Filter = { kind: "from"; name: string } | { kind: "open" } | { kind: "mine" }

type Confirm =
  | { kind: "approve"; req: JoinRequest }
  | { kind: "reclaim"; req: JoinRequest; online: boolean }
  | { kind: "remove"; member: RosterMember }
  | { kind: "role"; member: RosterMember }
  | { kind: "close" }
  | { kind: "leave" }
  | null

interface Props {
  code: string
  me: string
  /** This browser's member key: "(you)" is whoever holds it, not whoever shares your name. */
  myKey: string
  isOwner: boolean
  roster: RosterMember[]
  requests: JoinRequest[]
  online: Map<string, unknown>
  state: ChannelState
  mentions: number
  now: number
  onFilter: (f: Filter) => void
  onApprove: (r: JoinRequest) => Promise<void>
  /** Owner: move a member's seat to the key in a RECLAIM request. `force` is the second confirm when the old key is online. */
  onReclaim: (r: JoinRequest, opts: { online: boolean; force?: boolean }) => Promise<void>
  onDeny: (r: JoinRequest) => Promise<void>
  /** Sign this browser's half of a request's code check, at the person's click. */
  onCheck: (r: JoinRequest) => Promise<void>
  onRemove: (m: RosterMember) => Promise<void>
  /** Owner: set a member's role, or allow or refuse the one they asked for (a signed event). */
  onRole: (ev: Extract<Event, { op: "role.set" | "role.refuse" }>) => Promise<void>
  onCloseChannel: () => Promise<void>
  onLeaveChannel: () => Promise<void>
  onDismiss: () => void
}

function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4 first:border-t-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-ink-2">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function CopyBox({ text, label, done }: { text: string; label: string; done: string }) {
  return (
    <div className="mt-2 flex items-start gap-1 rounded-[8px] bg-wash p-2.5">
      <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-ink-2">{text}</code>
      <IconButton label={label} className="size-7" onClick={() => navigator.clipboard.writeText(text).then(() => toast(done))}>
        <Icon icon={Copy01Icon} size={15} />
      </IconButton>
    </div>
  )
}

const LEVEL = { free: "Free", busy: "Busy", overloaded: "Overloaded" } as const

/** Everything behind a member's load, one item per line, for the tooltip. */
function loadDetail(l: Load): string {
  const lines = [
    ...l.current.map((t) => `Doing ${taskId(t.id)} ${t.title}`),
    ...l.queued.map((t) => `Queued ${taskId(t.id)} ${t.title}`),
    ...l.waiting.map((t) => `${t.state === "review" ? "In review" : "Blocked"} ${taskId(t.id)} ${t.title}`),
    ...l.claims.map((c) => `Claimed ${c.path}`),
  ]
  return lines.length ? lines.join("\n") : "Nothing assigned"
}

/**
 * Single-quoted for the agent's shell. Apostrophes become ’ so the same line works in sh, bash, zsh
 * and PowerShell, which escape a quote inside quotes differently.
 */
const quoted = (s: string) => `'${s.replace(/'/g, "’")}'`

/** The CLI's default relay (DEFAULT_RELAY in src/config.ts, which the browser can't import). */
const PUBLIC_RELAY = "https://channels.kiwiinit.com"

const ROLES = ["designer", "frontend", "backend", "reviewer", "tester", "docs", "intern"]

/** The join line for one agent, with the role and rules its human agreed on before it joins. */
function InviteAgent({ code }: { code: string }) {
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [rules, setRules] = useState("")
  const n = name.trim()
  const badName = !!n && !NAME_RE.test(n)
  const command = [
    `kiwi join ${code}`,
    // On any other relay, the agent's CLI has to be told where to go.
    location.origin !== PUBLIC_RELAY && `--relay ${location.origin}`,
    `--as ${n && !badName ? n : "<name>"}`,
    role.trim() && `--role ${quoted(role.trim())}`,
    rules.trim() && `--about ${quoted(rules.trim())}`,
  ]
    .filter(Boolean)
    .join(" ")
  const field = "h-8 text-[13px]"
  return (
    <div className="mt-2 grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <TextField className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={32} aria-invalid={badName} aria-label="Agent name" />
        <TextField className={field} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" maxLength={60} list="kiwi-roles" aria-label="Role" />
        <datalist id="kiwi-roles">
          {ROLES.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
      <TextField className={field} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="Rules, e.g. only web/; ask before changing APIs" maxLength={200} aria-label="Rules" />
      {badName && <p className="text-[12px] text-ink-2">Names are letters, digits, dot, dash or underscore, up to 32.</p>}
      <CopyBox text={command} label="Copy command" done={n && !badName ? "Join command copied" : "Copied. Replace <name> with the agent’s name."} />
      <p className="text-[12px] leading-snug text-ink-3">The role shows on the member list and the agent is told its rules. You still approve it with a code.</p>
    </div>
  )
}

function minutesLeft(expires: number, now: number) {
  const m = Math.max(0, Math.round((expires - now) / 60_000))
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`
}

/** Everything about a channel that isn't the conversation: who's in it, who wants in, and how to leave. */
export function Details(p: Props) {
  const auth = useAuth()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const [roleDraft, setRoleDraft] = useState({ role: "", about: "" })
  const needsSignIn = p.isOwner && auth.status === "signed-out"
  const requests = p.requests
  const active = p.roster.filter((m) => m.active).sort((a, b) => Number(b.owner) - Number(a.owner) || Number(p.online.has(b.name)) - Number(p.online.has(a.name)))
  const former = p.roster.filter((m) => !m.active)
  const facts = [...p.state.facts.values()].sort((a, b) => a.key.localeCompare(b.key))
  const inviteLink = `${location.origin}/#${p.code}`
  const taken = confirm?.kind === "approve" && active.some((m) => m.name === confirm.req.name)
  // A seat in use: seen in the last ten minutes or listening right now (the same rule as kiwi approve).
  const lastSeenOf = (name: string) => p.state.members.get(name)?.lastSeen || null
  const onlineNow = (name: string) => p.online.has(name) || p.now - (lastSeenOf(name) ?? 0) < 10 * 60_000
  const [sure, setSure] = useState(false)

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast(done)
      setConfirm(null)
    } catch (err) {
      const message = errorText(err)
      toast(/sign in required/.test(message) ? "Sign in first. Owner actions need your session." : message, "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="animate-slide-in flex h-full w-full flex-col bg-canvas shadow-[inset_0.5px_0_0_var(--line)]">
      <header className="flex h-[56px] shrink-0 items-center justify-between pr-3 pl-5">
        <span className="text-[13px] font-semibold">Details</span>
        <IconButton label="Close details" onClick={p.onDismiss}>
          <Icon icon={Cancel01Icon} size={17} />
        </IconButton>
      </header>

      <div className="flex-1 overflow-y-auto pb-6">
        {needsSignIn && (
          <div className="mx-5 mb-2 rounded-[10px] bg-wash p-3 text-[13px] leading-normal">
            Sign in to approve, remove or close. The owner key alone isn’t enough.
            <Button size="sm" className="mt-2" onClick={auth.signIn}>
              Sign in
            </Button>
          </div>
        )}

        {p.isOwner && requests.length > 0 && (
          <Part title={requests.length === 1 ? "Wants to join" : `${requests.length} want to join`}>
            {requests.some((r) => r.check === "unchecked") && <p className="mb-4 rounded-[10px] bg-wash p-3 text-[12.5px] leading-normal text-ink-2">{TOO_MANY_REQUESTS}</p>}
            <div className="grid gap-4">
              {requests.map((r) => (
                <div key={r.id}>
                  <div className="flex items-start gap-3">
                    <Monogram name={r.name} agent={r.kind !== "human"} size={28} />
                    <div className="min-w-0 flex-1">
                      {r.reclaims ? (
                        <>
                          <p className="truncate text-[13.5px] font-medium">Takes back {r.reclaims.name}’s seat</p>
                          <p className="text-[12px] leading-snug text-ink-2">
                            Old key {r.reclaims.pk.slice(0, 8)}
                            {lastSeenOf(r.reclaims.name) ? `, last seen ${formatAgo(lastSeenOf(r.reclaims.name)!, p.now)}` : ""} · new key {r.pk.slice(0, 8)}
                          </p>
                          {onlineNow(r.reclaims.name) && <p className="text-[12px] leading-snug font-medium text-alert">{r.reclaims.name} is online now with its current key</p>}
                        </>
                      ) : (
                        <p className="truncate text-[13.5px] font-medium">
                          {r.name}
                          {r.role && <span className="font-normal text-ink-2">, {r.role}</span>}
                        </p>
                      )}
                      <p className="text-[12px] leading-snug text-ink-2">
                        {r.kind === "human" ? `Signed in as ${r.sponsoredBy?.name ?? "someone"}` : r.sponsoredBy ? `Agent for ${r.sponsoredBy.name}, from their computer` : "Agent"}
                      </p>
                      {r.sponsoredBy?.email && <p className="truncate text-[12px] text-ink-2">{r.sponsoredBy.email}</p>}
                      <p className="text-[12px] text-ink-3">Asked {formatAgo(r.ts, p.now)}</p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex gap-2 pl-10">
                    <Button size="sm" variant="secondary" onClick={() => run(() => p.onDeny(r), `Declined ${r.name}`)}>
                      Decline
                    </Button>
                    {r.check === "ready" ? (
                      <Button size="sm" onClick={() => setConfirm(r.reclaims ? { kind: "reclaim", req: r, online: onlineNow(r.reclaims.name) } : { kind: "approve", req: r })}>
                        Review and approve
                      </Button>
                    ) : r.check === "unchecked" ? (
                      <Button size="sm" disabled={busy} onClick={() => run(() => p.onCheck(r), `Asked ${r.name} for its code`)}>
                        Show code
                      </Button>
                    ) : (
                      <span className="self-center text-[12px] text-ink-3">Waiting for {r.kind === "human" ? "their" : "its"} code…</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Part>
        )}

        <Part title={`${active.length} ${active.length === 1 ? "member" : "members"}`}>
          <div className="-mx-2 grid grid-cols-[minmax(0,1fr)]">
            {active.map((m) => {
              // Agents always show load, so a coordinator sees who's free; people only when they hold tasks.
              const load = memberLoad(p.state, m.name, p.now)
              const showLoad = showsLoad(m, load)
              // Roles as the owner last set them: role events fold on top of the signed record.
              const live = p.state.members.get(m.name)
              const asked = live?.roleRequest
              return (
                <div key={m.pk}>
                  <div className="group flex items-center gap-3 rounded-[8px] px-2 py-1.5 hover:bg-wash">
                    <Monogram name={memberName(m)} agent={m.kind !== "human"} size={26} online={p.online.has(m.name)} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => p.onFilter({ kind: "from", name: m.name })} title="Show only their messages">
                      <p className="truncate text-[13px] font-medium">
                        {memberName(m)}
                        {m.pk === p.myKey && <span className="font-normal text-ink-3"> (you)</span>}
                      </p>
                      <p className="truncate text-[12px] text-ink-2" title={`${live?.about ? `Rules: ${live.about}\n` : ""}Key ${m.pk.slice(0, 16)}`}>
                        {memberLine(live ?? m)}
                      </p>
                      {showLoad && load.level !== "free" && <p className="truncate text-[12px] text-ink-3">{loadLine(load)}</p>}
                    </button>
                    {showLoad && (
                      <span
                        title={loadDetail(load)}
                        className={cx(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          load.level === "free" && "bg-wash text-ink-3",
                          load.level === "busy" && "bg-wash-2 text-ink-2",
                          load.level === "overloaded" && "bg-wash-2 text-alert"
                        )}
                      >
                        {LEVEL[load.level]}
                      </span>
                    )}
                    {p.isOwner && !m.owner && (
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setRoleDraft({ role: live?.role ?? "", about: live?.about ?? "" })
                            setConfirm({ kind: "role", member: m })
                          }}
                        >
                          Role
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: "remove", member: m })}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                  {asked && (
                    <div className="mb-1 ml-[46px] flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                      <span className="min-w-0 text-ink-2">
                        Asks to be <span className="font-medium text-ink">{asked.role ?? "unassigned"}</span>
                        {asked.about && <span className="text-ink-3"> · {asked.about}</span>}
                      </span>
                      {p.isOwner ? (
                        <span className="flex gap-1">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void run(() => p.onRole({ op: "role.set", member: m.name, role: asked.role ?? null, about: asked.about ?? null }), `${m.name} is now ${asked.role ?? "unassigned"}`)
                            }
                          >
                            Allow
                          </Button>
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => p.onRole({ op: "role.refuse", member: m.name }), `Kept ${m.name}'s role`)}>
                            Refuse
                          </Button>
                        </span>
                      ) : (
                        <span className="text-ink-3">The owner decides.</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {former.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Left: {former.map((m) => m.name).join(", ")}</p>}
        </Part>

        <Part title="Show">
          <div className="-mx-2 grid grid-cols-[minmax(0,1fr)] text-[13px]">
            <button type="button" className="flex items-center justify-between rounded-[8px] px-2 py-1.5 text-left hover:bg-wash" onClick={() => p.onFilter({ kind: "open" })}>
              Unanswered questions <span className="text-ink-3 tabular-nums">{p.state.openAsks.length}</span>
            </button>
            <button type="button" className="flex items-center justify-between rounded-[8px] px-2 py-1.5 text-left hover:bg-wash" onClick={() => p.onFilter({ kind: "mine" })}>
              Messages to you <span className="text-ink-3 tabular-nums">{p.mentions}</span>
            </button>
          </div>
        </Part>

        {p.isOwner && (
          <Part title="Invite">
            <p className="text-[12px] leading-snug text-ink-2">People open this link and ask to join with their account.</p>
            <CopyBox text={inviteLink} label="Copy link" done="Invite link copied" />
            <p className="mt-4 text-[12px] leading-snug text-ink-2">
              Agents join from a computer their person set up with <span className="font-mono text-[11.5px]">kiwi setup</span>. Agree on its role and rules, then tell it to run:
            </p>
            <InviteAgent code={p.code} />
          </Part>
        )}

        {p.state.claims.length > 0 && (
          <Part title="Claimed paths">
            <div className="grid gap-2">
              {p.state.claims.map((c) => (
                <div key={`${c.owner}:${c.path}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="truncate font-mono text-[12px]">{c.path}</code>
                    <span className="shrink-0 text-[11.5px] text-ink-3">{minutesLeft(c.expires, p.now)}</span>
                  </div>
                  <p className="truncate text-[12px] text-ink-2">{c.note ? `${c.owner}: ${c.note}` : c.owner}</p>
                </div>
              ))}
            </div>
          </Part>
        )}

        {facts.length > 0 && (
          <Part title="Facts">
            <div className="-mx-2 grid grid-cols-[minmax(0,1fr)]">
              {facts.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="rounded-[8px] px-2 py-1.5 text-left hover:bg-wash"
                  title="Copy value"
                  onClick={() => navigator.clipboard.writeText(f.value).then(() => toast(`Copied ${f.key}`))}
                >
                  <p className="text-[12.5px] font-medium">{f.key}</p>
                  <p className="font-mono text-[11.5px] break-all text-ink-2">{f.value}</p>
                </button>
              ))}
            </div>
          </Part>
        )}

        <Part title={p.isOwner ? "Close channel" : "Leave channel"}>
          <p className="mb-2.5 text-[12px] leading-snug text-ink-2">
            {p.isOwner
              ? "Deletes every message, member and key on the relay. Everyone’s copy is wiped the next time they connect."
              : "You lose access at once, and the key rotates so you can’t read anything newer."}
          </p>
          <Button size="sm" variant="danger" className="-ml-2.5" onClick={() => setConfirm({ kind: p.isOwner ? "close" : "leave" })}>
            {p.isOwner ? "Close channel" : "Leave channel"}
          </Button>
        </Part>
      </div>

      <Alert
        open={confirm?.kind === "role"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "role" ? `${confirm.member.name}’s role` : ""}
        message={
          <span className="mt-3 grid gap-2">
            <TextField
              value={roleDraft.role}
              onChange={(e) => setRoleDraft((d) => ({ ...d, role: e.target.value }))}
              placeholder="Role, e.g. reviewer"
              maxLength={60}
              list="kiwi-roles"
              aria-label="Role"
              autoFocus
            />
            <TextField value={roleDraft.about} onChange={(e) => setRoleDraft((d) => ({ ...d, about: e.target.value }))} placeholder="Rules (optional)" maxLength={200} aria-label="Rules" />
            <span className="text-[12px] text-ink-3">Everyone sees the role, and agents route work by it.</span>
          </span>
        }
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            if (confirm?.kind !== "role") return
            const name = confirm.member.name
            void run(() => p.onRole({ op: "role.set", member: name, role: roleDraft.role.trim() || null, about: roleDraft.about.trim() || null }), `Saved ${name}’s role`)
          }}
        >
          Save
        </Button>
      </Alert>
      <Alert
        open={confirm?.kind === "approve"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "approve" ? `Let ${confirm.req.name} in?` : ""}
        message={
          confirm?.kind === "approve" && (
            <>
              Approve only if {confirm.req.kind === "human" ? "they show" : "its terminal shows"} this exact code.
              <span className="mt-4 mb-1 block text-[34px] leading-none font-semibold tracking-[0.04em] text-ink tabular-nums">{confirm.req.code}</span>
            </>
          )
        }
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        {confirm?.kind === "approve" && (
          <Button disabled={busy || taken} onClick={() => run(() => p.onApprove(confirm.req), `${confirm.req.name} joined`)}>
            {taken ? "That name is taken" : "Approve"}
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "reclaim"}
        onClose={() => (setConfirm(null), setSure(false))}
        title={confirm?.kind === "reclaim" ? `Move ${confirm.req.reclaims!.name}’s seat to the new key?` : ""}
        message={
          confirm?.kind === "reclaim" && (
            <>
              Approve only if its terminal shows this exact code.
              <span className="mt-4 mb-3 block text-[34px] leading-none font-semibold tracking-[0.04em] text-ink tabular-nums">{confirm.req.code}</span>
              The old key {confirm.req.reclaims!.pk.slice(0, 8)} is out for good and the channel key changes. {confirm.req.reclaims!.name} keeps its name, role, tasks and claims.
              {confirm.online && (
                <span className="mt-3 block rounded-[10px] bg-[color-mix(in_srgb,var(--alert)_10%,transparent)] p-3 text-alert">
                  <span className="block font-semibold">{confirm.req.reclaims!.name} is online now with its current key.</span>
                  This may be someone else taking its seat. Go on only if you know the old key is lost.
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="size-4 accent-[var(--alert)]" />
                    I’m sure the old key is lost
                  </label>
                </span>
              )}
            </>
          )
        }
      >
        <Button variant="secondary" onClick={() => (setConfirm(null), setSure(false))}>
          Cancel
        </Button>
        {confirm?.kind === "reclaim" && (
          <Button
            variant={confirm.online ? "danger" : "primary"}
            disabled={busy || (confirm.online && !sure)}
            onClick={() =>
              run(() => p.onReclaim(confirm.req, { online: confirm.online, force: confirm.online && sure }), `${confirm.req.reclaims!.name}’s seat moved to the new key`).then(() => setSure(false))
            }
          >
            Move seat
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "remove"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "remove" ? `Remove ${memberName(confirm.member)}?` : ""}
        message="They’re disconnected at once, and the key rotates so they can’t read anything new."
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        {confirm?.kind === "remove" && (
          <Button className="bg-alert" disabled={busy} onClick={() => run(() => p.onRemove(confirm.member), `Removed ${confirm.member.name}`)}>
            Remove
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "close" || confirm?.kind === "leave"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "close" ? "Close this channel for everyone?" : "Leave this channel?"}
        message={confirm?.kind === "close" ? "Everything is deleted and can’t be recovered." : "You’ll need the owner’s approval to come back."}
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        <Button
          className="bg-alert"
          disabled={busy}
          onClick={() => run(confirm?.kind === "close" ? p.onCloseChannel : p.onLeaveChannel, confirm?.kind === "close" ? "Channel closed" : "You left the channel")}
        >
          {confirm?.kind === "close" ? "Close channel" : "Leave channel"}
        </Button>
      </Alert>
    </aside>
  )
}
