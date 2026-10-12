// One-off (2026-10-12): the Ridgeview "Completed" link from 10/06 had expired by
// the time the fetcher shipped. DocuSign's expired page offers SEND NEW LINK,
// which emails a fresh link to ryan@ — the mailbox the agent reads. Click it
// once so the live worker gets a real end-to-end run. Usage:
//   node scripts/inbox-agent/oneoff/oneoff-2026-10-12-docusign-send-new-link.mjs --url "<EmailStart link>"
import { openBrowser, makeShooter } from "../fetch/browser.mjs"

const url = (process.argv.find((a) => a.startsWith("--url=")) || "").slice(6) || process.argv[process.argv.indexOf("--url") + 1]
if (!url) {
  console.error("need --url")
  process.exit(1)
}
const { page, close } = await openBrowser({ headed: process.argv.includes("--headed") })
const shooter = makeShooter(page, `send-new-link-${Date.now()}`)
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
  await shooter.shot("landing")
  const btn = page.getByRole("button", { name: /send new link/i }).first()
  await btn.waitFor({ state: "visible", timeout: 10_000 })
  await btn.click()
  await page.waitForTimeout(2_500)
  await shooter.shot("after-click")
  const text = await page.locator("body").innerText().catch(() => "")
  console.log("page says:", text.replace(/\s+/g, " ").slice(0, 300))
  console.log("screenshots:", shooter.shots.join(", "))
} finally {
  await close()
}
