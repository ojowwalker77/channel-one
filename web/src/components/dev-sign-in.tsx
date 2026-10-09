import { Dialog } from "@base-ui/react/dialog"
import { useState } from "react"

import { Button, Modal, TextField } from "./kit"

/**
 * Dev sign-in (a local relay started with --dev-sign-in): no password, you're
 * whoever you name. Only for testing signed-in flows on your own machine.
 */
export function DevSignIn({ open, onClose, onSignIn }: { open: boolean; onClose: () => void; onSignIn: (name: string) => void }) {
  const [name, setName] = useState("")
  const ok = /^[A-Za-z0-9_-]{1,64}$/.test(name)
  return (
    <Modal open={open} onClose={onClose}>
      <form
        className="px-5 pt-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onSignIn(name)
        }}
      >
        <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">Dev sign-in</Dialog.Title>
        <Dialog.Description className="mt-1 text-[13px] leading-normal text-ink-2">
          This relay runs with dev sign-in: no password, you're whoever you name. For testing on this machine only.
        </Dialog.Description>
        <TextField autoFocus className="mt-4" placeholder="alice" value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Name" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ok}>
            Sign in
          </Button>
        </div>
      </form>
    </Modal>
  )
}
