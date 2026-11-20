import { BoardView } from "@/components/board/BoardView"

// The Board (2026-11-20) — one card per open thread in Ryan's life and work,
// in four lanes: Your move · Waiting on someone · I'm handling · Done this
// week. Data: /api/board (table board_items, lib/boardItems.ts).
// Add-to-home-screen target: https://mission-control-three-chi.vercel.app/board
// (The retired 90-day goals board lives on in components/widgets/board/, unused.)
export default function BoardPage() {
  return <BoardView />
}
