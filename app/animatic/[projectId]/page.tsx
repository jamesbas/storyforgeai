import { AppShell } from "@/components/shell/app-shell";
import { AnimaticReview } from "@/components/agentic-canvas/animatic-review";

export default async function AnimaticPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <AnimaticReview projectId={params.projectId} />
    </AppShell>
  );
}
