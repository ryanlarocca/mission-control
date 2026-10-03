#!/usr/bin/env node
// One-off 2026-10-03: Ryan — Lindy Ngo / Prophet Homes "sends a lot of garbage" (on-market listings
// dressed as fixers). Seed the muted-senders list with the domain so nothing from there gets a card.
import { getSetting, loadEnvLocal, setSetting } from "../env.mjs"
loadEnvLocal()
const agent = await getSetting("agent")
const muted = new Set((agent.muted_senders || []).map((s) => String(s).toLowerCase()))
muted.add("prophethomes.com")
muted.add("email.prophethomes.com")
await setSetting("agent", { muted_senders: [...muted] })
console.log("muted_senders:", [...muted])
