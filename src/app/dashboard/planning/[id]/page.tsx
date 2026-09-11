import { DashboardPage } from "@/components/dashboard/DashboardPage";
import PlanningProposalReview from "@/components/PlanningProposalReview";

export default async function PlanningProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DashboardPage eyebrow="Operator decision" title="Review planning change" description="Approval binds the current proposal and its exact revision authority."><PlanningProposalReview id={id} /></DashboardPage>;
}
