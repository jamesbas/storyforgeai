import { AppShell } from "@/components/shell/app-shell";
import { GenerationConsole } from "@/components/generation-console/generation-console";

export default async function GenerationConsolePage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <GenerationConsole projectId={params.projectId} />
    </AppShell>
  );
}
