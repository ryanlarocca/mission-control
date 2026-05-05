import fs from "node:fs"
import { google } from "googleapis"

const env = {}
for (const line of fs.readFileSync("/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local", "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2]; if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v = v.slice(1, -1)
  env[m[1]] = v
}
const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY)
const subject = process.argv[2]
const startHistoryId = process.argv[3]
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  subject,
})
const gmail = google.gmail({ version: "v1", auth })

console.log(`Calling history.list for ${subject} startHistoryId=${startHistoryId}`)
try {
  const { data } = await gmail.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
    labelId: "INBOX",
  })
  console.log("history result:", JSON.stringify({ historyId: data.historyId, count: (data.history || []).length, nextPageToken: data.nextPageToken }, null, 2))
  for (const h of data.history || []) {
    for (const ma of h.messagesAdded || []) {
      console.log(`  added: id=${ma.message?.id} threadId=${ma.message?.threadId} labels=${(ma.message?.labelIds||[]).join(",")}`)
    }
  }
} catch (e) {
  console.error("history.list FAILED:", e.message)
  console.error("status:", e.code, "errors:", JSON.stringify(e.errors || e.response?.data, null, 2))
}
