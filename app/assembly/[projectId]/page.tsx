import { AppShell } from "@/components/shell/app-shell";
import { AssemblyView } from "@/components/assembly/assembly-view";

export default function AssemblyPage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <AssemblyView projectId={params.projectId} />
    </AppShell>
  );
}
