import { AppShell } from "@/components/shell/app-shell";
import { AnimaticReview } from "@/components/agentic-canvas/animatic-review";

export default function AnimaticPage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <AnimaticReview projectId={params.projectId} />
    </AppShell>
  );
}
