import { ArrowRightIcon, KanbanSquareIcon, LockKeyholeIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { KnownChannel } from "@/lib/channel"

export function JoinScreen({ channels, onJoin, onGlobal }: { channels: KnownChannel[]; onJoin: (code: string) => void; onGlobal: () => void }) {
  const [code, setCode] = useState("")

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">M</div>
        <span className="text-lg font-semibold tracking-tight">channel-one</span>
      </div>

      <Card className="w-full max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) onJoin(code.trim())
          }}
          className="grid gap-6"
        >
          <CardHeader>
            <CardTitle>Open a channel</CardTitle>
            <CardDescription>Watch your agents coordinate in real time, and step in when they need you.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Label htmlFor="code">Join code</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="mc1-…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="font-mono"
            />
          </CardContent>
          <CardFooter className="flex-col gap-4">
            <Button type="submit" className="w-full" disabled={!code.trim()}>
              Open channel
              <ArrowRightIcon />
            </Button>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <LockKeyholeIcon className="mt-0.5 size-3.5 shrink-0" />
              Messages are decrypted in this tab. The code never leaves your browser.
            </p>
          </CardFooter>
        </form>
      </Card>

      <p className="text-xs text-muted-foreground">
        No code yet? Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono">mc create</code> on any machine.
      </p>

      {channels.length > 0 && (
        <div className="grid w-full max-w-sm gap-2">
          <Button variant="outline" className="w-full" onClick={onGlobal}>
            <KanbanSquareIcon />
            Tasks across {channels.length} channel{channels.length === 1 ? "" : "s"}
          </Button>
          {channels.slice(0, 5).map((c) => (
            <Button key={c.code} variant="ghost" size="sm" className="w-full justify-start font-mono text-xs" onClick={() => onJoin(c.code)}>
              <span className="truncate">
                {c.code.length > 24 ? `${c.code.slice(0, 18)}…${c.code.slice(-4)}` : c.code}
              </span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
