# Mission Control — Cody Build Brief
**Date:** 2026-03-31
**Author:** Thadius
**Status:** Ready for Cody

---

## Context

Mission Control is a Next.js 14 dark-theme dashboard (Tailwind + shadcn/ui, zinc palette) that Ryan uses to manage his real estate business (LRG Homes), his fitness app (Physiq), and his AI agent stack (Thadius + Cody). It lives at:

```
/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/
```

This brief covers a **UI/design-only pass**. No new backend wiring. All existing mock data and API routes stay untouched. Goal: get the layout and UX locked in so backend work can follow cleanly.

**Mobile-first.** Ryan uses this on his phone. Everything must work at 375px.

---

## 1. REAL ESTATE PIPELINE

Most important tab. Full redesign of `RealEstateWidget.tsx` into a unified morning workflow manager with the following sub-tabs:

### Agent Emails
- List of queued draft emails (mock: 8–12 agents)
- Row fields: agent name, brokerage, email preview (truncated), status badge (Draft / Queued / Sent)
- Top: `[Send All Drafts]` primary button with count badge ("12 ready")
- Per row: `[Preview]` expander + `[Skip]` button
- Sent section below the fold

### COI Outreach
- Today's 10 COI contacts
- Row fields: contact name, tier badge (A=amber, B=blue, C=zinc), last contact date, relationship note
- Per row: three pill buttons `[A]` `[B]` `[C]` — tapping selects which draft to send and highlights row as approved
- Top: `[Send Approved]` button
- Mobile: pills min 44px touch target

### Redfin Fixer
Three sub-tabs: **Eligible / All Properties / Sent**

**Eligible:** Agents where follow-up window has elapsed
- Columns: address, agent name, last contact, days overdue (red badge)
- `[Send Message]` button per row
- Sort: most overdue first

**All Properties:** Full property list
- Per row: address, agent name, cadence progress bar ("18/30 days", green→yellow→red), next follow-up date

**Sent:** Recent outreach log
- Columns: date sent, agent name, address, message type

### COI List
Keep existing design, clean up spacing, make mobile-friendly.

### Leads
Three sub-tabs: **Hot / Warm / Cold** (red / amber / zinc)

Per lead row:
- Name, phone/email
- Lead type badge: **Direct Mail / Google Ads / Agent Referral**
- Date received, last contact
- Clicking a row expands detail view with notes field

---

## 2. CHAT

Production-ready threaded chat UI. **Do NOT wire any real API calls.** Add this at the top of the component:

```tsx
// TODO: Wire to OpenClaw API — Thadius session bridge
// Endpoint: TBD — see backend spec when ready
```

Layout:
- **Left sidebar** (collapsible on mobile): thread list with colored dot indicators
  - 🟡 LRG Homes (Thadius)
  - 🟡 Physiq (Thadius)
  - 🔵 Cody
  - ⚪ Group
- **Right:** message thread — bubbles with agent avatar initials (T=amber, C=blue, R=zinc for Ryan)
- **Bottom:** message input + send button. On submit: append "thinking..." skeleton bubble → resolve to mock reply after 1.5s
- Keep all existing mock history intact

---

## 3. PROJECTS TAB — NEW

Add a new nav item: **Projects** (icon: FolderKanban or Layers)

Three sub-tabs: **New / Under Construction / Complete**

**New:** Staging area for incoming project ideas
- Each card: project title, description, date added, priority badge (High / Medium / Low)
- `[Move to In Progress]` button per card

**Under Construction:** Active projects
- Each card: project name, description, current status/last activity note, workspace path (as a code chip), date started
- `[Mark Complete]` button per card

**Complete:** Shipped projects (archive)
- Same card design, muted styling
- Date completed, brief outcome summary

Seed with real projects:
- **Mission Control** (Under Construction) — "Main dashboard app. UI redesign pass in progress."
- **Redfin Fixer Automation** (Under Construction) — "Nightly cron scan + agent outreach pipeline."
- **Agent Email Campaign** (Under Construction) — "Daily email drafting + send approval workflow."
- **COI Outreach System** (Complete) — "A/B/C tier daily outreach via iMessage."
- **LRG Homes Website** (Complete) — "Marketing site deployed on Vercel."
- **Physiq API** (Under Construction) — "Supabase backend for Physiq fitness app."

Thadius manages card movement and status updates programmatically. Wire cards to a JSON file at `public/data/projects.json` so it can be updated without a redeploy.

---

## 4. SKILLS TAB

Redesign `SkillsWidget.tsx` as an expandable skill index.

Each skill = a card row:
- Skill name (bold)
- One-line description
- Status badge: Active / Inactive / Scheduled
- Trigger type icon: ⏰ Cron / 💬 Chat command / 🔔 Event / 🖐️ Manual

Clicking a row expands to show:
- Full description
- Trigger details ("Daily at 3:00 AM" or "Message contains 'run COI'")
- Last run timestamp
- Scripts/files (as code chips)

Seed with these skills:
| Skill | Trigger | Status |
|---|---|---|
| COI Outreach | Cron, daily 9 AM | Active |
| Redfin Fixer | Cron, nightly 3 AM | Active |
| Agent Email Campaign | Manual | Active |
| Lead Tracker | Event-triggered | Active |
| Calendar Skill | Manual (screenshot) | Active |
| COI Addition | Manual | Active |

---

## 5. MEMORY LOG — NEW TAB

Add nav item: **Memory** (icon: Brain or BookOpen)

Two sub-tabs: **Thadius / Cody**

**Thadius:** Memory log entries in card format
- Card fields: date header, summary (2–4 sentences), expandable raw notes section
- Amber accent
- Seed with 5–6 realistic entries (real-estate ops, project decisions, system config updates)

**Cody:** Same card design, blue accent
- Seed with coding entries: "Migrated db.from() to REST in Physiq", "Built Mission Control skeleton", "Fixed WebSocket freeze on iOS", etc.

---

## 6. PHYSIQ TAB

Repurpose as personal health tracker only. Remove social/business content (belongs in Social tab).

- **Top:** Macro summary cards (Calories, Protein, Carbs, Fat) with progress bars — keep existing data
- **Middle:** Food log — keep existing edit/delete/add UI, clean up spacing
- **Bottom:** Workout Log (new section, mock data) — date, exercise, sets×reps or duration, notes. Same edit/delete pattern as food log.

---

## 7. GOOGLE ADS TAB

Clean up `GoogleAdsWidget.tsx`:
- Keep three campaign cards
- Add Pause/Resume toggle per campaign (UI state only, no API call)
- Add "Today's Summary" header card: total spend, total conversions, total clicks across all active campaigns
- Mobile layout cleanup

---

## 8. DOCUMENTS TAB

Minimal pass only:
- Clean up layout
- Add "File Browser coming soon" callout card below existing content
- No functional changes

---

## 9. GLOBAL REQUIREMENTS

- All tabs mobile-responsive (test at 375px)
- Nav sidebar collapses to icon-only rail on mobile with hamburger toggle
- Consistent spacing throughout
- Do not break existing API routes or data structures
- Do not modify: Agents, Mac Mini, Terminal, Calendar, Redfin Search tabs

---

## Notify When Done

```bash
openclaw system event --text "Done: Mission Control UI redesign complete — all tabs updated, mobile-responsive, ready for Ryan review" --mode now
```

---

## File Structure Reference

```
/PROJECTS/mission-control/
  app/
    (dashboard)/
      pipeline/     ← Full redesign
      chat/         ← Full redesign
      projects/     ← NEW
      skills/       ← Redesign
      memory/       ← NEW
      physiq/       ← Redesign
      ads/          ← Cleanup
      documents/    ← Minor cleanup
  components/
    widgets/
      RealEstateWidget.tsx   ← Full redesign
      ChatWidget.tsx         ← Full redesign
      SkillsWidget.tsx       ← Redesign
      PhysiqWidget.tsx       ← Redesign
      GoogleAdsWidget.tsx    ← Cleanup
      DocumentsWidget.tsx    ← Minor
      ProjectsWidget.tsx     ← NEW
      MemoryWidget.tsx       ← NEW
  public/
    data/
      projects.json          ← NEW (seed data for Projects tab)
```
