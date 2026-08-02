import { AppShell } from "@/components/shell/app-shell";
import { VariantReview } from "@/components/agentic-canvas/variant-review";

export default async function VariantReviewPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <VariantReview projectId={params.projectId} />
    </AppShell>
  );
}
