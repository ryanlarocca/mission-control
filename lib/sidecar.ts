// Headers every server-side call to the Mac mini sidecar must carry.
// The sidecar only checks the secret on requests that arrive through its
// Cloudflare tunnel (i.e. from Vercel); scripts on the mini talk to it on
// localhost and are never gated. Enforcement is a sidecar-side flag
// (SIDECAR_SECRET_ENFORCE) so this header can ship ahead of the flip.
export function sidecarHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const secret = process.env.SIDECAR_SECRET
  return { "Content-Type": "application/json", ...(secret ? { "X-Sidecar-Secret": secret } : {}), ...extra }
}
