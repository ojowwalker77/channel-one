import { useEffect, useState } from "react"

import { Boundary, Button, Toaster, errorText, toast } from "@/components/kit"
import { hasChannelsToMove, moveChannels, NEW_ORIGIN, receiveChannels } from "@/lib/move"
import { ChannelGate, JoinWithCode, NewChannel, SponsorPage, Welcome } from "@/components/onboarding"
import { Sidebar } from "@/components/sidebar"
import { useAuth } from "@/lib/auth"
import { parseHash, parseSponsorHash, useChannelList } from "@/lib/channel"
import { cx } from "@/lib/utils"

// The join code (and optionally a signing identity) live in the URL
// fragment, which browsers never send to the server.
function readHash() {
  const parsed = parseHash(location.hash)
  // Don't leave a private key sitting in the address bar or history.
  if (parsed.identity) history.replaceState(null, "", `#${encodeURIComponent(parsed.code)}`)
  return parsed
}

const open = (code: string) => (location.hash = encodeURIComponent(code))

export default function App() {
  const auth = useAuth()
  const [sponsor, setSponsor] = useState(() => parseSponsorHash(location.hash))
  const [{ code, identity }, setHash] = useState(readHash)
  const [sheet, setSheet] = useState<"new" | "join" | null>(null)
  const rows = useChannelList(auth.status === "signed-in", auth.token)

  useEffect(() => {
    const onHash = () => {
      setSponsor(parseSponsorHash(location.hash))
      setHash(readHash())
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  // The old address hands this browser's channels to the new one (see lib/move.ts).
  const [movable, setMovable] = useState(hasChannelsToMove)
  useEffect(() => {
    if (location.hash !== "#import") return
    return receiveChannels((count) => {
      history.replaceState(null, "", "/")
      toast(count ? `Moved ${count} ${count === 1 ? "channel" : "channels"} to this address` : "Nothing new to move")
      setTimeout(() => location.reload(), 900)
    })
  }, [])

  const close = () => {
    history.replaceState(null, "", location.pathname)
    setHash({ code: "", identity: null })
  }

  return (
    <>
      {movable && (
        <div className="flex items-center gap-3 bg-accent-wash px-4 py-2 text-[13px]">
          <span className="min-w-0 flex-1">Channels moved to {NEW_ORIGIN.replace("https://", "")}. Move this browser’s channels and keys there.</span>
          <Button
            size="sm"
            onClick={() =>
              moveChannels()
                .then((n) => {
                  setMovable(false)
                  toast(`Moved ${n} ${n === 1 ? "channel" : "channels"}. Use ${NEW_ORIGIN.replace("https://", "")} from now on.`)
                })
                .catch((err: unknown) => toast(errorText(err), "error"))
            }
          >
            Move
          </Button>
        </div>
      )}
      {sponsor ? (
        <SponsorPage {...sponsor} onOpen={open} />
      ) : (
        <div className="flex h-svh overflow-hidden">
          <Sidebar rows={rows} active={code} onSelect={open} onNew={() => setSheet("new")} onJoin={() => setSheet("join")} className={code ? "hidden md:flex" : "flex"} />
          <main className={cx("min-w-0 flex-1", code ? "flex" : "hidden md:flex")}>
            {code ? (
              <Boundary resetKey={code}>
                <ChannelGate key={code} code={code} identity={identity} listed={rows.find((r) => r.code === code)} onBack={close} onGone={close} />
              </Boundary>
            ) : (
              <Welcome onNew={() => setSheet("new")} onJoin={() => setSheet("join")} />
            )}
          </main>
        </div>
      )}
      <NewChannel
        open={sheet === "new"}
        onClose={() => setSheet(null)}
        onCreated={(c) => {
          setSheet(null)
          open(c)
        }}
      />
      <JoinWithCode
        open={sheet === "join"}
        onClose={() => setSheet(null)}
        onJoin={(c) => {
          setSheet(null)
          open(c)
        }}
      />
      <Toaster />
    </>
  )
}
