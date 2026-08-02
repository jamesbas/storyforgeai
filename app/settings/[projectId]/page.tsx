import { AppShell } from "@/components/shell/app-shell";
import { ProjectSettings } from "@/components/settings/project-settings";

export default async function SettingsPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <ProjectSettings projectId={params.projectId} />
    </AppShell>
  );
}
