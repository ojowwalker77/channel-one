// Opens every menu, popover and dialog of the dashboard once, on the production
// build, and fails on any page error. Base UI throws on a misplaced part (a group
// label outside its group, say) only when that part renders, so typecheck can't
// see it: b085ae8 was one, and it blanked the page in prod.
//
//   bun run web:build && bun scripts/smoke-ui.ts
//
// Needs Playwright's Chromium: bunx playwright-core install --only-shell chromium
// (or set SMOKE_CHROMIUM to a Chrome binary).

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Locator, type Page } from "playwright-core"

const ROOT = resolve(import.meta.dir, "..")
const PORT = 20000 + Math.floor(Math.random() * 20000)
const URL = `http://127.0.0.1:${PORT}/`
const data = mkdtempSync(join(tmpdir(), "kiwi-smoke-"))

const relay = spawn("bun", ["src/relay/bun.ts", "--hostname", "127.0.0.1", "--port", String(PORT), "--data", data, "--dev-sign-in"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] })
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
  await page.goto(URL)
  await opens("Join with a code (signed out)", () => page.getByRole("main").getByRole("button", { name: "Join with a code" }).click())

  at = "dev sign-in"
  await page.getByRole("button", { name: "Sign in" }).first().click()
  await page.getByRole("textbox", { name: "Name" }).fill("smoke")
  await page.getByRole("dialog").getByRole("button", { name: "Sign in" }).click()
  const account = page.getByRole("complementary").getByRole("button", { name: /smoke/ })
  await account.waitFor()

  await opens("Account menu", () => account.click())
  await eachItem("Account menu", account, (l) => l !== "Sign out")
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
