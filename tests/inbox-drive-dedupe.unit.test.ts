// Inbox agent — filing proposals check Drive first (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md, Part G).
// Dominic Wooten's three re-scrubbed CSVs (10-13 / 10-14) sat as proposals while
// the identical bytes lived in Marketing/2026/NOO October2026/Raw… as
// "v2 2026-10-14 - <name>.csv". driveDuplicateOf matches size first, then
// md5Checksum; walkFolder lists a subtree against a fake Drive client.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { driveDuplicateOf } from "../scripts/inbox-agent/filing.mjs"
import { WALK_MAX_FILES, listChildren, walkFolder } from "../scripts/inbox-agent/drive.mjs"

const md5 = (s: string) => createHash("md5").update(s).digest("hex")

// The three CSVs from the brief: names, byte sizes and the Drive ids of the hand-uploaded v2 copies.
const DOMINIC = [
  { name: "ALL Santa Cruz Co NOO SFR 11+ yr.csv", size: 2_452_735, md5: md5("santa cruz"), driveId: "1CB99tecfNMh4lxzALcl8arU42bX6vat0" },
  { name: "ALL SC Co NOO SFR 11+ yr.csv", size: 13_641_311, md5: md5("santa clara"), driveId: "1hknhStNli99VC2Yrw8YcgdL9rvbewwDF" },
  { name: "ALL SM Co NOO SFR 11+ yr.csv", size: 4_401_051, md5: md5("san mateo"), driveId: "1_SSfKvya7H7sGBK0byUhVPuEg8RKC5dc" },
]
const RAW = "Marketing/2026/NOO October2026/Raw (Dominic, 2026-10-14)"
const tree = [
  ...DOMINIC.map((d) => ({ id: d.driveId, name: `v2 2026-10-14 - ${d.name}`, size: d.size, md5Checksum: d.md5, webViewLink: `https://drive.google.com/file/d/${d.driveId}/view`, path: `${RAW}/v2 2026-10-14 - ${d.name}` })),
  // Decoy: the same size as the Santa Cruz list, different bytes.
  { id: "decoy", name: "v1 2026-10-08 - ALL Santa Cruz Co NOO SFR 11+ yr.csv", size: 2_452_735, md5Checksum: md5("older scrub"), webViewLink: "https://drive.google.com/file/d/decoy/view", path: `${RAW}/v1 2026-10-08 - ALL Santa Cruz Co NOO SFR 11+ yr.csv` },
  { id: "inv", name: "ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf", size: 120_000, md5Checksum: md5("invoice"), webViewLink: null, path: "Marketing/2026/NOO October2026/3 - MAIL HOUSE (quote, invoice, proofs)/ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf" },
  { id: "sheet", name: "Tracker", size: null, md5Checksum: null, webViewLink: null, path: "Marketing/2026/NOO October2026/Tracker" },
]

describe("driveDuplicateOf — size first, then md5", () => {
  it("each Dominic CSV hits its v2 copy by id; a same-size decoy with another md5 misses", () => {
    for (const d of DOMINIC) {
      const hit = driveDuplicateOf({ size: d.size, md5: d.md5 }, tree)
      expect(hit?.id, d.name).toBe(d.driveId)
      expect(hit?.name).toBe(`v2 2026-10-14 - ${d.name}`)
      expect(hit?.path?.startsWith(RAW)).toBe(true)
    }
    expect(driveDuplicateOf({ size: 2_452_735, md5: md5("a fourth scrub") }, tree)).toBeNull()
    expect(driveDuplicateOf({ size: 2_452_736, md5: DOMINIC[0].md5 }, tree)).toBeNull() // one byte off is not the same file
    expect(driveDuplicateOf({ size: DOMINIC[0].size, md5: DOMINIC[0].md5.toUpperCase() }, tree)?.id).toBe(DOMINIC[0].driveId)
  })
  it("never matches without an md5, a size, or against Google-native rows", () => {
    expect(driveDuplicateOf({ size: 100, md5: null }, tree)).toBeNull()
    expect(driveDuplicateOf({ size: null, md5: md5("x") }, tree)).toBeNull()
    expect(driveDuplicateOf({ size: 0, md5: md5("") }, [{ id: "z", name: "empty", size: 0, md5Checksum: md5("") }])).toBeNull()
    expect(driveDuplicateOf({ size: 10, md5: md5("x") }, [])).toBeNull()
    expect(driveDuplicateOf({ size: 10, md5: md5("x") }, null as never)).toBeNull()
  })
})

// ---- a fake Drive v3 client: files.list by parent, 2 per page, honouring the fields we ask for
type Node = { id: string; name: string; mimeType: string; size?: number; md5Checksum?: string; parent: string | null }
const FOLDER = "application/vnd.google-apps.folder"
function fakeDrive(nodes: Node[], calls: string[] = []) {
  return {
    calls,
    files: {
      list: async ({ q, pageToken, fields }: { q: string; pageToken?: string; fields: string }) => {
        expect(fields).toMatch(/md5Checksum/)
        expect(fields).toMatch(/\bsize\b/)
        const parent = /'([^']+)' in parents/.exec(q)?.[1]
        calls.push(parent || "?")
        const kids = nodes.filter((n) => n.parent === parent)
        const start = Number(pageToken || 0)
        const page = kids.slice(start, start + 2)
        return { data: { files: page.map((n) => ({ id: n.id, name: n.name, mimeType: n.mimeType, size: n.size != null ? String(n.size) : undefined, md5Checksum: n.md5Checksum, webViewLink: `https://drive/${n.id}` })), nextPageToken: start + 2 < kids.length ? String(start + 2) : undefined } }
      },
    },
  }
}
const nodes: Node[] = [
  { id: "mk", name: "Marketing", mimeType: FOLDER, parent: null },
  { id: "y26", name: "2026", mimeType: FOLDER, parent: "mk" },
  { id: "noo", name: "NOO October2026", mimeType: FOLDER, parent: "y26" },
  { id: "raw", name: "Raw (Dominic, 2026-10-14)", mimeType: FOLDER, parent: "noo" },
  { id: "deep", name: "too deep", mimeType: FOLDER, parent: "raw" },
  { id: "deepfile", name: "buried.csv", mimeType: "text/csv", size: 1, md5Checksum: md5("buried"), parent: "deep" },
  ...DOMINIC.map((d) => ({ id: d.driveId, name: `v2 2026-10-14 - ${d.name}`, mimeType: "text/csv", size: d.size, md5Checksum: d.md5, parent: "raw" })),
  { id: "sheet", name: "Tracker", mimeType: "application/vnd.google-apps.spreadsheet", parent: "noo" },
  { id: "mh", name: "3 - MAIL HOUSE (quote, invoice, proofs)", mimeType: FOLDER, parent: "noo" },
  { id: "inv", name: "ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf", mimeType: "application/pdf", size: 120_000, md5Checksum: md5("invoice"), parent: "mh" },
  { id: "logo", name: "logo.png", mimeType: "image/png", size: 5_000, md5Checksum: md5("logo"), parent: "mk" },
]

describe("walkFolder — every non-folder descendant with size, md5 and path", () => {
  it("walks Marketing/2026 three levels deep, skips Google-native files, builds the relative path, and pages", async () => {
    const drive = fakeDrive(nodes)
    const files = await walkFolder(drive as never, "y26", { maxDepth: 3, pathPrefix: "Marketing/2026" })
    const names = files.map((f) => f.path).sort()
    expect(names).toEqual([
      "Marketing/2026/NOO October2026/3 - MAIL HOUSE (quote, invoice, proofs)/ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf",
      ...DOMINIC.map((d) => `Marketing/2026/NOO October2026/Raw (Dominic, 2026-10-14)/v2 2026-10-14 - ${d.name}`),
    ].sort())
    const sc = files.find((f) => f.id === DOMINIC[1].driveId)
    expect(sc).toEqual({ id: DOMINIC[1].driveId, name: `v2 2026-10-14 - ${DOMINIC[1].name}`, size: 13_641_311, md5Checksum: DOMINIC[1].md5, webViewLink: `https://drive/${DOMINIC[1].driveId}`, path: `Marketing/2026/NOO October2026/Raw (Dominic, 2026-10-14)/v2 2026-10-14 - ${DOMINIC[1].name}` })
    // Depth: files in 2026 (1), NOO (2) and Raw (3) are listed; "too deep" (4) is not descended into at maxDepth 3 …
    expect(files.some((f) => f.id === "deepfile")).toBe(false)
    expect(drive.calls).not.toContain("deep")
    // … and is at the default depth of 4 (Marketing → 2026 → NOO October2026 → Raw, as the brief's path runs).
    expect((await walkFolder(fakeDrive(nodes) as never, "y26")).some((f) => f.id === "deepfile")).toBe(true)
    // The Dominic bytes match through the walk.
    for (const d of DOMINIC) expect(driveDuplicateOf({ size: d.size, md5: d.md5 }, files)?.id).toBe(d.driveId)
    expect(driveDuplicateOf({ size: 2_452_735, md5: md5("fresh scrub") }, files)).toBeNull()
  })
  it("maxDepth 1 lists only the folder's own files; the file cap stops the walk; listChildren exposes md5Checksum", async () => {
    expect((await walkFolder(fakeDrive(nodes) as never, "mk", { maxDepth: 1 })).map((f) => f.path)).toEqual(["logo.png"])
    const capped = await walkFolder(fakeDrive(nodes) as never, "mk", { maxDepth: 5, maxFiles: 2 })
    expect(capped).toHaveLength(2)
    expect(WALK_MAX_FILES).toBe(2000)
    const kids = await listChildren(fakeDrive(nodes) as never, "raw")
    expect(kids.map((k) => k.md5Checksum).filter(Boolean)).toHaveLength(3)
    expect(kids.map((k) => k.name)).toEqual([...kids.map((k) => k.name)].sort((a, b) => a.localeCompare(b)))
  })
})
