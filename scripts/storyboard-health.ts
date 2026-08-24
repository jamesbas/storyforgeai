import { getProjectRecord } from "@/lib/services/project-service";
import { latestExecution } from "@/lib/schemas/provenance";

/**
 * A storyboard's health in one screen: who wrote the cards, who wrote each
 * prompt pass, and which gate codes the repair could only flag.
 *
 * `anatomy_unnamed`, `wardrobe_contradicts_act` and `framing_too_tight` have
 * deterministic repairs driven off the card. `contact_unstated` and
 * `position_unstated` do not — a template can only restate the action — so
 * those scenes earn a retry and a flag and nothing more. They are the frames
 * worth reading before committing a batch to the GPU.
 */
const FLAG_ONLY = ["contact_unstated", "position_unstated"];

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error("Usage: tsx scripts/storyboard-health.ts <projectId>");

  const record = await getProjectRecord(projectId);
  const scenes = record.storyboard?.scenes ?? [];
  console.log(`${record.project.title} — ${scenes.length} scenes\n`);

  const storyboard = latestExecution(record.executions, "storyboard");
  console.log("SCENE CARDS");
  console.log(`  source   : ${storyboard?.source} (${storyboard?.status})`);
  console.log(`  reason   : ${storyboard?.fallbackReason ?? "—"} ${storyboard?.detail ?? ""}`);
  console.log(`  attempted: ${JSON.stringify(storyboard?.attempted ?? {})}`);
  console.log(`  fallbacks: ${JSON.stringify(record.storyboard?.fallbacks ?? [])}`);
  // "Scene N" titles are the tell-tale of the deterministic builder.
  const mechanical = scenes.filter((s) => /^Scene \d+$/.test(s.title.trim()));
  console.log(`  builder-shaped titles: ${mechanical.length} of ${scenes.length}\n`);

  for (const pass of ["image_prompt", "video_prompt"] as const) {
    const codes = new Map<string, number>();
    let clean = 0;
    for (const scene of scenes) {
      const run = latestExecution(record.executions, `${scene.id}.${pass}`);
      if (run?.source === "llm") {
        clean += 1;
        continue;
      }
      const key = `${run?.source ?? "none"} / ${run?.fallbackReason ?? "—"} / ${run?.detail ?? ""}`;
      codes.set(key, (codes.get(key) ?? 0) + 1);
    }
    console.log(`${pass.toUpperCase().replace("_", " ")} — ${clean} of ${scenes.length} clean`);
    for (const [key, count] of [...codes].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)} x ${key}`);
    }
    console.log("");
  }

  console.log("SCENES THE GATE COULD ONLY FLAG");
  let flagged = 0;
  for (const scene of scenes) {
    const run = latestExecution(record.executions, `${scene.id}.image_prompt`);
    const all = (run?.detail ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    const unfixed = all.filter((c) => FLAG_ONLY.includes(c));
    if (unfixed.length === 0) continue;
    flagged += 1;
    console.log(`  Scene ${scene.sceneNumber} — ${scene.title}: ${unfixed.join(", ")}`);
  }
  console.log(`  ${flagged} of ${scenes.length} scenes.`);
}

void main().catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e));
