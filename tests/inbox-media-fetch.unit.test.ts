// Inbox agent — listing photos from photographer deliveries, f8 first
// (briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md §6). Pure pieces only:
// provider detection, Postmark unwrapping, the Download Center parsers, the
// fetch flow against fixtures with an injected fetch, the dedupe verdict, the
// subject → property fallback.
//
// The HTML fixture is a trimmed copy of the real page; the bridge session may
// swap in the full 185 KB page, so everything here parses by structure (forms,
// labels, regexes) and never by byte offset. The JSON samples carry 3 of the
// real 36 entries — `synth()` grows them to 36 following the same pattern.
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { detectProvider, documentLinks, extractUrls, propertyWebsiteLinks, providerKind, providerLabel, unwrapTrackingUrl } from "../scripts/inbox-agent/fetch/providers.mjs"
import { cookieHeader, fetchF8, listingIdFrom, parseDownloadCenter, parseDownloadJson, parseSetCookies } from "../scripts/inbox-agent/fetch/f8.mjs"
import { MEDIA_JOB_TIMEOUT_MS, fetchDocuments } from "../scripts/inbox-agent/fetch/index.mjs"
import { mimeFor } from "../scripts/inbox-agent/fetch/browser.mjs"
import { DUP_STATUSES, gmailLink, photoDedupeVerdict, propertyFolderFromReply, propertyLabelFromSubject, suffixedFilename } from "../scripts/inbox-agent/photos.mjs"

const FIX = path.join(__dirname, "fixtures", "f8")
const EMAIL = fs.readFileSync(path.join(FIX, "delivery-email.txt"), "utf8")
const HTML = fs.readFileSync(path.join(FIX, "download-center-5764-halleck.html"), "utf8")
const WEB = JSON.parse(fs.readFileSync(path.join(FIX, "download-web.json"), "utf8"))
const PRINT = JSON.parse(fs.readFileSync(path.join(FIX, "download-print.json"), "utf8"))

const LISTING = "01a136a0-d777-7338-9063-d76425919515"
const DOWNLOAD_CENTER = `https://f8.f8re.com/listings/${LISTING}/download-center?signature=ab5b8c867eea95e68c382ad1589301ad7857420d9b8f1842c7fbff43304ecb91`
const BRANDED = "https://f8.f8re.com/sites/5764-halleck-dr-san-jose-ca-95123-29967112/branded"
const UNBRANDED = "https://f8.f8re.com/sites/eoxyxpvo/unbranded"
const WEB_URL = `https://f8.f8re.com/${LISTING}/image-groups/unassigned/download/web`
const PRINT_URL = `https://f8.f8re.com/${LISTING}/image-groups/unassigned/download/print`
// The three Postmark-wrapped links exactly as they appear in the fixture email.
const TRACKED = EMAIL.match(/https:\/\/track\.pstmrk\.it\/\S+/g) as string[]

type Entry = { download_type: string; name: string; path: string; type: string }
/** Grow a 3-entry sample to n entries following the real naming pattern (n-00n_F8_5764 Halleck Dr.JPG, one UUID per image, same UUID in both sets). */
function synth(base: { zip_name: string; download_data: Entry[] }, n: number) {
  return {
    zip_name: base.zip_name,
    download_data: Array.from({ length: n }, (_, i) => {
      const t = base.download_data[i % base.download_data.length]
      const id = `01a13f27-${String(i + 1).padStart(4, "0")}-70c7-afe3-f20f1c3a52fa`
      return { ...t, name: t.name.replace(/\/\d+-\d{3}_/, `/${i + 1}-${String(i + 1).padStart(3, "0")}_`), path: t.path.replace(/[0-9a-f-]{36}\.jpeg$/, `${id}.jpeg`) }
    }),
  }
}
const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), Buffer.from(tag)])

/** A fake `fetch` serving the fixtures: the page (with cookies), both lists, tiny JPEGs from the CDN. */
function fakeF8({ pageStatus = 200, pageHtml = HTML, web = synth(WEB, 36), print = synth(PRINT, 36), failImage = null as string | null, calls = [] as Array<{ method: string; url: string; headers: Record<string, string> }> } = {}) {
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}))
    calls.push({ method: init.method || "GET", url, headers })
    if (/\/download-center/.test(url)) {
      const h = new Headers()
      h.append("set-cookie", "XSRF-TOKEN=xsrf123; expires=Thu, 16 Oct 2026 01:00:00 GMT; path=/; domain=.f8re.com; samesite=lax")
      h.append("set-cookie", "aryeo_session=sess456; path=/; domain=.f8re.com; httponly")
      return new Response(pageStatus === 200 ? pageHtml : "<html><body>Forbidden</body></html>", { status: pageStatus, headers: h })
    }
    if (url === WEB_URL) return new Response(JSON.stringify(web), { status: 200, headers: { "content-type": "application/json" } })
    if (url === PRINT_URL) return new Response(JSON.stringify(print), { status: 200, headers: { "content-type": "application/json" } })
    if (/^https:\/\/cdn\.aryeo\.com\//.test(url)) {
      if (failImage && url.includes(failImage)) return new Response("gone", { status: 404 })
      return new Response(jpeg(url), { status: 200, headers: { "content-type": "image/jpeg" } })
    }
    return new Response("not found", { status: 404 })
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe("detectProvider — f8", () => {
  it("recognises the Download Center link and nothing else on f8re.com", () => {
    expect(detectProvider(DOWNLOAD_CENTER)).toBe("f8")
    expect(detectProvider(`https://f8.f8re.com/listings/${LISTING}/download-center`)).toBe("f8") // signature stripped still answered 200
    expect(detectProvider("https://f8.f8re.com/portal")).toBeNull()
    expect(detectProvider(BRANDED)).toBeNull()
    expect(detectProvider(UNBRANDED)).toBeNull()
    expect(detectProvider("https://www.f8re.com/ambassadors")).toBeNull()
    expect(detectProvider("https://play.google.com/store/apps/details?id=com.aryeo.feightforrealestate")).toBeNull()
    expect(detectProvider("https://apps.apple.com/us/app/id6739542185")).toBeNull()
    expect(detectProvider("https://g.page/r/CVthacObP7jmEAI/review")).toBeNull()
    expect(detectProvider(`https://f8.f8re.com/${LISTING}/image-groups/unassigned/download/web`)).toBeNull()
    expect(detectProvider(`https://evil.example.com/listings/${LISTING}/download-center`)).toBeNull()
  })
  it("kinds and labels", () => {
    expect(providerKind("f8")).toBe("media")
    expect(providerKind("docusign")).toBe("document")
    expect(providerLabel("f8")).toBe("f8")
    expect(providerLabel("docusign")).toBe("DocuSign")
    expect(MEDIA_JOB_TIMEOUT_MS).toBe(10 * 60_000)
  })
})

describe("unwrapTrackingUrl / documentLinks on the f8 delivery email", () => {
  it("unwraps the three Postmark links to the exact plain URLs", () => {
    expect(TRACKED).toHaveLength(3)
    expect(unwrapTrackingUrl(TRACKED[0])).toBe(DOWNLOAD_CENTER)
    expect(unwrapTrackingUrl(TRACKED[1])).toBe(BRANDED)
    expect(unwrapTrackingUrl(TRACKED[2])).toBe(UNBRANDED)
  })
  it("passes everything else through untouched", () => {
    expect(unwrapTrackingUrl(DOWNLOAD_CENTER)).toBe(DOWNLOAD_CENTER)
    expect(unwrapTrackingUrl("https://track.pstmrk.it/other/abc")).toBe("https://track.pstmrk.it/other/abc")
    expect(unwrapTrackingUrl("not a url")).toBe("not a url")
    expect(unwrapTrackingUrl("https://track.pstmrk.it/3ts/https%3A%2F%2Fexample.com%2Fx/j")).toBe("https://example.com/x")
  })
  it("documentLinks finds exactly one f8 link — the wrapped and the plain Download Center link are one job", () => {
    const text = EMAIL.split("\n\n").slice(1).join("\n\n") // body (the Subject:/From:/To: lines are not part of msg.text)
    const urls = extractUrls(text)
    expect(urls.filter((u) => u === DOWNLOAD_CENTER)).toHaveLength(1)
    expect(urls.some((u) => /track\.pstmrk\.it/.test(u))).toBe(false)
    expect(documentLinks({ text })).toEqual([{ url: DOWNLOAD_CENTER, provider: "f8" }])
    // The classifier reported the wrapped link — still one job.
    expect(documentLinks({ text }, [TRACKED[0]])).toEqual([{ url: DOWNLOAD_CENTER, provider: "f8" }])
    expect(documentLinks({ text: `Download Link:\n${TRACKED[0]}` })).toEqual([{ url: DOWNLOAD_CENTER, provider: "f8" }])
  })
  it("propertyWebsiteLinks → branded + unbranded, null when absent", () => {
    expect(propertyWebsiteLinks(EMAIL)).toEqual({ branded: BRANDED, unbranded: UNBRANDED })
    expect(propertyWebsiteLinks(`Download Link:\n${TRACKED[0]}`)).toEqual({ branded: null, unbranded: null })
    expect(propertyWebsiteLinks("")).toEqual({ branded: null, unbranded: null })
  })
})

describe("parseDownloadCenter", () => {
  it("reads the token, the one `unassigned` group with both URLs, and the image count", () => {
    const p = parseDownloadCenter(HTML)
    expect(p.token).toBe("FIXTURE_TOKEN")
    expect(p.groups).toEqual([{ group: "unassigned", webUrl: WEB_URL, printUrl: PRINT_URL }])
    expect(p.imageCount).toBe(36)
    expect(p.counts).toEqual({ web: 36, print: 36 })
    expect(p.needs).toBeNull()
    expect(p.error).toBeNull()
  })
  it("handles HTML-escaped quotes and a second group", () => {
    const two = HTML.replace(/'/g, "&#039;").replace("</h4>", `</h4><form x-on:submit.prevent="fetchDownloadLinks($event, &#039;https://f8.f8re.com/${LISTING}/image-groups/twilight/download/print&#039;, &#039;z&#039;)"></form><form x-on:submit.prevent="fetchDownloadLinks($event, &#039;https://f8.f8re.com/${LISTING}/image-groups/twilight/download/web&#039;, &#039;z&#039;)"></form>`)
    const p = parseDownloadCenter(two)
    expect(p.token).toBe("FIXTURE_TOKEN")
    expect(p.groups.map((g) => g.group).sort()).toEqual(["twilight", "unassigned"])
    expect(p.groups.every((g) => g.webUrl && g.printUrl)).toBe(true)
  })
  it("a login page (password form, no token, no groups) → needs login; a bare page → plain error", () => {
    const login = parseDownloadCenter(`<html><form action="/login" method="POST"><input type="email" name="email"><input type="password" name="password"></form></html>`)
    expect(login.needs).toBe("login")
    expect(login.error).toMatch(/login/)
    const bare = parseDownloadCenter("<html><body>Nothing here</body></html>")
    expect(bare.needs).toBeNull()
    expect(bare.error).toMatch(/_token/)
    expect(parseDownloadCenter("").error).toBeTruthy()
  })
  it("listingIdFrom", () => {
    expect(listingIdFrom(DOWNLOAD_CENTER)).toBe(LISTING)
    expect(listingIdFrom("https://f8.f8re.com/portal")).toBeNull()
  })
})

describe("parseDownloadJson", () => {
  it("filenames = basename of name, imageId = the UUID in path, same id for the web and print copy", () => {
    const web = parseDownloadJson(WEB, "MLS")
    const print = parseDownloadJson(PRINT, "Print")
    expect(web.map((e) => e.filename)).toEqual(["1-001_F8_5764 Halleck Dr.JPG", "2-002_F8_5764 Halleck Dr.JPG", "3-003_F8_5764 Halleck Dr.JPG"])
    expect(web.map((e) => e.imageId)).toEqual(["01a13f27-25f0-70c7-afe3-f20f1c3a52fa", "01a13f27-26b3-7126-9e0a-5d38caa4adba", "01a13f27-2740-71e8-9c8f-ec33d78b63b0"])
    expect(print.map((e) => e.imageId)).toEqual(web.map((e) => e.imageId))
    expect(print.map((e) => e.filename)).toEqual(web.map((e) => e.filename))
    expect(web[0].url).toBe("https://cdn.aryeo.com/listings/5764-halleck-dr-san-jose-ca-95123-29967112/resized/large/large-01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg")
    expect(print[0].url).toBe("https://cdn.aryeo.com/listings/5764-halleck-dr-san-jose-ca-95123-29967112/01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg")
    expect(web.every((e) => e.set === "MLS")).toBe(true)
  })
  it("synthesizes 36 entries from the 3-entry pattern", () => {
    const entries = parseDownloadJson(synth(WEB, 36), "MLS")
    expect(entries).toHaveLength(36)
    expect(new Set(entries.map((e) => e.imageId)).size).toBe(36)
    expect(new Set(entries.map((e) => e.filename)).size).toBe(36)
    expect(entries[35].filename).toBe("36-036_F8_5764 Halleck Dr.JPG")
    expect(parseDownloadJson(synth(PRINT, 36), "Print").map((e) => e.imageId)).toEqual(entries.map((e) => e.imageId))
  })
  it("rejects non-url entries and paths off the Aryeo CDN", () => {
    const bad = {
      download_data: [
        { download_type: "zip", name: "images-for-printing/x.JPG", path: "https://cdn.aryeo.com/listings/s/01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg", type: "image" },
        { download_type: "url", name: "images-for-printing/y.JPG", path: "https://evil.example.com/01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg", type: "image" },
        { download_type: "url", name: "images-for-printing/z.JPG", path: "https://cdn.aryeo.com.evil.io/01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg", type: "image" },
        { download_type: "url", name: "images-for-printing/w.JPG", path: "http://cdn.aryeo.com/01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg", type: "image" },
        { download_type: "url", name: "images-for-printing/ok.JPG", path: "https://media.aryeo.com/listings/s/01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg", type: "image" },
      ],
    }
    expect(parseDownloadJson(bad, "Print").map((e) => e.filename)).toEqual(["ok.JPG"])
    expect(parseDownloadJson(null as unknown as object, "Print")).toEqual([])
  })
})

describe("cookie jar", () => {
  it("keeps name=value from each Set-Cookie, even a joined header with an Expires date", () => {
    const h = new Headers()
    h.append("set-cookie", "XSRF-TOKEN=xsrf123; expires=Thu, 16 Oct 2026 01:00:00 GMT; path=/; domain=.f8re.com")
    h.append("set-cookie", "aryeo_session=sess456; path=/; httponly")
    expect(cookieHeader(parseSetCookies(h))).toBe("XSRF-TOKEN=xsrf123; aryeo_session=sess456")
    const joined = { get: (k: string) => (k === "set-cookie" ? "XSRF-TOKEN=a; expires=Thu, 16 Oct 2026 01:00:00 GMT; path=/, aryeo_session=b; path=/" : null) }
    expect(cookieHeader(parseSetCookies(joined as unknown as Headers))).toBe("XSRF-TOKEN=a; aryeo_session=b")
  })
  it("mimeFor sniffs JPEG and PNG magic bytes", () => {
    expect(mimeFor("x.bin", jpeg("a"))).toBe("image/jpeg")
    expect(mimeFor("x.JPG", Buffer.from("not really an image"))).toBe("image/jpeg") // extension fallback
    expect(mimeFor("x.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe("image/png")
  })
})

describe("fetchF8 against the fixtures", () => {
  it("pulls both sets: 36/36/36, cookies + token + headers on the POSTs, CDN GETs without cookies", async () => {
    const { fetchImpl, calls } = fakeF8()
    const r = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t1", fetchImpl })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.counts).toEqual({ page: 36, mls: 36, print: 36 })
    expect(r.listingId).toBe(LISTING)
    expect(r.groups).toEqual(["unassigned"])
    expect(r.sets.map((s) => [s.set, s.files.length])).toEqual([["MLS", 36], ["Print", 36]])
    const mls = r.sets[0].files
    expect(mls[0].filename).toBe("1-001_F8_5764 Halleck Dr.JPG")
    expect(mls[0].mime).toBe("image/jpeg")
    expect(mls[0].imageId).toBe("01a13f27-0001-70c7-afe3-f20f1c3a52fa")
    expect(r.sets[1].files[0].imageId).toBe(mls[0].imageId)
    expect(Buffer.isBuffer(mls[0].bytes)).toBe(true)
    // 1 page + 2 lists + 72 images; the two POSTs carry the token, cookies and the AJAX headers.
    expect(calls).toHaveLength(75)
    const posts = calls.filter((c) => c.method === "POST")
    expect(posts.map((c) => c.url).sort()).toEqual([PRINT_URL, WEB_URL].sort())
    for (const p of posts) {
      expect(p.headers.Accept).toBe("application/json")
      expect(p.headers["X-Requested-With"]).toBe("XMLHttpRequest")
      expect(p.headers.Referer).toBe(DOWNLOAD_CENTER)
      expect(p.headers.Cookie).toBe("XSRF-TOKEN=xsrf123; aryeo_session=sess456")
    }
    const cdn = calls.filter((c) => /cdn\.aryeo\.com/.test(c.url))
    expect(cdn).toHaveLength(72)
    expect(cdn.every((c) => !c.headers.Cookie)).toBe(true)
    expect(r.steps.join(" → ")).toMatch(/open 200 → parse 1 group \(unassigned\) · 36 images → MLS list 36 → Print list 36 → download 72\/72/)
  })
  it("a 35-image Print set → ok:false with the '35 of 36' error, MLS still counted", async () => {
    const { fetchImpl } = fakeF8({ print: synth(PRINT, 35) })
    const r = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t2", fetchImpl })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe("Print set: 35 of 36 images downloaded")
    expect(r.needs).toBeNull()
  })
  it("an image that 404s on every try → ok:false naming the file; retries are per image", async () => {
    const { fetchImpl, calls } = fakeF8({ failImage: "01a13f27-0007-70c7-afe3-f20f1c3a52fa" })
    const r = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t3", fetchImpl })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/^MLS set: 35 of 36 images downloaded \(7-007_F8_5764 Halleck Dr\.JPG: HTTP 404\)/)
    expect(calls.filter((c) => c.url.includes("01a13f27-0007-70c7-afe3-f20f1c3a52fa"))).toHaveLength(6) // 3 tries × 2 sets
  })
  it("a 403 page → needs expired; a login page → needs login; a bare page → plain error", async () => {
    const needsOf = (r: Awaited<ReturnType<typeof fetchF8>>) => (r.ok ? "ok" : r.needs)
    const forb = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t4", fetchImpl: fakeF8({ pageStatus: 403 }).fetchImpl })
    expect(needsOf(forb)).toBe("expired")
    const login = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t5", fetchImpl: fakeF8({ pageHtml: `<form action="https://f8.f8re.com/login" method="POST"><input type="password" name="password"></form>` }).fetchImpl })
    expect(needsOf(login)).toBe("login")
    const gone = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t6", fetchImpl: fakeF8({ pageHtml: "<html><body>This download link has expired.</body></html>" }).fetchImpl })
    expect(needsOf(gone)).toBe("expired")
    const bare = await fetchF8({ url: DOWNLOAD_CENTER, jobId: "t7", fetchImpl: fakeF8({ pageHtml: "<html><body>hi</body></html>" }).fetchImpl })
    expect(needsOf(bare)).toBeNull()
  })
  it("fetchDocuments routes f8 to the fetcher (no ZIP expansion, no screenshots) and refuses unknown links", async () => {
    const r = await fetchDocuments({ url: DOWNLOAD_CENTER, jobId: "t8", fetchImpl: fakeF8().fetchImpl })
    expect(r.ok).toBe(true)
    expect(r.screenshots).toEqual([])
    expect("sets" in r && r.sets.length).toBe(2)
    expect("files" in r).toBe(false)
    const no = await fetchDocuments({ url: "https://f8.f8re.com/portal", jobId: "t9" })
    expect(no.ok).toBe(false)
  })
})

describe("photoDedupeVerdict — the three layers, in order", () => {
  const folderFiles = [
    { name: "1-001_F8_5764 Halleck Dr.JPG", size: 650_000, id: "drive-1", webViewLink: "https://drive.google.com/file/d/drive-1" },
    { name: "2-002_F8_5764 Halleck Dr.JPG", size: 640_000, id: "drive-2" },
  ]
  const known = { knownShas: new Set(["sha-known"]), folderFiles, knownImageIds: new Set(["f8:img-known:MLS"]) }
  it("new", () => {
    expect(photoDedupeVerdict({ sha: "sha-x", filename: "9-009_F8_5764 Halleck Dr.JPG", size: 1, imageId: "f8:img-9:MLS" }, known)).toEqual({ verdict: "new", reason: null, suffix: false, existing: null })
  })
  it("sha duplicate wins over everything", () => {
    expect(photoDedupeVerdict({ sha: "sha-known", filename: "1-001_F8_5764 Halleck Dr.JPG", size: 650_000, imageId: "f8:img-known:MLS" }, known).reason).toBe("sha")
  })
  it("same filename + same size in the folder → duplicate carrying the existing Drive file", () => {
    const v = photoDedupeVerdict({ sha: "sha-new", filename: "1-001_f8_5764 halleck dr.jpg", size: "650000" as unknown as number, imageId: "f8:img-1:MLS" }, known)
    expect(v.verdict).toBe("duplicate")
    expect(v.reason).toBe("name_size")
    expect(v.existing?.id).toBe("drive-1")
  })
  it("same imageId already filed for the property → duplicate (re-edited?)", () => {
    expect(photoDedupeVerdict({ sha: "sha-new", filename: "7-007_F8_5764 Halleck Dr.JPG", size: 5, imageId: "f8:img-known:MLS" }, known).reason).toBe("image_id")
    // The Print copy of the same image is a different key — not a duplicate of the MLS copy.
    expect(photoDedupeVerdict({ sha: "sha-new", filename: "7-007_F8_5764 Halleck Dr.JPG", size: 5, imageId: "f8:img-known:Print" }, known).verdict).toBe("new")
  })
  it("same filename but a different size → new with a suffix (mentioned, never dropped)", () => {
    const v = photoDedupeVerdict({ sha: "sha-new", filename: "2-002_F8_5764 Halleck Dr.JPG", size: 999, imageId: "f8:img-2:MLS" }, known)
    expect(v).toEqual({ verdict: "new", reason: null, suffix: true, existing: null })
    expect(suffixedFilename("2-002_F8_5764 Halleck Dr.JPG", folderFiles.map((f) => f.name))).toBe("2-002_F8_5764 Halleck Dr (2).JPG")
    expect(suffixedFilename("a.JPG", ["a.JPG", "a (2).JPG"])).toBe("a (3).JPG")
    expect(suffixedFilename("noext", [])).toBe("noext (2)")
  })
  it("accepts arrays as well as Sets, and the status set matches recordAttachment's", () => {
    expect(photoDedupeVerdict({ sha: "s", filename: "f", size: 1, imageId: "i" }, { knownShas: ["s"], folderFiles: [], knownImageIds: [] }).reason).toBe("sha")
    expect(DUP_STATUSES).toEqual(["filed", "pending", "approved", "waiting", "interview", "changed", "change_requested"])
  })
})

describe("subject → property label fallback, reply → folder, email link", () => {
  it("strips the prefix and the city/state/zip", () => {
    expect(propertyLabelFromSubject("f8 Media Delivery: 5764 Halleck Dr, San Jose, CA 95123")).toBe("5764 Halleck Dr")
    expect(propertyLabelFromSubject("f8 Media Delivery: 2116 Quito Rd, Saratoga, CA 95070")).toBe("2116 Quito Rd")
    expect(propertyLabelFromSubject("Fwd: f8 Media Delivery: 2116 Quito Rd, Saratoga, CA 95070")).toBe("2116 Quito Rd")
    expect(propertyLabelFromSubject("Your photos: 93 Ridgeview Ave San Jose CA 95127")).toBe("93 Ridgeview Ave")
    expect(propertyLabelFromSubject("fetch f8.f8re.com")).toBe("fetch f8.f8re.com") // a typed link: no useful label, the folder lookup fails and the ❓ card asks
    expect(propertyLabelFromSubject("")).toBeNull()
    expect(propertyLabelFromSubject(null)).toBeNull()
  })
  it("propertyFolderFromReply", () => {
    expect(propertyFolderFromReply("5764 Halleck Dr")).toBe("Properties/5764 Halleck Dr")
    expect(propertyFolderFromReply("Properties/5764 Halleck Dr/")).toBe("Properties/5764 Halleck Dr")
    expect(propertyFolderFromReply("“Halleck”")).toBe("Properties/Halleck")
    expect(propertyFolderFromReply("Business Operations/Properties/2025/674 Kirkland Dr")).toBe("Properties/2025/674 Kirkland Dr")
    expect(propertyFolderFromReply("skip")).toBeNull()
    expect(propertyFolderFromReply("")).toBeNull()
  })
  it("gmailLink", () => {
    expect(gmailLink("1a1404b2c9ead5b0", "ryan@lrghomes.com")).toBe("https://mail.google.com/mail/?authuser=ryan%40lrghomes.com#all/1a1404b2c9ead5b0")
  })
})
