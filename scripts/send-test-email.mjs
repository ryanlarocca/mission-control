import fs from "node:fs"
import path from "node:path"
import { google } from "googleapis"

// Load .env.local
const envPath = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/.env.local"
const envText = fs.readFileSync(envPath, "utf-8")
const env = {}
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  env[m[1]] = v
}

const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY)
const subject = process.argv[2]   // mailbox to impersonate
const to = process.argv[3]
const subjectLine = process.argv[4]
const body = process.argv[5]
const fromOverride = process.argv[6] || subject  // optional "Name" <email>-style override

const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  subject,
})
const gmail = google.gmail({ version: "v1", auth })

// Build raw RFC 822 message.
const raw = [
  `From: ${fromOverride}`,
  `To: ${to}`,
  `Subject: ${subjectLine}`,
  `MIME-Version: 1.0`,
  `Content-Type: text/plain; charset="UTF-8"`,
  ``,
  body,
].join("\r\n")
const encoded = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const { data } = await gmail.users.messages.send({
  userId: "me",
  requestBody: { raw: encoded },
})
console.log(JSON.stringify({ id: data.id, threadId: data.threadId, labelIds: data.labelIds }))
