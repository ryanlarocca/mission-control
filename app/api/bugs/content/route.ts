import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const BUGS_ROOT = "/Users/ryanlarocca/.openclaw/workspace/Bugs"

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const filePath = searchParams.get("path")

  if (!filePath) {
    return NextResponse.json({ error: "No path provided" }, { status: 400 })
  }

  // Safety: prevent path traversal
  const resolved = path.resolve(BUGS_ROOT, filePath)
  if (!resolved.startsWith(BUGS_ROOT)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 })
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8")
    return NextResponse.json({ content })
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 })
  }
}
