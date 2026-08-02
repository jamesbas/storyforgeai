import { AppShell } from "@/components/shell/app-shell";
import { AssemblyView } from "@/components/assembly/assembly-view";

export default async function AssemblyPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <AssemblyView projectId={params.projectId} />
    </AppShell>
  );
}
