"use client"

import { useState, useEffect, useCallback } from "react"
import type { VideoQueueItem, SocialMetric, BackendActivity } from "@/types"

interface SocialData {
  queue: VideoQueueItem[]
  metrics: SocialMetric[]
  backend: BackendActivity | null
  lastUpdated: Date | null
  loading: boolean
  error: string | null
}

export function useSocial() {
  const [data, setData] = useState<SocialData>({
    queue: [],
    metrics: [],
    backend: null,
    lastUpdated: null,
    loading: true,
    error: null,
  })

  const fetch = useCallback(async () => {
    try {
      const res = await window.fetch("/api/social")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData({ ...json, lastUpdated: new Date(), loading: false, error: null })
    } catch (err) {
      setData(prev => ({ ...prev, loading: false, error: String(err) }))
    }
  }, [])

  useEffect(() => {
    fetch()
    const interval = setInterval(fetch, 30000)
    return () => clearInterval(interval)
  }, [fetch])

  return { ...data, refresh: fetch }
}
