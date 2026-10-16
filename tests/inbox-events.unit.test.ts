// Inbox agent — networking-event watcher (briefs/BRIEF_EVENT_WATCHER_2026-10-15.md).
// Pure pieces: prefilter, organizer family + dedupe, the verdict rules, calendar helpers, text.
import { describe, expect, it } from "vitest"
import { squeeze, unreadable } from "../scripts/inbox-agent/events-run.mjs"
import {
  briefLines, calendarMatches, calendarWindow, cardButtons, cardText, detailsHash, fmtTime, matchEvent, organizerFamily, prefilter, toRfc3339, verdictFor,
} from "../scripts/inbox-agent/events.mjs"

describe("prefilter (stage 0)", () => {
  it("passes organizer announcements and reminders", () => {
    expect(prefilter({ from: "Conventus Lending Marketing <noreply@campaign.eventbrite.com>", subject: "Join us at Conventus Connect: San Francisco Peninsula" }).candidate).toBe(true)
    expect(prefilter({ from: "Brenda Chen <brenda@cvlending.com>", subject: "You're Invited: Real Estate Investing Summer Soirée" }).candidate).toBe(true)
    expect(prefilter({ from: "Sid Bobba (Meetup) <San-Jose-Real-Estate-Networking-Club-announce@meetup.com>", subject: "SJRENC: 🚨 October Networking Event" }).candidate).toBe(true)
    expect(prefilter({ from: "Meetup <info@email.meetup.com>", subject: "📅 Just scheduled: Mega Meet Up: The Ultimate Business & Real Estate Monthly Mixer" }).candidate).toBe(true)
    // hint only in the snippet
    expect(prefilter({ from: "Someone <a@b.com>", subject: "This Thursday", snippet: "Join us for drinks and networking at 6pm" }).candidate).toBe(true)
  })
  it("hard-skips vendors, webinars, listing blasts and Meetup digests before the model", () => {
    expect(prefilter({ from: "Cloudflare <em@em1.cloudflare.com>", subject: "You're invited to Connect with 50% off." })).toEqual({ candidate: false, skip: "vendor" })
    expect(prefilter({ from: "Zapier <events@send.zapier.com>", subject: "Join us at ZapConnect 2026" }).skip).toBe("vendor")
    expect(prefilter({ from: "Leonard <leonard@ax1031.com>", subject: "1031 Exchange Updates, Info. and Webinars" }).skip).toBe("virtual")
    expect(prefilter({ from: "Marshall Ward <m@compass.com>", subject: "Broker Tour & Open House: 1324 Pine Street | RSVP" }).skip).toBe("listing")
    expect(prefilter({ from: "Meetup <info@meetup.com>", subject: "Veronica Vargas posted in San Jose Real Estate Networking Club" }).skip).toBe("digest")
    expect(prefilter({ from: "Eventbrite <marketing@plans.eventbrite.com>", subject: "Events worth stepping outside for." }).skip).toBe("platform marketing")
  })
  it("ignores mail with no event hint", () => {
    expect(prefilter({ from: "Chicago Title <x@ctt.com>", subject: "Seller revised net for Ridgeview Ave", snippet: "Attached please find" }).candidate).toBe(false)
  })
})

describe("organizerFamily — reminders from every channel collapse to one slug", () => {
  it("Conventus: lender domain, Eventbrite campaign, Eventbrite order receipt", () => {
    expect(organizerFamily({ fromEmail: "brenda@cvlending.com", fromName: "Brenda Chen" })).toBe("conventus")
    expect(organizerFamily({ fromEmail: "noreply@campaign.eventbrite.com", fromName: "Conventus Lending Marketing" })).toBe("conventus")
    expect(organizerFamily({ fromEmail: "noreply@order.eventbrite.com", fromName: "Eventbrite", organizer: "CV Lending / Conventus" })).toBe("conventus")
  })
  it("Meetup groups key on the group slug in the sender local-part", () => {
    expect(organizerFamily({ fromEmail: "San-Jose-Real-Estate-Networking-Club-announce@meetup.com", fromName: "Sid Bobba (Meetup)" })).toBe("sjrenc")
    expect(organizerFamily({ fromEmail: "NVST-Capital-Real-Estate-Meetup-announce@meetup.com", fromName: "Meetup" })).toBe("nvst")
    expect(organizerFamily({ fromEmail: "info@email.meetup.com", fromName: "NVST Capital - Real Estate Meetup [🌉NorCal]" })).toBe("nvst")
  })
  it("plain senders key on the domain, newsletters from platforms on the organizer", () => {
    expect(organizerFamily({ fromEmail: "rodw@anchorloans.com", fromName: "Rod Wilson" })).toBe("anchorloans")
    expect(organizerFamily({ fromEmail: "x@mail.mcsv.net", fromName: "AREAA Silicon Valley Chapter" })).toBe("areaa")
    expect(organizerFamily({ fromEmail: "hello@mailchimp.com", fromName: "The Azucena Group", organizer: "The Azucena Group" })).toBe("azucena")
  })
})

describe("matchEvent — dedupe", () => {
  const sep17 = { id: "a", event_date: "2026-09-17", organizer_family: "conventus", name: "Conventus Connect: San Francisco Peninsula", organizer: "Conventus Lending", venue: "Terún Pizza", city: "Palo Alto" }
  it("same date + same family → match, venue spelling irrelevant", () => {
    expect(matchEvent([sep17], { event_date: "2026-09-17", organizer_family: "conventus", name: "Real Estate Investing Summer Soirée", venue: "Terun Pizza", city: "Palo Alto, CA" })?.id).toBe("a")
  })
  it("same date + same city + shared name token → match even when the family differs", () => {
    expect(matchEvent([sep17], { event_date: "2026-09-17", organizer_family: "brenda", name: "Conventus Soirée", organizer: "Brenda Chen", venue: null, city: "Palo Alto" })?.id).toBe("a")
  })
  it("different date → no match; same date, unrelated event → no match", () => {
    expect(matchEvent([sep17], { event_date: "2027-01-29", organizer_family: "conventus", name: "Conventus Connect", city: "San Carlos" })).toBeNull()
    expect(matchEvent([sep17], { event_date: "2026-09-17", organizer_family: "sjrenc", name: "SJRENC Speaker Night", organizer: "SJRENC", venue: "Aloft", city: "Mountain View" })).toBeNull()
  })
  it("detailsHash changes on a venue move, not on a reworded name", () => {
    const h = detailsHash(sep17)
    expect(detailsHash({ ...sep17, name: "Conventus Connect SF Peninsula (reminder)" })).not.toBe(h) // name is part of the hash on purpose: brief says "updated" only when the row's stored name changes, and mergeRow never overwrites the name
    expect(detailsHash({ ...sep17, venue: "Drake's" })).not.toBe(h)
    expect(detailsHash({ ...sep17 })).toBe(h)
  })
})

describe("verdictFor — Ryan's rules, decided once per event", () => {
  const base = { is_event: true, name: "Conventus Connect: San Francisco Peninsula", date: "2026-09-17", start_time: "18:00", end_time: "21:00", venue: "Terún Pizza", city: "Palo Alto", format: "social", has_networking_component: true }
  it("evening mixer, local → include", () => {
    expect(verdictFor(base, "2026-08-17")).toEqual({ verdict: "include", reason: "evening social" })
  })
  it("SJRENC talk + networking at 6:30 PM → include", () => {
    expect(verdictFor({ ...base, name: "SJRENC October Meetup: Building 200+ Homes a Year", start_time: "18:30", venue: "Aloft Mountain View", city: "Mountain View", format: "talk_plus_networking" }, "2026-09-10").verdict).toBe("include")
  })
  it("daytime luncheon / tax seminar / general meeting → skip", () => {
    expect(verdictFor({ ...base, name: "AREAA SV General Meeting & Election", start_time: "12:00", city: "Sunnyvale", format: "meeting", has_networking_component: false }, "2026-09-14").verdict).toBe("skip")
    expect(verdictFor({ ...base, name: "Real Estate & Tax Strategy Seminar", start_time: "13:00", city: "San Jose", format: "seminar_or_class", has_networking_component: false }, "2026-08-19").verdict).toBe("skip")
  })
  it("daytime but explicitly social → borderline", () => {
    expect(verdictFor({ ...base, name: "Pickleball Tournament and Class", date: "2026-10-11", start_time: "10:00", city: "San Jose", format: "social", audience: "business" }, "2026-10-10")).toEqual({ verdict: "borderline", reason: "daytime, but a social" })
  })
  it("no start time → borderline; no location → borderline", () => {
    expect(verdictFor({ ...base, start_time: null, date: "2027-01-29", venue: "Drake's", city: "San Carlos" }, "2026-08-21").verdict).toBe("borderline")
    expect(verdictFor({ ...base, venue: null, city: null, address: null }, "2026-08-21").reason).toBe("location not stated")
  })
  it("evening, but reads as a seminar with no networking → borderline", () => {
    expect(verdictFor({ ...base, name: "Estate Planning Seminar", format: "seminar_or_class", has_networking_component: false }, "2026-08-17").verdict).toBe("borderline")
  })
  it("out of area → skip silently (Ryan: 'I don't really care about that')", () => {
    expect(verdictFor({ ...base, name: "NPLA Scottsdale", venue: "Fairmont Scottsdale Princess", city: "Scottsdale, AZ", date: "2026-10-25" }, "2026-10-01").verdict).toBe("skip")
    expect(verdictFor({ ...base, city: "Oakland", venue: "Lake Chalet" }, "2026-08-17").verdict).toBe("skip")
  })
  it("ticketed games / rec-league socials → skip; a general-public *mixer* still gets through", () => {
    expect(verdictFor({ ...base, name: "Miami Dolphins at San Francisco 49ers", venue: "Levi's Stadium", city: "Santa Clara", start_time: null, is_spectator_or_consumer: true, audience: "general" }, "2026-09-14").verdict).toBe("skip")
    expect(verdictFor({ ...base, name: "Volo Pass Happy Hour", date: "2026-10-15", venue: "Burbanks Bites & Billiards", city: "San Jose", start_time: null, audience: "general" }, "2026-10-01").reason).toBe("general-public social, not a business crowd")
    expect(verdictFor({ ...base, name: "Mega Meet Up: The Ultimate Business & Real Estate Monthly Mixer", date: "2026-10-13", city: "Cupertino", audience: "general" }, "2026-09-22").verdict).toBe("include")
  })
  it("daytime summit with no location → skip (time decides before the location check)", () => {
    expect(verdictFor({ ...base, name: "Raising & Investing Summit 2.0", start_time: "10:00", venue: null, city: null, format: "conference", has_networking_component: false }, "2026-09-01").verdict).toBe("skip")
  })
  it("virtual / listing / vendor / past / no date → skip", () => {
    expect(verdictFor({ ...base, is_virtual: true }, "2026-08-17").reason).toBe("virtual")
    expect(verdictFor({ ...base, is_listing_or_tour: true }, "2026-08-17").verdict).toBe("skip")
    expect(verdictFor({ ...base, is_vendor_event: true, audience: "business" }, "2026-08-17").verdict).toBe("skip")
    expect(verdictFor({ ...base, is_vendor_event: true, audience: "real_estate" }, "2026-08-17").verdict).toBe("include") // a lender's mixer is not a vendor event
    expect(verdictFor(base, "2026-09-22").reason).toBe("already past when the email arrived")
    expect(verdictFor({ ...base, date: null }, "2026-08-17").reason).toBe("no date")
    expect(verdictFor({ is_event: false }, "2026-08-17").verdict).toBe("skip")
  })
  it("judges 'past' against the arrival date, never the wall clock", () => {
    expect(verdictFor(base, "2026-09-17").verdict).toBe("include") // same-day "See you TONIGHT!"
  })
})

describe("calendar helpers", () => {
  it("RFC3339 in Pacific time, DST-aware", () => {
    expect(toRfc3339("2026-09-17", "18:00")).toBe("2026-09-17T18:00:00-07:00")
    expect(toRfc3339("2026-12-10", "18:30")).toBe("2026-12-10T18:30:00-08:00")
    expect(toRfc3339("2026-12-10", null)).toBeNull()
  })
  it("window: given end, else +2h, else 6–8 PM flagged as assumed", () => {
    expect(calendarWindow({ event_date: "2026-09-17", start_time: "18:00", end_time: "21:00" })).toEqual({ from: "2026-09-17T18:00:00-07:00", to: "2026-09-17T21:00:00-07:00", assumedTime: false })
    expect(calendarWindow({ event_date: "2026-09-17", start_time: "18:30" }).to).toBe("2026-09-17T20:30:00-07:00")
    expect(calendarWindow({ event_date: "2027-01-29" })).toEqual({ from: "2027-01-29T18:00:00-08:00", to: "2027-01-29T20:00:00-08:00", assumedTime: true })
  })
  it("already-on-calendar: SJRENC Oct 15 matches the hand-added entry", () => {
    const cal = [{ id: "n2v3", start: { dateTime: "2026-10-15T18:30:00-07:00" }, summary: "SJRENC Networking - Aloft Mountain View", location: "Aloft Mountain View" }]
    expect(calendarMatches({ event_date: "2026-10-15", name: "SJRENC October Meetup: Building 200+ New Homes", organizer: "SJRENC", venue: "Aloft Mountain View" }, cal)?.id).toBe("n2v3")
    expect(calendarMatches({ event_date: "2026-10-15", name: "Conventus Connect", organizer: "Conventus", venue: "Drake's" }, cal)).toBeNull()
    expect(calendarMatches({ event_date: "2026-10-16", name: "SJRENC", organizer: "SJRENC", venue: "Aloft" }, cal)).toBeNull()
  })
})

describe("squeeze — Meetup HTML padding", () => {
  it("replaces click-tracking URLs, keeps short real links, flags image-only mail", () => {
    const long = "https://email.reply.acquired-homes.com/c/" + "x".repeat(400)
    expect(squeeze(`[${long}]\nRSVP HERE [${long}]\nhttps://eventbrite.com/e/123`)).toBe("[link]\nRSVP HERE [link]\nhttps://eventbrite.com/e/123")
    expect(unreadable(squeeze(`[${long}]\nRSVP HERE [${long}]`))).toBe(true)
    expect(unreadable("Mega Meet Up: The Ultimate Business & Real Estate Monthly Mixer\nTuesday, October 13, 2026 5:30 PM - 7:30 PM\n10275 N De Anza Blvd\nRSVP now\nDetails: investors, lenders, agents")).toBe(false)
  })
  it("drops blank lines, zero-width joiners and runs of spaces", () => {
    expect(squeeze(" 96\n\n\n   \n\u200c \u200c \u200c\nMega Meet Up:   The Ultimate   Mixer\n\n\nTuesday, October 13, 2026 5:30 PM - 7:30 PM\n")).toBe("96\nMega Meet Up: The Ultimate Mixer\nTuesday, October 13, 2026 5:30 PM - 7:30 PM")
  })
})

describe("text", () => {
  const ev = { id: "11111111-1111-1111-1111-111111111111", name: "Conventus Connect: SF Peninsula", event_date: "2026-09-17", start_time: "18:00", end_time: "21:00", venue: "Terún Pizza", address: "448 California Ave", city: "Palo Alto", organizer: "Conventus Lending", cost: "Free", rsvp_url: "https://eventbrite.com/x", source_link: "https://mail.google.com/mail/u/0/#all/abc", why: "Lenders, investors and agents on the Peninsula", verdict: "include", email_count: 7 }
  it("fmtTime", () => {
    expect(fmtTime("18:00")).toBe("6 PM")
    expect(fmtTime("18:30")).toBe("6:30 PM")
    expect(fmtTime(null)).toBeNull()
  })
  it("card has the essentials and escapes HTML", () => {
    const t = cardText({ ...ev, name: "A & B <mixer>" })
    expect(t).toContain("A &amp; B &lt;mixer&gt;")
    expect(t).toContain("Thu, Sep 17 · 6 PM–9 PM")
    expect(t).toContain("448 California Ave")
    expect(t).toContain('href="https://eventbrite.com/x"')
    expect(t).toContain("7 emails about this one")
    expect(cardText({ ...ev, verdict: "borderline", borderline_reason: "no start time listed", start_time: null, end_time: null })).toContain("⚠️")
  })
  it("buttons carry the ix:e* callbacks", () => {
    expect(cardButtons(ev)[0].map((b) => b.data)).toEqual([`ix:ed:${ev.id}`, `ix:ec:${ev.id}`, `ix:en:${ev.id}`])
  })
  it("brief lines: new, already-on-calendar, updated; empty when nothing", () => {
    expect(briefLines({})).toEqual([])
    const lines = briefLines({ fresh: [ev], onCalendar: [{ ...ev, name: "SJRENC" }], changed: [{ ...ev, name: "Moved one", venue: "Drake's" }] })
    expect(lines[0]).toContain("Networking events (1 new)")
    expect(lines.some((l) => l.includes("already on your calendar: SJRENC"))).toBe(true)
    expect(lines.some((l) => l.includes("updated: Moved one"))).toBe(true)
  })
})
