import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const PROJECTS_ROOT = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS"
const SKIP = ["_archive", ".mc-state.json"]

export async function POST(request: Request) {
  const { name, description } = await request.json()

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 })
  }

  // Sanitize: lowercase, hyphens only
  const id = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")

  if (!id || SKIP.includes(id)) {
    return NextResponse.json({ error: "Invalid project name" }, { status: 400 })
  }

  const projectDir = path.join(PROJECTS_ROOT, id)

  if (fs.existsSync(projectDir)) {
    return NextResponse.json({ error: "Project already exists" }, { status: 409 })
  }

  fs.mkdirSync(projectDir, { recursive: true })

  const date = new Date().toISOString().split("T")[0]
  const memo = `# ${name.trim()}\n\n**Date:** ${date}\n**Status:** Planning\n\n${description ? description.trim() + "\n" : ""}`
  fs.writeFileSync(path.join(projectDir, "PROJECT_MEMO.md"), memo, "utf-8")

  return NextResponse.json({ ok: true, id })
}
