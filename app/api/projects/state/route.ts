import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const PROJECTS_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS"
const ARCHIVE_DIR = path.join(PROJECTS_DIR, "_archive")
const STATE_FILE = path.join(PROJECTS_DIR, ".mc-state.json")

function readState(): { completed: string[] } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))
  } catch {
    return { completed: [] }
  }
}

function writeState(state: { completed: string[] }) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8")
}

export async function POST(request: Request) {
  const { id, action } = await request.json()

  if (!id || !["complete", "restore"].includes(action)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const state = readState()

  if (action === "complete" && !state.completed.includes(id)) {
    state.completed.push(id)
    // Move project folder to _archive/
    const src = path.join(PROJECTS_DIR, id)
    const dest = path.join(ARCHIVE_DIR, id)
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true })
      fs.renameSync(src, dest)
    }
  } else if (action === "restore") {
    state.completed = state.completed.filter(x => x !== id)
    // Move project folder back from _archive/
    const src = path.join(ARCHIVE_DIR, id)
    const dest = path.join(PROJECTS_DIR, id)
    if (fs.existsSync(src)) {
      // Remove stale destination if it exists before restoring
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true })
      }
      fs.renameSync(src, dest)
    }
  }

  writeState(state)
  return NextResponse.json({ ok: true, completed: state.completed })
}
