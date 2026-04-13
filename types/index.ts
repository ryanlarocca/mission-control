// Real Estate Pipeline
export interface Listing {
  id: string
  address: string
  price: number
  score: number
  status: "new" | "contacted" | "showing" | "offer" | "closed" | "dead"
  lastContact?: string
  notes?: string
  url?: string
  daysOnMarket?: number
  beds?: number
  baths?: number
  sqft?: number
}

export interface OutreachContact {
  id: string
  name: string
  type: "COI" | "Redfin"
  status: "pending" | "sent" | "replied" | "meeting" | "dead"
  lastMessage?: string
  lastContact?: string
  phone?: string
}

// Physiq Social Engine
export interface VideoQueueItem {
  id: string
  title: string
  platform: "instagram" | "tiktok" | "youtube" | "facebook"
  status: "pending" | "approved" | "rejected" | "posted"
  submittedAt: string
  thumbnailUrl?: string
  duration?: number
  views?: number
}

export interface SocialMetric {
  platform: string
  followers: number
  followersChange: number
  engagement: number
  postsThisWeek: number
}

export interface BackendActivity {
  logins: number
  activeSessions: number
  featureUsage: Record<string, number>
  avgLatencyMs: number
  errors24h: number
}

// Chat
export interface ChatMessage {
  id: string
  from: "thadius" | "cody" | "ryan"
  text: string
  timestamp: string
}

// Terminal
export interface TerminalLine {
  id: string
  type: "command" | "output" | "error" | "success" | "dim"
  text: string
}

// Agents
export interface AgentStatus {
  id: string
  name: string
  role: string
  status: "online" | "working" | "idle" | "offline"
  currentTask?: string
  model: string
  tasksToday: number
  lastActive: string
  messagesExchanged: number
}

// Calendar & Events
export interface CalendarEvent {
  id: string
  title: string
  startTime: string
  endTime: string
  type: "showing" | "meeting" | "call" | "personal" | "other"
  location?: string
  description?: string
}
