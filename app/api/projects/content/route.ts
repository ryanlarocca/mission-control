import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const PROJECTS_ROOT = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS"
const ARCHIVE_DIR = path.join(PROJECTS_ROOT, "_archive")
const ALLOWED_FILES = ["README.md", "CODY_BRIEF.md", "PROJECT_MEMO.md", "OVERVIEW.md", "MEMO.md"]

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const project = searchParams.get("project")
  const file = searchParams.get("file")

  if (!project || !file) {
    return NextResponse.json({ error: "Missing project or file param" }, { status: 400 })
  }

  // Safety: no path traversal
  if (project.includes("..") || project.includes("/") || !ALLOWED_FILES.includes(file)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 })
  }

  // Check active location first, then archive
  const candidates = [
    path.join(PROJECTS_ROOT, project, file),
    path.join(ARCHIVE_DIR, project, file),
  ]

  for (const filePath of candidates) {
    if (!filePath.startsWith(PROJECTS_ROOT)) continue
    try {
      const content = fs.readFileSync(filePath, "utf-8")
      return NextResponse.json({ content, project, file })
    } catch {}
  }

  return NextResponse.json({ error: "File not found" }, { status: 404 })
}
