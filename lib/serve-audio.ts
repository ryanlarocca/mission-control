import { NextResponse } from "next/server"

// Serve a fully-downloaded audio file with real byte-range support.
//
// Twilio sends recording media chunked, with no Content-Length and
// "Accept-Ranges: none". Desktop Chrome copes, but iPhone Safari won't play
// <audio> without ranges — it opens with "Range: bytes=0-1", expects a 206,
// and otherwise shows the clip as an unplayable "Live Broadcast"
// (2026-11-17). So we buffer the file and answer ranges ourselves.
//
// Each 206 is capped at MAX_CHUNK so no single response nears Vercel's
// function payload limit; browsers ask again for the rest.

const MAX_CHUNK = 2 * 1024 * 1024

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

export function serveAudio(
  bytes: Uint8Array,
  rangeHeader: string | null,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  const total = bytes.byteLength
  const base: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ...extraHeaders,
  }

  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === "" && m[2] === "")) {
    return new NextResponse(stream(bytes), {
      status: 200,
      headers: { ...base, "Content-Length": String(total) },
    })
  }

  let start: number
  let end: number
  if (m[1] === "") {
    // Suffix range: the last N bytes.
    start = Math.max(0, total - Number(m[2]))
    end = total - 1
  } else {
    start = Number(m[1])
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1)
  }
  if (start >= total || start > end) {
    return new NextResponse(null, {
      status: 416,
      headers: { ...base, "Content-Range": `bytes */${total}` },
    })
  }
  end = Math.min(end, start + MAX_CHUNK - 1)

  return new NextResponse(stream(bytes.subarray(start, end + 1)), {
    status: 206,
    headers: {
      ...base,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${total}`,
    },
  })
}
