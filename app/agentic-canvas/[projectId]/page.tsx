import { AppShell } from "@/components/shell/app-shell";
import { AgenticCanvas } from "@/components/agentic-canvas/agentic-canvas";

export default async function AgenticCanvasPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <AgenticCanvas projectId={params.projectId} />
    </AppShell>
  );
}
