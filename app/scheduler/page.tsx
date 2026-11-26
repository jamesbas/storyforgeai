import { AppShell } from "@/components/shell/app-shell";
import { SchedulerView } from "@/components/scheduler/scheduler-view";

export const metadata = { title: "Scheduler · StoryForgeAI" };

export default function SchedulerPage() {
  return (
    <AppShell>
      <SchedulerView />
    </AppShell>
  );
}
