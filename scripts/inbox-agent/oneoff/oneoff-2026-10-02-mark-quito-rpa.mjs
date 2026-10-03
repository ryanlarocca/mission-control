#!/usr/bin/env node
// One-off 2026-10-02: the 2116 Quito Rd RPA (DocuSign 9/24, interview-set row) was
// moved by hand into Properties/2116 Quito Rd/Purchase & Sale/01 Offer RPA 2026-09-24.pdf.
// Mark its inbox_files row as filed so the backfill's sha256 dedupe sees it.
import { loadEnvLocal, sb } from "../env.mjs"
loadEnvLocal()
const now = new Date().toISOString()
const { data, error } = await sb()
  .from("inbox_files")
  .update({
    status: "filed", mode: "backfill", property_label: "2116 Quito Rd", property_key: "2116quito", doc_type: "purchase_agreement",
    final_folder: "Properties/2116 Quito Rd/Purchase & Sale", final_name: "01 Offer RPA 2026-09-24.pdf",
    drive_file_id: "13FAWBpiCdmH6lPW_7KAzmDYmfuFrCg--", drive_url: "https://drive.google.com/file/d/13FAWBpiCdmH6lPW_7KAzmDYmfuFrCg--/view", filed_at: now, resolved_at: now,
  })
  .eq("gmail_id", "1a0d406b2d3a864c")
  .ilike("filename", "%626.pdf")
  .select("id, status, final_name")
console.log(error ? `error: ${error.message}` : JSON.stringify(data))
