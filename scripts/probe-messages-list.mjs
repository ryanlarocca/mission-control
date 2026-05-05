import fs from "node:fs"
import { google } from "googleapis"

const env = {}
for (const line of fs.readFileSync("/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local", "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2]; if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1)
  env[m[1]] = v
}
const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY)
const subject = process.argv[2]
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  subject,
})
const gmail = google.gmail({ version: "v1", auth })

const { data } = await gmail.users.messages.list({
  userId: "me",
  q: "in:inbox newer_than:1h",
  maxResults: 25,
})
console.log(`messages.list result: count=${(data.messages || []).length}, resultSizeEstimate=${data.resultSizeEstimate}`)
for (const m of (data.messages || []).slice(0, 8)) {
  const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From","Subject"] })
  const from = (msg.payload?.headers || []).find(h => h.name?.toLowerCase() === "from")?.value
  const subjectH = (msg.payload?.headers || []).find(h => h.name?.toLowerCase() === "subject")?.value
  console.log(`  - ${msg.id} labels=${(msg.labelIds||[]).slice(0,4).join(",")} from="${from}" subject="${subjectH}"`)
}
