// Approximate location from an IP (ip-api.com, free, no key, ~45 req/min —
// plenty for a one-person signing tool). Fails soft: null on any problem.
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i

export async function geoLookup(ip) {
  if (!ip || PRIVATE.test(ip)) return null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 3500)
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,zip,isp,lat,lon`, { signal: ctl.signal })
    clearTimeout(t)
    const j = await res.json()
    if (j.status !== "success") return null
    return { city: j.city, region: j.regionName, country: j.country, zip: j.zip, isp: j.isp, lat: j.lat, lon: j.lon }
  } catch {
    return null
  }
}

export function geoLabel(geo) {
  if (!geo) return "unknown"
  const g = typeof geo === "string" ? JSON.parse(geo) : geo
  return [g.city, g.region, g.country].filter(Boolean).join(", ") || "unknown"
}

/** Real client IP: Cloudflare's header first (the tunnel sets it), then proxies, then the socket. */
export function clientIp(headers, socketAddr) {
  const cf = headers.get("cf-connecting-ip")
  if (cf) return cf.trim()
  const xff = headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  const xr = headers.get("x-real-ip")
  if (xr) return xr.trim()
  return socketAddr || null
}

/** Short device/browser label from a User-Agent, for the certificate. */
export function deviceLabel(ua) {
  if (!ua) return "unknown device"
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device"
  const br = /CriOS|Chrome\//.test(ua) && !/Edg/.test(ua) ? "Chrome" : /Edg/.test(ua) ? "Edge" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "browser"
  return `${os} · ${br}`
}
