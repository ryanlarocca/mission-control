import { ChatWidget } from "@/components/widgets/ChatWidget"

export default function ChatPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Agent Chat</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Unified thread with Thadius and Cody</p>
      </div>
      <ChatWidget />
    </div>
  )
}
