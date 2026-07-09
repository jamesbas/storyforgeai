import { AppShell } from "@/components/shell/app-shell";
import { VariantReview } from "@/components/agentic-canvas/variant-review";

export default function VariantReviewPage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <VariantReview projectId={params.projectId} />
    </AppShell>
  );
}
