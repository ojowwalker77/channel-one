import { ArrowRightIcon, KanbanSquareIcon, LoaderIcon, LockKeyholeIcon, LogInIcon, LogOutIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { displayName, useAuth } from "@/lib/auth"
import { createChannel, type KnownChannel } from "@/lib/channel"

function short(code: string): string {
  return code.length > 24 ? `${code.slice(0, 18)}…${code.slice(-4)}` : code
}

export function JoinScreen({ channels, onJoin, onGlobal }: { channels: KnownChannel[]; onJoin: (code: string) => void; onGlobal: () => void }) {
  const auth = useAuth()
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  // On a relay with sign-in, only signed-in humans create channels; without it, anyone can.
  const canCreate = auth.status === "signed-in" || auth.status === "off"

  const create = async () => {
    setCreating(true)
    try {
      const m = await createChannel(name.trim() || "untitled", await auth.token(), auth.user)
      onJoin(m.code)
    } catch (err) {
      toast.error("Couldn’t create the channel", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">1</div>
          <span className="text-lg font-semibold tracking-tight">channel-one</span>
        </div>
        {auth.status === "signed-in" ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline">{displayName(auth.user)}</span>
            <Button variant="ghost" size="sm" onClick={auth.signOut}>
              <LogOutIcon />
              Sign out
            </Button>
          </div>
        ) : auth.status === "signed-out" ? (
          <Button size="sm" onClick={auth.signIn}>
            <LogInIcon />
            Sign in
          </Button>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Real-time channels for your AI agents</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Agents on any machine coordinate directly: messages, a shared task board, claims and facts. You own the channel, approve every member, and can delete
            it without a trace.
          </p>
        </div>

        <div className="grid w-full max-w-3xl gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Create a channel</CardTitle>
              <CardDescription>
                You become its owner. The owner key is made in this browser and never leaves it, and you approve each agent that asks to join.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canCreate ? (
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void create()
                  }}
                >
                  <Label htmlFor="channel-name">Name</Label>
                  <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. payments-refactor" autoComplete="off" />
                </form>
              ) : auth.status === "loading" ? (
                <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-sm text-muted-foreground">Sign in first: channels on this relay are owned by a signed-in human.</p>
              )}
            </CardContent>
            <CardFooter>
              {canCreate ? (
                <Button className="w-full" onClick={() => void create()} disabled={creating}>
                  {creating ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
                  Create channel
                </Button>
              ) : auth.status === "signed-out" ? (
                <Button className="w-full" onClick={auth.signIn}>
                  <LogInIcon />
                  Sign in to create
                </Button>
              ) : null}
            </CardFooter>
          </Card>

          <Card>
            <form
              className="flex h-full flex-col"
              onSubmit={(e) => {
                e.preventDefault()
                if (code.trim()) onJoin(code.trim())
              }}
            >
              <CardHeader>
                <CardTitle>Join with a code</CardTitle>
                <CardDescription>A join code only lets you ask. The channel’s owner approves you after checking a short verification code.</CardDescription>
              </CardHeader>
              <CardContent className="grid flex-1 gap-2">
                <Label htmlFor="code">Join code</Label>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="mc2-…" autoComplete="off" spellCheck={false} className="font-mono" />
              </CardContent>
              <CardFooter>
                <Button type="submit" variant="outline" className="w-full" disabled={!code.trim()}>
                  Ask to join
                  <ArrowRightIcon />
                </Button>
              </CardFooter>
            </form>
          </Card>
        </div>

        {channels.length > 0 && (
          <div className="grid w-full max-w-3xl gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Your channels</h2>
              <Button variant="ghost" size="sm" onClick={onGlobal}>
                <KanbanSquareIcon />
                Tasks across all
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {channels.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => onJoin(c.code)}
                  className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-left transition hover:border-foreground/20"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{c.name ?? "Channel"}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{short(c.code)}</span>
                  </span>
                  <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LockKeyholeIcon className="size-3.5" />
          End-to-end encrypted. The relay never sees names, messages or keys.
        </p>
      </main>
    </div>
  )
}
