import fs from "node:fs"
import { google } from "googleapis"

const env = {}
for (const line of fs.readFileSync("/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local","utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2]; if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1)
  env[m[1]] = v
}
const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY)
const subject = process.argv[2]
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  subject,
})
const gmail = google.gmail({ version: "v1", auth })

// List the most recent 5 INBOX messages
const list = await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 5 })
console.log("INBOX top 5:", list.data.messages?.length || 0, "messages")
for (const m of (list.data.messages || []).slice(0,3)) {
  const { data } = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From","Subject","Date"] })
  const h = (n) => (data.payload?.headers || []).find(x => x.name?.toLowerCase() === n.toLowerCase())?.value
  console.log(`  - ${data.id} labels=${(data.labelIds||[]).join(",")} From="${h("From")}" Subject="${h("Subject")}"`)
}

// Also probe profile to get current historyId
const prof = await gmail.users.getProfile({ userId: "me" })
console.log("\nProfile:", JSON.stringify({email: prof.data.emailAddress, historyId: prof.data.historyId, messagesTotal: prof.data.messagesTotal}))
