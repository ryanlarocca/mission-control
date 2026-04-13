import type { Listing, OutreachContact, VideoQueueItem, SocialMetric, BackendActivity, CalendarEvent, ChatMessage, TerminalLine, AgentStatus } from "@/types"

export const mockListings: Listing[] = [
  {
    id: "1",
    address: "1842 Maple Grove Ct, Austin TX 78745",
    price: 485000,
    score: 8.4,
    status: "showing",
    daysOnMarket: 3,
    beds: 4,
    baths: 3,
    sqft: 2340,
    lastContact: "2026-03-27",
    notes: "Pool, backs to greenbelt. Seller motivated.",
    url: "https://redfin.com"
  },
  {
    id: "2",
    address: "3301 Stonewall Dr, Austin TX 78731",
    price: 620000,
    score: 7.8,
    status: "contacted",
    daysOnMarket: 7,
    beds: 4,
    baths: 2,
    sqft: 2780,
    lastContact: "2026-03-26",
  },
  {
    id: "3",
    address: "908 Ridgemont Ave, Cedar Park TX 78613",
    price: 399000,
    score: 7.2,
    status: "new",
    daysOnMarket: 1,
    beds: 3,
    baths: 2,
    sqft: 1890,
  },
  {
    id: "4",
    address: "5610 Balcones Dr, Austin TX 78731",
    price: 755000,
    score: 9.1,
    status: "offer",
    daysOnMarket: 5,
    beds: 5,
    baths: 4,
    sqft: 3400,
    lastContact: "2026-03-28",
    notes: "Best deal of the month. Offer in review.",
  },
  {
    id: "5",
    address: "214 Westlake Hills Blvd, Austin TX 78746",
    price: 1100000,
    score: 7.5,
    status: "new",
    daysOnMarket: 2,
    beds: 5,
    baths: 4,
    sqft: 4100,
  },
]

export const mockContacts: OutreachContact[] = [
  { id: "1", name: "Sarah Chen", type: "COI", status: "replied", lastContact: "2026-03-27", phone: "512-555-0192" },
  { id: "2", name: "Marcus Webb", type: "COI", status: "sent", lastContact: "2026-03-26" },
  { id: "3", name: "Jennifer Park", type: "Redfin", status: "meeting", lastContact: "2026-03-28", phone: "512-555-0341" },
  { id: "4", name: "David Torres", type: "COI", status: "pending" },
  { id: "5", name: "Amanda Liu", type: "Redfin", status: "sent", lastContact: "2026-03-25" },
]

export const mockVideoQueue: VideoQueueItem[] = [
  {
    id: "1",
    title: "5 Tips for Fat Loss Over 40",
    platform: "instagram",
    status: "pending",
    submittedAt: "2026-03-28T09:00:00Z",
    duration: 62,
  },
  {
    id: "2",
    title: "Morning Mobility Routine",
    platform: "tiktok",
    status: "approved",
    submittedAt: "2026-03-27T14:30:00Z",
    duration: 45,
    views: 1240,
  },
  {
    id: "3",
    title: "Physiq March Challenge Recap",
    platform: "youtube",
    status: "pending",
    submittedAt: "2026-03-28T11:00:00Z",
    duration: 480,
  },
  {
    id: "4",
    title: "Client Transformation Story: Mike R.",
    platform: "instagram",
    status: "rejected",
    submittedAt: "2026-03-26T16:00:00Z",
    duration: 90,
  },
]

export const mockSocialMetrics: SocialMetric[] = [
  { platform: "Instagram", followers: 4820, followersChange: 38, engagement: 4.2, postsThisWeek: 5 },
  { platform: "TikTok", followers: 11300, followersChange: 210, engagement: 6.8, postsThisWeek: 7 },
  { platform: "YouTube", followers: 1940, followersChange: 12, engagement: 2.1, postsThisWeek: 1 },
]

export const mockBackendActivity: BackendActivity = {
  logins: 47,
  activeSessions: 12,
  featureUsage: {
    "Workout Builder": 28,
    "Progress Tracker": 19,
    "Meal Planner": 11,
    "Coach Chat": 34,
  },
  avgLatencyMs: 142,
  errors24h: 3,
}

export const mockCalendarEvents: CalendarEvent[] = [
  {
    id: "1",
    title: "Showing — 1842 Maple Grove Ct",
    startTime: "2026-03-28T10:00:00",
    endTime: "2026-03-28T10:45:00",
    type: "showing",
    location: "1842 Maple Grove Ct, Austin TX 78745",
  },
  {
    id: "2",
    title: "Call with Jennifer Park",
    startTime: "2026-03-28T13:00:00",
    endTime: "2026-03-28T13:30:00",
    type: "call",
  },
  {
    id: "3",
    title: "Physiq Team Standup",
    startTime: "2026-03-28T15:00:00",
    endTime: "2026-03-28T15:30:00",
    type: "meeting",
  },
  {
    id: "4",
    title: "Showing — 5610 Balcones Dr",
    startTime: "2026-03-29T09:30:00",
    endTime: "2026-03-29T10:15:00",
    type: "showing",
    location: "5610 Balcones Dr, Austin TX 78731",
  },
  {
    id: "5",
    title: "Listing Review — Westlake Hills",
    startTime: "2026-03-29T14:00:00",
    endTime: "2026-03-29T15:00:00",
    type: "meeting",
  },
]

export const mockChatMessages: ChatMessage[] = [
  { id: "1", from: "ryan", text: "Cody, take the physiq project and fix the freeze issue", timestamp: "10:14 AM" },
  { id: "2", from: "cody", text: "On it. Pulling the repo and reading index.html now. I'll report back when I have a diagnosis.", timestamp: "10:14 AM" },
  { id: "3", from: "thadius", text: "I've flagged the Supabase WebSocket issue in my notes — worth checking if the JS client is the culprit.", timestamp: "10:15 AM" },
  { id: "4", from: "cody", text: "Confirmed. All db.from() calls go through the WebSocket. iOS kills it on screen-off. Replacing with plain REST calls via sbFetch.", timestamp: "10:22 AM" },
  { id: "5", from: "ryan", text: "Nice. How long?", timestamp: "10:23 AM" },
  { id: "6", from: "cody", text: "Already writing it. Test suite passing — 9/9 ops confirmed working over REST. Deploying now.", timestamp: "10:31 AM" },
  { id: "7", from: "thadius", text: "SW bumped to v5. Users will get fresh code on next open.", timestamp: "10:33 AM" },
  { id: "8", from: "ryan", text: "freeze seems fixed finally", timestamp: "11:47 AM" },
  { id: "9", from: "cody", text: "WebSocket was the culprit the whole time. REST calls can't be killed by iOS sleeping — each request is independent.", timestamp: "11:48 AM" },
]

export const mockTerminalLines: TerminalLine[] = [
  { id: "1", type: "dim", text: "Cody — Claude Code  ·  physiq  ·  main" },
  { id: "2", type: "command", text: "git pull origin main" },
  { id: "3", type: "output", text: "Already up to date." },
  { id: "4", type: "command", text: "grep -n 'db\\.from\\|dbOp' index.html | wc -l" },
  { id: "5", type: "output", text: "24" },
  { id: "6", type: "command", text: "node test-sbfetch.mjs" },
  { id: "7", type: "output", text: "── sbFetch Test Suite ──────────────────────────────────" },
  { id: "8", type: "success", text: "  ✓ Signed in as ryan@lrghomes.com (user_id: 59933c83...)" },
  { id: "9", type: "success", text: "  ✓ Got 3 rows in 277ms" },
  { id: "10", type: "success", text: "  ✓ Inserted id=395 in 110ms" },
  { id: "11", type: "success", text: "  ✓ Updated calories to 99 in 102ms" },
  { id: "12", type: "success", text: "  ✓ Deleted in 82ms" },
  { id: "13", type: "success", text: "  ✓ Row confirmed deleted" },
  { id: "14", type: "success", text: "  ✓ Got 3 weight rows in 123ms" },
  { id: "15", type: "success", text: "  ✓ Got 7 presets in 121ms" },
  { id: "16", type: "output", text: "── All tests passed ✓ ─────────────────────────────────" },
  { id: "17", type: "command", text: "git add index.html sw.js && git commit -m 'Replace Supabase JS client with plain REST (sbFetch)'" },
  { id: "18", type: "output", text: "[main 799d98a] Replace Supabase JS client data calls with plain REST (sbFetch)" },
  { id: "19", type: "output", text: " 2 files changed, 81 insertions(+), 52 deletions(-)" },
  { id: "20", type: "command", text: "git push origin main" },
  { id: "21", type: "success", text: "To https://github.com/ryanlarocca/physiq.git" },
  { id: "22", type: "success", text: "   160aa8a..799d98a  main -> main" },
  { id: "23", type: "command", text: "curl -s https://ryanlarocca.github.io/physiq/ | grep -c 'sbFetch'" },
  { id: "24", type: "success", text: "26" },
  { id: "25", type: "dim", text: "─── deploy confirmed live ───" },
]

export const mockAgents: AgentStatus[] = [
  {
    id: "thadius",
    name: "Thadius",
    role: "Orchestration & Memory",
    status: "online",
    currentTask: "Monitoring outreach campaigns",
    model: "claude-sonnet-4.6",
    tasksToday: 14,
    lastActive: "2 min ago",
    messagesExchanged: 47,
  },
  {
    id: "cody",
    name: "Cody",
    role: "Engineering & Deployment",
    status: "idle",
    currentTask: undefined,
    model: "claude-sonnet-4.6",
    tasksToday: 6,
    lastActive: "11 min ago",
    messagesExchanged: 23,
  },
]
