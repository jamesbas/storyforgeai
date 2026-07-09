import { AppShell } from "@/components/shell/app-shell";
import { GenerationConsole } from "@/components/generation-console/generation-console";

export default function GenerationConsolePage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <GenerationConsole projectId={params.projectId} />
    </AppShell>
  );
}
