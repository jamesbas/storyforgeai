import { AppShell } from "@/components/shell/app-shell";
import { AgenticCanvas } from "@/components/agentic-canvas/agentic-canvas";

export default function AgenticCanvasPage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <AgenticCanvas projectId={params.projectId} />
    </AppShell>
  );
}
