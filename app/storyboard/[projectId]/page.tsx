import { AppShell } from "@/components/shell/app-shell";
import { StoryboardView } from "@/components/storyboard/storyboard-view";

export default async function StoryboardPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return (
    <AppShell>
      <StoryboardView projectId={params.projectId} />
    </AppShell>
  );
}
