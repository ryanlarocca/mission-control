import { DocumentsWidget } from "@/components/widgets/DocumentsWidget"

export default function DocumentsPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Documents</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Workspace files · Skills · Memory · Scripts</p>
      </div>
      <DocumentsWidget />
    </div>
  )
}
