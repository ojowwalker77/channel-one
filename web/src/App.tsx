import { useEffect, useState } from "react"

import { ChannelView } from "@/components/channel/channel-view"
import { GlobalBoard } from "@/components/channel/global-board"
import { knownChannels, parseHash } from "@/lib/channel"
import { JoinScreen } from "@/components/channel/join-screen"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

// The join code (and optionally a signing identity) live in the URL
// fragment, which browsers never send to the server.
function readHash() {
  const parsed = parseHash(location.hash)
  // Don't leave a private key sitting in the address bar or history.
  if (parsed.identity) history.replaceState(null, "", `#${encodeURIComponent(parsed.code)}`)
  return parsed
}

export default function App() {
  const [{ code, identity }, setHash] = useState(readHash)
  const setCode = (c: string) => setHash({ code: c, identity: null })
  const [global, setGlobal] = useState(false)
  const [channels, setChannels] = useState(knownChannels)

  useEffect(() => {
    const onHash = () => {
      setHash(readHash())
      setGlobal(false)
      setChannels(knownChannels())
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      {code ? (
        <ChannelView
          key={code}
          code={code}
          identity={identity}
          onLeave={() => {
            history.replaceState(null, "", location.pathname)
            setCode("")
            setChannels(knownChannels())
          }}
        />
      ) : global && channels.length ? (
        <GlobalBoard channels={channels} onOpen={(c) => (location.hash = encodeURIComponent(c))} onBack={() => setGlobal(false)} />
      ) : (
        <JoinScreen
          channels={channels}
          onJoin={(c) => (location.hash = encodeURIComponent(c))}
          onGlobal={() => setGlobal(true)}
        />
      )}
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
