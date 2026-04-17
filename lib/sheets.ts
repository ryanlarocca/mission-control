import { google } from "googleapis"

export const SHEET_ID = "1sJyF3aLZxaGdA4l-i8G3Vy3yZliJjekdG6B9m3ydBIQ"

export function getSheetsClient() {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(key)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
  return google.sheets({ version: "v4", auth })
}
