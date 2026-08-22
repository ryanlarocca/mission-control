import { DealFlowTab } from "@/components/widgets/DealFlowTab"
import data from "@/data/deal-flow.json"
import type { DealFlowData } from "@/lib/dealFlow"

// Deal Flow — what happened to every property pitched to Ryan (2024–26),
// rolled up by channel / sender / buyer, with per-property comments.
// Data snapshot: data/deal-flow.json (see lib/dealFlow.ts for the refresh path).
export default function DealFlowPage() {
  return <DealFlowTab data={data as unknown as DealFlowData} />
}
