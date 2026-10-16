"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Script from "next/script"
import { formatMoney, parseMoney } from "@/lib/offerMoney"

// Offer bot Mini App (briefs/OFFER_BOT.md): the form Ryan taps into from
// the review card's 📝 button (or from `/offer` with no terms). Reads
// Telegram's initData, loads the pending draft from /api/offer, and sends
// save / generate / cancel back. No dashboard layout, no session cookie —
// the API checks the initData signature + Ryan's user id.

type FormFields = {
  seller_name: string
  property_address: string
  address_needs_confirm: boolean
  purchase_price: string
  earnest_money: string
  closing_days: string
  agreement_date: string
  seller_signer_name: string
  seller_tel: string
  seller_email: string
  special_stipulations: string
}

type DraftPayload = { status: string; missing: string[]; unclear: string[]; source_text: string; fields: FormFields }

type TelegramWebApp = {
  initData: string
  ready: () => void
  expand: () => void
  close: () => void
  colorScheme?: string
  setHeaderColor?: (c: string) => void
  setBackgroundColor?: (c: string) => void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

type Phase = "loading" | "no-telegram" | "form" | "busy" | "done" | "fatal"

const EMPTY: FormFields = {
  seller_name: "",
  property_address: "",
  address_needs_confirm: false,
  purchase_price: "",
  earnest_money: "",
  closing_days: "45",
  agreement_date: "",
  seller_signer_name: "",
  seller_tel: "",
  seller_email: "",
  special_stipulations: "",
}

const INPUT =
  "w-full min-h-12 bg-zinc-900 border border-zinc-700 rounded-lg px-3.5 py-3 text-base text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-400 transition-colors"

export default function OfferFormPage() {
  const [phase, setPhase] = useState<Phase>("loading")
  const [fields, setFields] = useState<FormFields>(EMPTY)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moneyHint, setMoneyHint] = useState<{ purchase_price?: string; earnest_money?: string }>({})
  const [result, setResult] = useState<{ driveUrl: string | null; drivePath: string; filename: string } | null>(null)
  const webApp = useRef<TelegramWebApp | null>(null)
  const booted = useRef(false)

  const boot = useCallback(async () => {
    if (booted.current) return
    const wa = window.Telegram?.WebApp
    if (!wa) return
    booted.current = true
    webApp.current = wa
    try {
      wa.ready()
      wa.expand()
      wa.setHeaderColor?.("#09090b")
      wa.setBackgroundColor?.("#09090b")
    } catch {
      /* older clients */
    }
    if (!wa.initData) {
      setPhase("no-telegram")
      return
    }
    try {
      const res = await fetch(`/api/offer?initData=${encodeURIComponent(wa.initData)}`, { cache: "no-store" })
      const json = (await res.json()) as { ok: boolean; error?: string; draft?: DraftPayload }
      if (!res.ok || !json.ok || !json.draft) {
        setError(json.error ?? `HTTP ${res.status}`)
        setPhase("fatal")
        return
      }
      setFields({ ...EMPTY, ...json.draft.fields })
      if (json.draft.unclear.length) setNotice(json.draft.unclear.join(" · "))
      setPhase("form")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase("fatal")
    }
  }, [])

  // The script may already be cached and executed before onLoad fires.
  useEffect(() => {
    void boot()
    const t = window.setTimeout(() => {
      if (!booted.current) setPhase("no-telegram")
    }, 4000)
    return () => window.clearTimeout(t)
  }, [boot])

  const set = (k: keyof FormFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value
    setFields((f) => ({ ...f, [k]: v }))
  }

  const blurMoney = (k: "purchase_price" | "earnest_money") => () => {
    const raw = fields[k].trim()
    if (!raw) {
      setMoneyHint((h) => ({ ...h, [k]: undefined }))
      return
    }
    const n = parseMoney(raw)
    if (n === null) {
      setMoneyHint((h) => ({ ...h, [k]: `Couldn't read "${raw}" — try 10k, $10,000 or 1.2M` }))
      return
    }
    setMoneyHint((h) => ({ ...h, [k]: undefined }))
    setFields((f) => ({ ...f, [k]: formatMoney(n) }))
  }

  const post = async (action: "save" | "generate" | "cancel") => {
    const wa = webApp.current
    if (!wa) return
    setError(null)
    setPhase("busy")
    try {
      const res = await fetch("/api/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: wa.initData, action, fields }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string; driveUrl?: string | null; drivePath?: string; filename?: string }
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
        setPhase("form")
        return
      }
      if (action === "generate") {
        setResult({ driveUrl: json.driveUrl ?? null, drivePath: json.drivePath ?? "", filename: json.filename ?? "" })
        setPhase("done")
        return
      }
      wa.close()
      setPhase("form")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase("form")
    }
  }

  const label = (text: string, required = false) => (
    <label className="block text-xs uppercase tracking-wide text-zinc-400 mb-1.5">
      {text}
      {required ? <span className="text-amber-400"> *</span> : null}
    </label>
  )

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-5 pb-28">
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" onLoad={() => void boot()} />
      <div className="max-w-md mx-auto">
        <div className="flex items-center gap-2.5 mb-5">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <h1 className="text-base font-semibold tracking-tight">Purchase Agreement</h1>
        </div>

        {phase === "loading" && <p className="text-sm text-zinc-400">Loading your draft…</p>}

        {phase === "no-telegram" && (
          <p className="text-sm text-zinc-400">Open this form from the Marketing bot in Telegram (tap 📝 Open form on an offer card, or send /offer).</p>
        )}

        {phase === "fatal" && <p className="text-sm text-red-400">⚠️ {error}</p>}

        {phase === "done" && result && (
          <div className="space-y-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-2">
              <p className="text-sm">📄 <span className="font-medium">{result.filename}</span></p>
              <p className="text-sm text-zinc-300">Sent to your Telegram chat.</p>
              {result.driveUrl ? (
                <a href={result.driveUrl} target="_blank" rel="noreferrer" className="block text-sm text-sky-400 underline break-all">
                  📁 Open in Drive
                </a>
              ) : (
                <p className="text-sm text-zinc-400">📁 Saved to Drive</p>
              )}
              {result.drivePath ? <p className="text-xs text-zinc-500 break-all">{result.drivePath}</p> : null}
            </div>
            <button type="button" onClick={() => webApp.current?.close()} className="w-full min-h-12 rounded-lg bg-zinc-100 text-zinc-900 font-medium text-base">
              Close
            </button>
          </div>
        )}

        {(phase === "form" || phase === "busy") && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void post("generate")
            }}
            className="space-y-4"
          >
            {notice ? <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-900 rounded-lg px-3 py-2">🤔 {notice}</p> : null}
            {error ? <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">⚠️ {error}</p> : null}

            <div>
              {label("Seller name", true)}
              <input className={INPUT} value={fields.seller_name} onChange={set("seller_name")} autoComplete="off" placeholder="John and Mary Smith" />
            </div>
            <div>
              {label("Property address", true)}
              <input className={INPUT} value={fields.property_address} onChange={set("property_address")} autoComplete="off" placeholder="1234 Main St, San Jose, CA 95125" />
              {fields.address_needs_confirm ? (
                <label className="mt-2 flex items-center gap-2 text-xs text-amber-300">
                  <input type="checkbox" checked={fields.address_needs_confirm} onChange={set("address_needs_confirm")} className="w-5 h-5 accent-amber-400" />
                  ⚠️ Completed from a partial address — untick once confirmed
                </label>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                {label("Purchase price", true)}
                <input className={INPUT} inputMode="decimal" value={fields.purchase_price} onChange={set("purchase_price")} onBlur={blurMoney("purchase_price")} placeholder="1.2M" />
                {moneyHint.purchase_price ? <p className="text-xs text-red-400 mt-1">{moneyHint.purchase_price}</p> : null}
              </div>
              <div>
                {label("Earnest money", true)}
                <input className={INPUT} inputMode="decimal" value={fields.earnest_money} onChange={set("earnest_money")} onBlur={blurMoney("earnest_money")} placeholder="10k" />
                {moneyHint.earnest_money ? <p className="text-xs text-red-400 mt-1">{moneyHint.earnest_money}</p> : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                {label("Closing days")}
                <input className={INPUT} inputMode="numeric" value={fields.closing_days} onChange={set("closing_days")} placeholder="45" />
              </div>
              <div>
                {label("Agreement date")}
                <input className={INPUT} type="date" value={fields.agreement_date} onChange={set("agreement_date")} />
              </div>
            </div>
            <div>
              {label("Seller signer name")}
              <input className={INPUT} value={fields.seller_signer_name} onChange={set("seller_signer_name")} autoComplete="off" placeholder="same as seller" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                {label("Seller phone")}
                <input className={INPUT} type="tel" inputMode="tel" value={fields.seller_tel} onChange={set("seller_tel")} placeholder="(408) 555-1234" />
              </div>
              <div>
                {label("Seller email")}
                <input className={INPUT} type="email" inputMode="email" value={fields.seller_email} onChange={set("seller_email")} placeholder="optional" />
              </div>
            </div>
            <div>
              {label("Special stipulations (one per line)")}
              <textarea className={`${INPUT} min-h-28`} value={fields.special_stipulations} onChange={set("special_stipulations")} placeholder="Seller may leave the furniture." />
            </div>

            <div className="fixed inset-x-0 bottom-0 bg-zinc-950/95 backdrop-blur border-t border-zinc-800 px-4 py-3">
              <div className="max-w-md mx-auto grid grid-cols-3 gap-2">
                <button type="submit" disabled={phase === "busy"} className="col-span-3 min-h-12 rounded-lg bg-zinc-100 text-zinc-900 font-semibold text-base disabled:opacity-50">
                  {phase === "busy" ? "Working…" : "Generate"}
                </button>
                <button type="button" disabled={phase === "busy"} onClick={() => void post("save")} className="col-span-2 min-h-11 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm disabled:opacity-50">
                  Save &amp; back to chat
                </button>
                <button type="button" disabled={phase === "busy"} onClick={() => void post("cancel")} className="min-h-11 rounded-lg bg-zinc-900 border border-red-900 text-red-400 text-sm disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </main>
  )
}
