import { AppShell } from "@/components/shell/app-shell";
import { StoryboardView } from "@/components/storyboard/storyboard-view";

export default function StoryboardPage({ params }: { params: { projectId: string } }) {
  return (
    <AppShell>
      <StoryboardView projectId={params.projectId} />
    </AppShell>
  );
}
