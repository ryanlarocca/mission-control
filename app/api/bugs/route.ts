import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const BUGS_ROOT = "/Users/ryanlarocca/.openclaw/workspace/Bugs"

interface BugFile {
  name: string
  path: string
  preview: string
}

interface BugSession {
  date: string
  files: BugFile[]
  modified: string
}

export async function GET() {
  try {
    if (!fs.existsSync(BUGS_ROOT)) {
      return NextResponse.json({ sessions: [] })
    }

    const entries = fs.readdirSync(BUGS_ROOT, { withFileTypes: true })
    const sessions: BugSession[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = path.join(BUGS_ROOT, entry.name)
      const files: BugFile[] = []

      const mdFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith(".md"))
        .sort()

      for (const filename of mdFiles) {
        const filePath = path.join(dirPath, filename)
        let preview = ""
        try {
          const content = fs.readFileSync(filePath, "utf-8")
          const lines = content.split("\n")
          for (const line of lines) {
            const t = line.trim()
            if (t && !t.startsWith("#") && !t.startsWith("---")) {
              preview = t.slice(0, 100)
              break
            }
          }
        } catch {}

        files.push({
          name: filename,
          path: path.join(entry.name, filename),
          preview,
        })
      }

      const stat = fs.statSync(dirPath)
      sessions.push({
        date: entry.name,
        files,
        modified: stat.mtime.toISOString(),
      })
    }

    sessions.sort((a, b) => b.date.localeCompare(a.date))
    return NextResponse.json({ sessions })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
