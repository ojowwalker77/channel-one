// Opens every menu, popover and dialog of the dashboard once, on the production
// build, and fails on any page error. Base UI throws on a misplaced part (a group
// label outside its group, say) only when that part renders, so typecheck can't
// see it: b085ae8 was one, and it blanked the page in prod.
//
// Beyond menus, it walks the flows only real state reaches: a passkey set up and
// unlocked on Chromium's virtual authenticator, the invite preview a join link
// shows someone who isn't in yet, a reload that paints the sent message from
// the sealed cache and asks the relay only for newer ones, a computer linked
// through its #link page by `kiwi setup`, that computer's agent asking to join
// and approved, and the task it adds opened from the board.
//
//   bun run web:build && bun scripts/smoke-ui.ts
//
// Needs Playwright's Chromium: bunx playwright-core install --only-shell chromium
// (or set SMOKE_CHROMIUM to a Chrome binary).

import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Locator, type Page } from "playwright-core"

const ROOT = resolve(import.meta.dir, "..")
const PORT = 20000 + Math.floor(Math.random() * 20000)
// localhost, not 127.0.0.1: WebAuthn refuses an IP address as the passkey's site.
const BASE = `http://localhost:${PORT}/`
const data = mkdtempSync(join(tmpdir(), "kiwi-smoke-"))

// A computer of the smoke person's, for an agent to join from: its own kiwi home, no Claude Code
// settings to touch, and no browser to open (kiwi setup opens the link page; the test visits it).
const cli = join(data, "cli")
mkdirSync(join(cli, "bin"), { recursive: true })
mkdirSync(join(data, "relay"))
for (const opener of ["open", "xdg-open"]) {
  writeFileSync(join(cli, "bin", opener), "#!/bin/sh\nexit 0\n")
  chmodSync(join(cli, "bin", opener), 0o755)
}
const cliEnv = { ...process.env, KIWI_HOME: join(cli, "home"), CLAUDE_CONFIG_DIR: join(cli, "no-claude"), PATH: `${join(cli, "bin")}:${process.env.PATH}` }
/** Run kiwi as that computer; resolves with its output once it exits, and lets you watch it meanwhile. */
function kiwi(args: string[], watch?: (out: string) => void): Promise<string> {
  const p = spawn("bun", ["src/cli/main.ts", ...args], { cwd: ROOT, env: cliEnv })
  let out = ""
  const on = (d: Buffer) => ((out += d), watch?.(out))
  p.stdout.on("data", on)
  p.stderr.on("data", on)
  return new Promise((ok, fail) => p.on("exit", (code) => (code === 0 ? ok(out) : fail(new Error(`kiwi ${args[0]} exited ${code}: ${out.trim().split("\n").pop()}`)))))
}

const relay = spawn("bun", ["src/relay/bun.ts", "--hostname", "127.0.0.1", "--port", String(PORT), "--data", join(data, "relay"), "--dev-sign-in"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] })
await new Promise<void>((ok, fail) => {
  let out = ""
  relay.stdout!.on("data", (d) => {
    out += d
    if (out.includes("dashboard: not served")) fail(new Error("web/dist is missing: run bun run web:build first"))
    else if (out.includes("dashboard:")) ok()
  })
  relay.on("exit", (code) => fail(new Error(`relay exited (${code})`)))
})

const errors: string[] = []
let at = "start"
// The relay is a child process: if the browser can't start, stop it too, or this never exits.
const browser = await chromium.launch({ executablePath: process.env.SMOKE_CHROMIUM || undefined }).catch((e) => {
  relay.kill()
  rmSync(data, { recursive: true, force: true })
  throw e
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on("pageerror", (e) => errors.push(`${at}: ${e.message}`))
page.on("console", (m) => {
  // A refused request is the app's business (and logged by the browser); a thrown render is not.
  if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(`${at}: console: ${m.text()}`)
})

const popup = (p: Page) => p.locator("[role=menu], [role=dialog], [role=alertdialog]").last()

/** Open something, check its popup rendered, close it with Escape. */
async function opens(name: string, open: () => Promise<void>) {
  at = name
  await open()
  await popup(page).waitFor({ state: "visible", timeout: 5000 })
  await page.keyboard.press("Escape")
  await page.locator("[role=menu], [role=dialog], [role=alertdialog]").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(150)
  console.log(`ok  ${name}`)
}

/** Every item in a menu that opens something else ("Rename…", "Your computers"), each once. */
async function eachItem(name: string, trigger: Locator, only: (label: string) => boolean) {
  await trigger.click()
  await page.getByRole("menu").waitFor()
  const labels = (await page.getByRole("menu").getByRole("menuitem").allInnerTexts()).map((s) => s.trim()).filter(only)
  await page.keyboard.press("Escape")
  for (const label of labels)
    await opens(`${name} → ${label}`, async () => {
      await trigger.click()
      await page.getByRole("menu").waitFor()
      await page.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click()
    })
}

try {
  await page.goto(BASE)
  await opens("Join with a code (signed out)", () => page.getByRole("main").getByRole("button", { name: "Join with a code" }).click())

  at = "dev sign-in"
  await page.getByRole("button", { name: "Sign in" }).first().click()
  await page.getByRole("textbox", { name: "Name" }).fill("smoke")
  await page.getByRole("dialog").getByRole("button", { name: "Sign in" }).click()
  const account = page.getByRole("complementary").getByRole("button", { name: /smoke/ })
  await account.waitFor()

  // Passkeys on Chromium's virtual authenticator, PRF on: set one up and save the recovery code.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  } as never)
  at = "Set up passkey"
  await page.getByRole("button", { name: "Set up passkey" }).click()
  const saving = page.getByRole("dialog").filter({ hasText: "Save your recovery code" })
  await saving.waitFor()
  await saving.getByRole("checkbox").check()
  await saving.getByRole("button", { name: "Done" }).click()
  await saving.waitFor({ state: "hidden" })
  console.log(`ok  ${at}`)

  await opens("Account menu", () => account.click())
  await eachItem("Account menu", account, (l) => l !== "Sign out")

  // Sign out and back in: the vault is locked, and opens with the passkey.
  at = "sign out and back in"
  await account.click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await page.getByRole("button", { name: "Sign in" }).first().click()
  await page.getByRole("textbox", { name: "Name" }).fill("smoke")
  await page.getByRole("dialog").getByRole("button", { name: "Sign in" }).click()
  await opens("Use recovery code", () => page.getByRole("button", { name: "Use recovery code" }).click())
  at = "Use passkey"
  await page.getByRole("button", { name: "Use passkey" }).click()
  await page.getByRole("button", { name: "Use passkey" }).waitFor({ state: "hidden" })
  console.log(`ok  ${at}`)
  at = "Appearance → Dark"
  await account.click()
  await page.getByRole("menuitemradio", { name: "Dark" }).click()
  await page.getByRole("menu").waitFor({ state: "hidden" })
  console.log(`ok  ${at}`)
  await opens("Go to… palette", () => page.getByRole("button", { name: /^Go to…/ }).click())
  const plus = page.getByRole("button", { name: "New channel or join" })
  await eachItem("New channel or join", plus, () => true)

  at = "create a channel"
  await plus.click()
  await page.getByRole("menu").waitFor()
  await page.getByRole("menuitem", { name: "New channel" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("smoke")
  await page.getByRole("button", { name: "Create channel" }).click()
  await page.waitForURL(/#mc2-/)
  await page.getByPlaceholder(/^Write to the channel/).waitFor()

  // Someone who isn't in yet, opening the join link: the preview names the owner.
  // That fetch has to send the code's fingerprint, or /info answers 426 and the name never arrives.
  at = "invite preview"
  const inviteCode = decodeURIComponent(new URL(page.url()).hash.slice(1))
  const guest = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  guest.on("pageerror", (e) => errors.push(`${at}: ${e.message}`))
  try {
    await guest.goto(`${BASE}#${encodeURIComponent(inviteCode)}`)
    await guest.getByRole("heading", { name: "Smoke (dev) invited you to a channel" }).waitFor({ timeout: 10000 })
    console.log(`ok  ${at}`)
  } finally {
    await guest.close()
  }

  await opens("People", () => page.getByRole("button", { name: /\d+ members?$/ }).click())
  await opens("Invite", () => page.getByRole("button", { name: "Invite" }).click())
  await opens("Invite → A person", async () => {
    await page.getByRole("button", { name: "Invite" }).click()
    await page.getByRole("dialog").getByRole("tab", { name: "A person" }).or(page.getByRole("dialog").getByRole("button", { name: "A person" })).first().click()
  })
  await eachItem("Channel menu", page.getByRole("button", { name: "Channel menu" }), (l) => l.endsWith("…"))
  await opens("Composer kind", () => page.getByRole("button", { name: /^Message/ }).click())

  at = "send and reply"
  await page.getByPlaceholder(/^Write to the channel/).fill("smoke test")
  await page.keyboard.press("Enter")
  const row = page.getByText("smoke test", { exact: true }).first()
  await row.waitFor()
  // The row's actions only show on hover, which headless pointers lose easily: click it directly.
  await page.locator("button[aria-label='Reply']").first().dispatchEvent("click")
  await page.getByRole("button", { name: "Close thread" }).waitFor()
  await page.getByRole("button", { name: "Close thread" }).click()
  console.log("ok  Thread panel")

  // The sent message is sealed in this browser. A reload paints it and the
  // socket asks only for seqs after that row. "smoke test" contains a space,
  // which ciphertext (base64url) cannot, so a stored body fails this check.
  at = "history cache"
  await page.waitForFunction(async () => {
    const rows = await new Promise<unknown[]>((resolve) => {
      const req = indexedDB.open("mc.history")
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains("rows")) {
          db.close()
          resolve([])
          return
        }
        const all = db.transaction("rows", "readonly").objectStore("rows").getAll()
        all.onsuccess = () => {
          db.close()
          resolve(all.result as unknown[])
        }
        all.onerror = () => {
          db.close()
          resolve([])
        }
      }
      req.onerror = () => resolve([])
    })
    return rows.length > 0 && !JSON.stringify(rows).includes("smoke test")
  }, undefined, { timeout: 5000 })
  console.log("ok  history cache sealed")

  at = "reload fetches only what is new"
  const sinceOnReload = new Promise<string>((resolve) => {
    const onWs = (ws: { url: () => string }) => {
      const since = new URL(ws.url()).searchParams.get("since")
      if (since == null) return
      page.off("websocket", onWs)
      resolve(since)
    }
    page.on("websocket", onWs)
  })
  await page.reload()
  await page.getByText("smoke test", { exact: true }).first().waitFor()
  const since = await sinceOnReload
  if (!(Number(since) > 0)) throw new Error(`reload streamed since ${since}; expected only newer seqs`)
  await page.getByRole("complementary").getByRole("button", { name: /smoke \(dev\)/ }).waitFor()
  console.log(`ok  reload fetches only what is new (since ${since})`)

  // An agent joins from a computer linked to this account: the link page, the request, approval.
  at = "link a computer"
  const channel = page.url()
  const code = new URL(channel).hash.slice(1)
  let opened = false
  const setup = kiwi(["setup", "--relay", BASE], (out) => {
    const link = /(http\S+#link=\S+)/.exec(out)?.[1]
    if (link && !opened) (opened = true), void page.goto(link)
  })
  await page.getByRole("button", { name: "Yes, link it" }).click({ timeout: 20000 })
  await setup
  console.log(`ok  ${at}`)
  await page.goto(channel)
  const joining = kiwi(["join", code, "smoke", "--relay", BASE, "--as", "bot", "--role", "tester"])
  const review = page.getByRole("button", { name: "Review", exact: true })
  await review.waitFor({ timeout: 30000 })
  await opens("Join requests", () => review.click())
  at = "approve"
  await review.click()
  await page.getByRole("button", { name: "Review and approve" }).click()
  await page.getByRole("button", { name: "Approve", exact: true }).click()
  await joining
  // The requests sheet closes on its own once it's empty (T281); before that, close it.
  await page.waitForTimeout(500)
  if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape")
  console.log(`ok  ${at}`)

  await kiwi(["-c", "smoke", "--as", "bot", "task", "add", "Smoke task", "--owner", "bot"])
  await page.getByRole("tab", { name: /^Tasks/ }).click()
  await opens("Task details", () => page.getByRole("button", { name: /Smoke task/ }).first().click({ timeout: 15000 }))
  await page.getByRole("tab", { name: "Chat" }).click()
  // What the owner can do to a member: each item behind their ⋯ in People.
  for (const item of ["Set role…", "Remove from channel…"])
    await opens(`People → bot → ${item}`, async () => {
      await page.getByRole("button", { name: /\d+ members?$/ }).click()
      await page.getByRole("button", { name: "More for bot" }).click()
      await page.getByRole("menuitem", { name: item }).click()
    })

  at = "Tasks"
  await page.getByRole("tab", { name: /^Tasks/ }).click()
  await page.getByRole("tab", { name: "Chat" }).click()
  await page.waitForTimeout(300)
  console.log("ok  Tasks")

  // Anything that announces a popup and isn't covered above: new menus get opened too.
  const triggers = await page.locator("[aria-haspopup]:visible").all()
  for (const [i, t] of triggers.entries()) {
    const label = (await t.getAttribute("aria-label")) || (await t.innerText()).trim().split("\n").pop()!.slice(0, 30) || `#${i}`
    if (!(await t.isEnabled())) continue
    await opens(`sweep: ${label}`, () => t.click())
  }
} catch (e) {
  errors.push(`${at}: ${e instanceof Error ? e.message.split("\n").slice(0, 6).join(" | ") : String(e)}`)
  await page.screenshot({ path: join(tmpdir(), "kiwi-smoke-failure.png") }).catch(() => {})
} finally {
  await browser.close()
  relay.kill()
  rmSync(data, { recursive: true, force: true })
}

if (errors.length) {
  console.error(`\nUI smoke failed:\n${errors.map((e) => `  ${e}`).join("\n")}\n(screenshot, if any: ${join(tmpdir(), "kiwi-smoke-failure.png")})`)
  process.exit(1)
}
console.log("\nUI smoke passed")
