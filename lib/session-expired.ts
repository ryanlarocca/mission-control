// A lapsed session used to break the polling surfaces silently.
//
// Middleware answered an unauthenticated request with a redirect to /login.
// `fetch` follows redirects by default, and GET /login returns 200 HTML — so
// `res.ok` was TRUE, `res.json()` then threw on the HTML, and the catch ran
// WITHOUT ever calling setLeads/setData. The tab froze on its last good
// snapshot and silently retried every 30s. Ryan's texts were in the database
// and returned by the API the whole time; his browser was showing a stale
// copy (2026-09-03).
//
// Middleware now returns a clean 401 on /api/*, so callers can detect this.
// Freezing is still wrong, though: send the user to log in rather than
// leaving them staring at stale data.

/**
 * Handle a 401 from an API poll. Returns true when the response was a lapsed
 * session and a redirect has been scheduled — the caller should return
 * immediately and NOT treat it as an ordinary error.
 */
export function handleSessionExpired(res: Response): boolean {
  if (res.status !== 401) return false
  if (typeof window === "undefined") return true
  const from = window.location.pathname + window.location.search
  window.location.href = `/login?from=${encodeURIComponent(from)}`
  return true
}
