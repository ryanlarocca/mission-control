import { Sidebar, TabBar } from "@/components/Sidebar"

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-zinc-950">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Phone: bottom padding clears the fixed tab bar + the home indicator. */}
        <main className="flex-1 overflow-auto px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:p-6">
          {children}
        </main>
      </div>
      <TabBar />
    </div>
  )
}
