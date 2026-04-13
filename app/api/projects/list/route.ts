import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const PROJECTS_ROOT = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS"
const ARCHIVE_DIR = path.join(PROJECTS_ROOT, "_archive")
const READABLE_FILES = ["README.md", "CODY_BRIEF.md", "PROJECT_MEMO.md", "OVERVIEW.md", "MEMO.md"]
const SKIP_DIRS = ["_archive"]

interface ProjectEntry {
  id: string
  name: string
  files: string[]
  description: string
  modified: string
  completed: boolean
}

function scanDir(dirRoot: string, isCompleted: boolean): ProjectEntry[] {
  if (!fs.existsSync(dirRoot)) return []
  const entries = fs.readdirSync(dirRoot, { withFileTypes: true })
  return entries
    .filter(e => e.isDirectory())
    .map(dir => {
      const dirPath = path.join(dirRoot, dir.name)
      const files: string[] = []

      for (const filename of READABLE_FILES) {
        if (fs.existsSync(path.join(dirPath, filename))) {
          files.push(filename)
        }
      }

      let description = ""
      const readme = files.find(f => f === "README.md") || files[0]
      if (readme) {
        try {
          const content = fs.readFileSync(path.join(dirPath, readme), "utf-8")
          const lines = content.split("\n")
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
              description = trimmed.slice(0, 120)
              break
            }
          }
        } catch {}
      }

      const stat = fs.statSync(dirPath)

      return {
        id: dir.name,
        name: dir.name,
        files,
        description,
        modified: stat.mtime.toISOString(),
        completed: isCompleted,
      }
    })
}

export async function GET() {
  try {
    const active = scanDir(PROJECTS_ROOT, false).filter(p => !SKIP_DIRS.includes(p.id))
    const archived = scanDir(ARCHIVE_DIR, true)
    const projects = [...active, ...archived]
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())

    return NextResponse.json({ projects })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
