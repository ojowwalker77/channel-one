import { Dialog } from "@base-ui/react/dialog"
import { Add01Icon, Copy01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons"
import { createContext, useContext, useState, type ReactNode } from "react"

import { loadLine, memberLoad, showsLoad, type Load } from "@mc/load.ts"
import { NAME_RE, type JoinRequest, type Member as RosterMember } from "@mc/membership.ts"
import type { ChannelIcon, Event } from "@mc/protocol.ts"
import { TOO_MANY_REQUESTS } from "@mc/sas.ts"
import { taskId, type ChannelState, type Member } from "@mc/state.ts"
import { useAuth } from "@/lib/auth"
import { formatAgo, memberLine, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { IconDialog } from "./channel-icon"
import { cachedIcon } from "@/lib/icons"
import { Icon } from "./icon"
import { Alert, Button, IconButton, Modal, Monogram, Tabs, TextField, errorText, toast } from "./kit"
import { Menu, MenuItem, MenuSeparator } from "./ui/menu"
import { Popover } from "./ui/popover"

// Everything about a channel that isn't the conversation, each where you'd
// look for it: people behind the faces in the header, Invite as a button,
// join requests behind the banner, and leaving or closing in the ⋯ menu.
// ChannelControls holds the shared state and every confirm dialog; the
// pieces below read it from context.

export type Filter = { kind: "from"; name: string } | { kind: "open" } | { kind: "mine" }

type Confirm =
  | { kind: "approve"; req: JoinRequest }
  | { kind: "reclaim"; req: JoinRequest; online: boolean }
  | { kind: "remove"; member: RosterMember }
  | { kind: "role"; member: RosterMember }
  | { kind: "close" }
  | { kind: "leave" }
  | null

export interface ControlsProps {
  code: string
  /** This browser's member key: "(you)" is whoever holds it, not whoever shares your name. */
  myKey: string
  isOwner: boolean
  roster: RosterMember[]
  requests: JoinRequest[]
  online: Map<string, unknown>
  state: ChannelState
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
  /** Owner: set or clear the channel icon. Absent for a visitor who can't. */
  onSetIcon?: (icon: ChannelIcon | null) => Promise<void>
  /** Owner: rename the channel (a title signed by the owner). Absent for everyone else. */
  onRename?: (name: string) => Promise<void>
  /** The channel's name as this browser knows it, to start the rename from. */
  title?: string
  /** This channel's room, so the icon dialog can show what's there now. */
  roomId?: string
}

interface Api {
  p: ControlsProps
  busy: boolean
  run: (fn: () => Promise<void>, done: string) => Promise<void>
  ask: (c: Confirm) => void
  openRequests: () => void
  openInvite: () => void
  editRole: (m: RosterMember) => void
  lastSeenOf: (name: string) => number | null
  onlineNow: (name: string) => boolean
}

const Ctx = createContext<Api | null>(null)
const useControls = () => useContext(Ctx)!

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

function CopyBox({ text, label, done }: { text: string; label: string; done: string }) {
  return (
    <div className="flex items-start gap-1 rounded-[8px] bg-wash p-2.5">
      <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-ink-2">{text}</code>
      <IconButton label={label} className="size-7" onClick={() => navigator.clipboard.writeText(text).then(() => toast(done))}>
        <Icon icon={Copy01Icon} size={15} />
      </IconButton>
    </div>
  )
}

const inviteLink = (code: string) => `${location.origin}/#${code}`

export function ChannelControls({ children, ...p }: ControlsProps & { children: ReactNode }) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [sheet, setSheet] = useState<"requests" | "invite" | null>(null)
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const [roleDraft, setRoleDraft] = useState({ role: "", about: "" })
  const active = p.roster.filter((m) => m.active)
  const taken = confirm?.kind === "approve" && active.some((m) => m.name === confirm.req.name)
  // A seat in use: seen in the last ten minutes or listening right now (the same rule as kiwi approve).
  const lastSeenOf = (name: string) => p.state.members.get(name)?.lastSeen || null
  const onlineNow = (name: string) => p.online.has(name) || p.now - (lastSeenOf(name) ?? 0) < 10 * 60_000

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

  const api: Api = {
    p,
    busy,
    run,
    ask: setConfirm,
    openRequests: () => setSheet("requests"),
    openInvite: () => setSheet("invite"),
    editRole: (m) => {
      const live = p.state.members.get(m.name)
      setRoleDraft({ role: live?.role ?? "", about: live?.about ?? "" })
      setConfirm({ kind: "role", member: m })
    },
    lastSeenOf,
    onlineNow,
  }

  return (
    <Ctx.Provider value={api}>
      {children}

      <Modal open={sheet === "requests" && confirm === null} onClose={() => setSheet(null)} wide>
        <Requests onDone={() => setSheet(null)} />
      </Modal>
      <Modal open={sheet === "invite"} onClose={() => setSheet(null)} wide>
        <Invite onDone={() => setSheet(null)} />
      </Modal>

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
        message={
          confirm?.kind === "close"
            ? "Every message, member and key is deleted on the relay, and everyone’s copy is wiped the next time they connect. It can’t be recovered."
            : "You lose access at once, and the key rotates so you can’t read anything newer. Coming back takes the owner’s approval."
        }
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
    </Ctx.Provider>
  )
}

// ---------- people ----------

/** The faces in the header and, behind them, everyone in the channel: role, load, and what the owner can do. */
export function People({ here, subtitle, live }: { here: Member[]; subtitle: string; live: boolean }) {
  const { p, busy, run, ask, editRole } = useControls()
  const [open, setOpen] = useState(false)
  const active = p.roster.filter((m) => m.active).sort((a, b) => Number(b.owner) - Number(a.owner) || Number(p.online.has(b.name)) - Number(p.online.has(a.name)))
  const former = p.roster.filter((m) => !m.active)
  const act = (fn: () => void) => () => (setOpen(false), fn())

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[340px] p-1.5"
      trigger={
        <button type="button" aria-label={`People, ${subtitle}`} className="mt-0.5 flex max-w-full items-center gap-1.5 rounded-[6px] text-left transition-colors hover:text-ink data-popup-open:text-ink">
          {live && here.length > 0 && (
            <span className="flex shrink-0 -space-x-1" aria-hidden>
              {here.slice(0, 5).map((m) => (
                <span key={m.name} className="flex bg-canvas p-px" style={{ borderRadius: m.kind !== "human" ? 6 : 999 }}>
                  <Monogram name={memberName(m)} agent={m.kind !== "human"} size={16} />
                </span>
              ))}
            </span>
          )}
          <span className="truncate text-[12px] leading-tight text-ink-2">{subtitle}</span>
        </button>
      }
    >
      <div className="max-h-[min(520px,70svh)] overflow-y-auto">
        <h2 className="sr-only">People</h2>
        {active.map((m) => {
          // Agents always show load, so a coordinator sees who's free; people only when they hold tasks.
          const load = memberLoad(p.state, m.name, p.now)
          const showLoad = showsLoad(m, load)
          // Roles as the owner last set them: role events fold on top of the signed record.
          const now = p.state.members.get(m.name)
          const asked = now?.roleRequest
          return (
            <div key={m.pk} className="rounded-[8px] px-2 py-1.5 hover:bg-wash">
              <div className="flex items-center gap-2.5">
                <Monogram name={memberName(m)} agent={m.kind !== "human"} size={26} online={p.online.has(m.name)} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={act(() => p.onFilter({ kind: "from", name: m.name }))} title="Show only their messages">
                  <p className="truncate text-[13px] font-medium">
                    {memberName(m)}
                    {m.pk === p.myKey && <span className="font-normal text-ink-2"> (you)</span>}
                  </p>
                  <p className="truncate text-[12px] text-ink-2" title={`${now?.about ? `Rules: ${now.about}\n` : ""}Key ${m.pk.slice(0, 16)}`}>
                    {showLoad && load.level !== "free" ? loadLine(load) : memberLine(now ?? m)}
                  </p>
                </button>
                {showLoad && (
                  <span
                    title={loadDetail(load)}
                    className={cx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium shadow-[inset_0_0_0_1px_var(--line)]", load.level === "overloaded" ? "text-alert" : "text-ink-2")}
                  >
                    {LEVEL[load.level]}
                  </span>
                )}
                {p.isOwner && !m.owner && (
                  <Menu
                    align="end"
                    trigger={
                      <IconButton label={`More for ${memberName(m)}`} className="size-7">
                        <Icon icon={MoreHorizontalIcon} size={16} />
                      </IconButton>
                    }
                  >
                    <MenuItem onClick={act(() => editRole(m))}>Set role…</MenuItem>
                    <MenuSeparator />
                    <MenuItem tone="danger" onClick={act(() => ask({ kind: "remove", member: m }))}>
                      Remove from channel…
                    </MenuItem>
                  </Menu>
                )}
              </div>
              {asked && (
                <div className="mt-1 ml-[36px] flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                  <span className="min-w-0 text-ink-2">
                    Asks to be <span className="font-medium text-ink">{asked.role ?? "unassigned"}</span>
                    {asked.about && <span> · {asked.about}</span>}
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
                    <span className="text-ink-2">The owner decides.</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {former.length > 0 && <p className="px-2 pt-1.5 pb-1 text-[12px] text-ink-2">Left: {former.map((m) => m.name).join(", ")}</p>}
      </div>
      <div className="mt-1 border-t border-line px-2 pt-2 pb-1 text-[12px] text-ink-2">Choose a name to see only their messages.</div>
    </Popover>
  )
}

// ---------- invite ----------

/**
 * Single-quoted for the agent's shell. Apostrophes become ’ so the same line works in sh, bash, zsh
 * and PowerShell, which escape a quote inside quotes differently.
 */
const quoted = (s: string) => `'${s.replace(/'/g, "’")}'`

/** The CLI's default relay (DEFAULT_RELAY in src/config.ts, which the browser can't import). */
const PUBLIC_RELAY = "https://channels.kiwiinit.com"

const ROLES = ["designer", "frontend", "backend", "reviewer", "tester", "docs", "intern"]

export function InviteButton() {
  const { p, openInvite } = useControls()
  if (!p.isOwner) return null
  return (
    <Button size="sm" variant="secondary" className="h-8 gap-1 pr-3 pl-2.5" aria-label="Invite" onClick={openInvite}>
      <Icon icon={Add01Icon} size={15} />
      <span className="hidden sm:inline">Invite</span>
    </Button>
  )
}

/** One dialog for both ways in: a link for a person, a command for an agent with the role and rules agreed up front. */
function Invite({ onDone }: { onDone: () => void }) {
  const { p } = useControls()
  const [who, setWho] = useState<"person" | "agent">("agent")
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [rules, setRules] = useState("")
  const n = name.trim()
  const badName = !!n && !NAME_RE.test(n)
  const command = [
    `kiwi join ${p.code}`,
    // On any other relay, the agent's CLI has to be told where to go.
    location.origin !== PUBLIC_RELAY && `--relay ${location.origin}`,
    `--as ${n && !badName ? n : "<name>"}`,
    role.trim() && `--role ${quoted(role.trim())}`,
    rules.trim() && `--about ${quoted(rules.trim())}`,
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="p-5">
      <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">Invite to this channel</Dialog.Title>
      <Dialog.Description className="mt-1 text-[13px] leading-normal text-ink-2">Everyone who joins waits for you to approve them with a 6-digit code.</Dialog.Description>
      <div className="mt-4">
        <Tabs
          stretch
          label="Who you're inviting"
          value={who}
          onChange={setWho}
          options={[
            { value: "agent", label: "An agent" },
            { value: "person", label: "A person" },
          ]}
        />
      </div>
      {who === "person" ? (
        <div role="tabpanel" aria-label="A person" className="mt-4 grid gap-2">
          <p className="text-[13px] leading-normal text-ink-2">Send them this link. They open it, sign in, and ask to join.</p>
          <CopyBox text={inviteLink(p.code)} label="Copy link" done="Invite link copied" />
        </div>
      ) : (
        <div role="tabpanel" aria-label="An agent" className="mt-4 grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={32} aria-invalid={badName} aria-label="Agent name" aria-describedby={badName ? "invite-name-error" : undefined} />
            <TextField value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" maxLength={60} list="kiwi-roles" aria-label="Role" />
          </div>
          <TextField value={rules} onChange={(e) => setRules(e.target.value)} placeholder="Rules, e.g. only web/; ask before changing APIs" maxLength={200} aria-label="Rules" />
          {badName && (
            <p id="invite-name-error" role="alert" className="text-[12px] text-ink-2">
              Names are letters, digits, dot, dash or underscore, up to 32.
            </p>
          )}
          <CopyBox text={command} label="Copy command" done={n && !badName ? "Join command copied" : "Copied. Replace <name> with the agent’s name."} />
          <p className="text-[12px] leading-snug text-ink-2">
            Run it on a computer you set up with <span className="font-mono text-[11.5px]">kiwi setup</span>. The agent is told its role and rules when it joins.
          </p>
        </div>
      )}
      <datalist id="kiwi-roles">
        {ROLES.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

// ---------- join requests ----------

/** The quiet line above the conversation when someone's waiting to be let in. Owner only. */
export function RequestsBanner() {
  const { p, openRequests } = useControls()
  const auth = useAuth()
  if (!p.isOwner || p.requests.length === 0) return null
  const first = p.requests[0]!
  return (
    <div className="flex shrink-0 items-center gap-3 bg-accent-wash px-5 py-2 text-[13px]">
      <span className="min-w-0 flex-1 truncate">
        {p.requests.length > 1 ? (
          `${p.requests.length} people and agents want to join this channel.`
        ) : first.reclaims ? (
          <>
            A new key wants to take back <span className="font-medium">{first.reclaims.name}</span>’s seat.
          </>
        ) : (
          <>
            <span className="font-medium">{first.name}</span> wants to join this channel.
          </>
        )}
      </span>
      {auth.status === "signed-out" ? (
        <button type="button" onClick={auth.signIn} className="shrink-0 font-medium hover:underline">
          Sign in to review
        </button>
      ) : (
        <button type="button" onClick={openRequests} className="shrink-0 font-medium hover:underline">
          Review
        </button>
      )}
    </div>
  )
}

function Requests({ onDone }: { onDone: () => void }) {
  const { p, busy, run, ask, lastSeenOf, onlineNow } = useControls()
  const requests = p.requests
  return (
    <div className="p-5">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{requests.length === 1 ? "Wants to join" : `${requests.length} want to join`}</h2>
      <p className="mt-1 text-[13px] leading-normal text-ink-2">Show the code, compare it with theirs, then approve.</p>
      {/* 'unchecked' on a plain join means this device's daily signing budget is spent: say so even for one. Reclaims are never checked on their own. */}
      {requests.some((r) => r.check === "unchecked" && !r.reclaims) && <p className="mt-3 rounded-[10px] bg-wash p-3 text-[12.5px] leading-normal text-ink-2">{TOO_MANY_REQUESTS}</p>}
      {requests.some((r) => r.check === "unchecked" && r.reclaims) && <p className="mt-3 text-[12.5px] leading-normal text-ink-3">A reclaim’s code is shown only when you ask for it.</p>}
      <div className="mt-4 grid gap-4">
        {requests.length === 0 && <p className="text-[13px] text-ink-3">Nobody’s waiting.</p>}
        {requests.map((r) => (
          <div key={r.id} className="flex items-start gap-3">
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
                {r.sponsoredBy?.email && ` · ${r.sponsoredBy.email}`} · asked {formatAgo(r.ts, p.now)}
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => run(() => p.onDeny(r), `Declined ${r.name}`)}>
                  Decline
                </Button>
                {r.check === "ready" ? (
                  <Button size="sm" onClick={() => ask(r.reclaims ? { kind: "reclaim", req: r, online: onlineNow(r.reclaims.name) } : { kind: "approve", req: r })}>
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
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

// ---------- the ⋯ menu ----------

/** Things you do to the channel itself, the dangerous ones last and in red. */
export function ChannelMenu() {
  const { p, ask, openInvite, openRequests } = useControls()
  const auth = useAuth()
  const [iconOpen, setIconOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  return (
    <>
      <Menu
        align="end"
        className="w-56"
        trigger={
          <IconButton label="Channel menu">
            <Icon icon={MoreHorizontalIcon} size={18} />
          </IconButton>
        }
      >
        {/* Inviting is the owner's, as it was in the old panel: they approve everyone who asks. */}
        {p.isOwner && <MenuItem onClick={() => navigator.clipboard.writeText(inviteLink(p.code)).then(() => toast("Invite link copied"))}>Copy invite link</MenuItem>}
        {p.isOwner && <MenuItem onClick={openInvite}>Invite…</MenuItem>}
        {p.isOwner && p.requests.length > 0 && (
          <MenuItem onClick={auth.status === "signed-out" ? auth.signIn : openRequests}>
            {auth.status === "signed-out" ? "Sign in to review join requests" : `Join requests (${p.requests.length})`}
          </MenuItem>
        )}
        {p.isOwner && p.onRename && <MenuItem onClick={() => setRenaming(true)}>Rename channel…</MenuItem>}
        {p.isOwner && p.onSetIcon && <MenuItem onClick={() => setIconOpen(true)}>Channel icon…</MenuItem>}
        {p.isOwner && <MenuSeparator />}
        {p.isOwner ? (
          <MenuItem tone="danger" onClick={() => ask({ kind: "close" })}>
            Close channel…
          </MenuItem>
        ) : (
          <MenuItem tone="danger" onClick={() => ask({ kind: "leave" })}>
            Leave channel…
          </MenuItem>
        )}
      </Menu>
      {p.onSetIcon && <IconDialog open={iconOpen} onClose={() => setIconOpen(false)} icon={cachedIcon(p.roomId ?? "")} onSave={p.onSetIcon} />}
      {p.onRename && renaming && <RenameDialog title={p.title ?? ""} onClose={() => setRenaming(false)} onSave={p.onRename} />}
    </>
  )
}

/** The owner renames the channel. Every member sees the new name; the relay never can. */
function RenameDialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = name.trim()
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(next)
      toast(`Renamed to ${next}`)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose}>
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (next && next !== title) void save()
        }}
      >
        <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">Rename channel</Dialog.Title>
        <Dialog.Description className="mt-1 text-[13px] leading-normal text-ink-2">Everyone in the channel sees the new name. It’s encrypted, so the relay can’t read it.</Dialog.Description>
        <TextField className="mt-4" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Channel name" aria-invalid={!!error} aria-describedby={error ? "rename-error" : undefined} onFocus={(e) => e.currentTarget.select()} />
        {error && (
          <p id="rename-error" role="alert" className="mt-2 text-[12.5px] text-alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !next || next === title}>
            Rename
          </Button>
        </div>
      </form>
    </Modal>
  )
}
