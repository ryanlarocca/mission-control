import { NextResponse } from "next/server"
import { mockVideoQueue, mockSocialMetrics, mockBackendActivity } from "@/lib/mockData"

export async function GET() {
  // TODO: wire up Supabase queries for real data
  return NextResponse.json({
    queue: mockVideoQueue,
    metrics: mockSocialMetrics,
    backend: mockBackendActivity,
  })
}
