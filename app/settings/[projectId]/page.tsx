import { AppShell } from "@/components/shell/app-shell";
import { ProjectSettings } from "@/components/settings/project-settings";

export default function SettingsPage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <ProjectSettings projectId={params.projectId} />
    </AppShell>
  );
}
