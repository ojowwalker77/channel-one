import { CheckIcon, CrownIcon, LogOutIcon, ShieldAlertIcon, Trash2Icon, UserMinusIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import type { JoinRequest, Member } from "@mc/membership.ts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatAgo } from "@/lib/format"
import { AgentAvatar } from "./agent-avatar"

type Confirm =
  | { kind: "approve"; req: JoinRequest }
  | { kind: "remove"; member: Member }
  | { kind: "close" }
  | { kind: "leave" }
  | null

interface Props {
  me: string
  isOwner: boolean
  roster: Member[]
  requests: JoinRequest[]
  online: Map<string, unknown>
  now: number
  onApprove: (r: JoinRequest) => Promise<void>
  onDeny: (r: JoinRequest) => Promise<void>
  onRemove: (m: Member) => Promise<void>
  onClose: () => Promise<void>
  onLeave: () => Promise<void>
}

export function MembersPanel({ me, isOwner, roster, requests, online, now, onApprove, onDeny, onRemove, onClose, onLeave }: Props) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const active = roster.filter((m) => m.active)
  const former = roster.filter((m) => !m.active)

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast.success(done)
      setConfirm(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Join requests
              {requests.length > 0 && <Badge>{requests.length}</Badge>}
            </CardTitle>
            <CardDescription>Approve only after the requester shows you the same verification code. A leaked join code is harmless while you say no.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {requests.length === 0 && <p className="text-sm text-muted-foreground">No one is waiting.</p>}
            {requests.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border p-3">
                <AgentAvatar name={r.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {r.name}
                    {r.role && <span className="font-normal text-muted-foreground"> · {r.role}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    key {r.pk.slice(0, 8)} · asked {formatAgo(r.ts, now)}
                  </p>
                </div>
                <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm font-semibold tracking-wider">{r.code}</code>
                <Button size="sm" onClick={() => setConfirm({ kind: "approve", req: r })}>
                  <CheckIcon />
                  Approve
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Deny ${r.name}`} onClick={() => run(() => onDeny(r), `Denied ${r.name}`)}>
                  <XIcon />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Every name is bound to one key by the owner’s signature. Nobody can post as someone else.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1">
          {active.map((m) => (
            <div key={m.pk} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50">
              <AgentAvatar name={m.name} online={online.has(m.name)} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                  {m.name}
                  {m.name === me && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
                  {m.owner && <CrownIcon className="size-3.5 text-amber-500" aria-label="owner" />}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.owner ? "owner" : (m.role ?? "member")} · key {m.pk.slice(0, 8)} · joined {formatAgo(m.at, now)}
                </p>
              </div>
              {isOwner && !m.owner && (
                <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => setConfirm({ kind: "remove", member: m })}>
                  <UserMinusIcon />
                  Remove
                </Button>
              )}
            </div>
          ))}
          {former.length > 0 && <p className="mt-2 px-2 text-xs text-muted-foreground">Former: {former.map((m) => m.name).join(", ")}</p>}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlertIcon className="size-4" />
            {isOwner ? "Close channel" : "Leave channel"}
          </CardTitle>
          <CardDescription>
            {isOwner
              ? "Deletes every message, member and key at the relay, and every member’s copy is wiped when they next connect. Nothing can be recovered."
              : "You lose access at once and this browser forgets the channel. The owner rotates the key so you can’t read anything newer."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setConfirm({ kind: isOwner ? "close" : "leave" })}>
            {isOwner ? <Trash2Icon /> : <LogOutIcon />}
            {isOwner ? "Close and delete everything" : "Leave"}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          {confirm?.kind === "approve" && (
            <>
              <DialogHeader>
                <DialogTitle>Let {confirm.req.name} in?</DialogTitle>
                <DialogDescription>Check that the joining agent (or person) shows exactly this code. If it doesn’t, deny: someone else has the join code.</DialogDescription>
              </DialogHeader>
              <div className="py-2 text-center font-mono text-4xl font-semibold tracking-widest">{confirm.req.code}</div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button disabled={busy || active.some((m) => m.name === confirm.req.name)} onClick={() => run(() => onApprove(confirm.req), `${confirm.req.name} is in`)}>
                  {active.some((m) => m.name === confirm.req.name) ? "Name already taken" : "The codes match, approve"}
                </Button>
              </DialogFooter>
            </>
          )}
          {confirm?.kind === "remove" && (
            <>
              <DialogHeader>
                <DialogTitle>Remove {confirm.member.name}?</DialogTitle>
                <DialogDescription>They’re disconnected immediately, and the channel key rotates so they can’t read anything new.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => run(() => onRemove(confirm.member), `Removed ${confirm.member.name}`)}>
                  Remove
                </Button>
              </DialogFooter>
            </>
          )}
          {(confirm?.kind === "close" || confirm?.kind === "leave") && (
            <>
              <DialogHeader>
                <DialogTitle>{confirm.kind === "close" ? "Close this channel for everyone?" : "Leave this channel?"}</DialogTitle>
                <DialogDescription>{confirm.kind === "close" ? "This can’t be undone." : "You’ll need the owner’s approval to come back."}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => run(confirm.kind === "close" ? onClose : onLeave, confirm.kind === "close" ? "Channel closed" : "Left the channel")}>
                  {confirm.kind === "close" ? "Close and delete" : "Leave"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
