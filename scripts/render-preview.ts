import { previewSceneRenders } from "@/lib/services/media-service";
import { listProjects } from "@/lib/services/project-service";

/**
 * Print exactly what a keyframe batch would send to Wan2GP, without sending it.
 *
 * The prompt on a scene card is the input to a chain of appenders, and the
 * exclusions are folded into it at render time against whichever model actually
 * resolves. Reading the card therefore does not tell you what the model was
 * asked for, which is the thing you need when a frame comes back wrong.
 *
 *   npm run render:preview -- <projectId> [sceneNumber]
 */
function rule(text: string) {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
}

async function main() {
  const [projectId, only] = process.argv.slice(2);
  if (!projectId) {
    const projects = await listProjects();
    console.log("Usage: npm run render:preview -- <projectId> [sceneNumber]\n");
    for (const project of projects) console.log(`  ${project.id}  ${project.title}`);
    return;
  }

  const wanted = only ? Number(only) : undefined;
  const frames = await previewSceneRenders(projectId);

  for (const frame of frames) {
    if (wanted !== undefined && frame.sceneNumber !== wanted) continue;
    rule(`Scene ${frame.sceneNumber} — ${frame.purpose}`);

    if (!frame.rendered) {
      console.log(`Not rendered. Inherited from scene ${frame.inheritedFrom}'s end frame.`);
      continue;
    }
    if (frame.seamBreak) {
      console.log(
        `Chain broken before this scene (${frame.seamBreak.reason}: ${frame.seamBreak.detail}),` +
          ` so this start frame is rendered rather than inherited.`,
      );
    }

    const settings = frame.settings ?? {};
    const show = (label: string, value: unknown) => {
      if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) return;
      console.log(`${label}: ${Array.isArray(value) ? `\n  ${value.join("\n  ")}` : value}`);
    };

    show("model", settings.model_type ?? settings.modelType);
    show("seed", settings.seed);
    show("steps", settings.num_inference_steps);
    show("resolution", settings.resolution);
    show("video_prompt_type", settings.video_prompt_type);
    show("image_refs", settings.image_refs);
    show("activated_loras", settings.activated_loras);
    console.log(`\n--- prompt ---\n${settings.prompt ?? ""}`);
    const negative = settings.negative_prompt;
    console.log(
      `\n--- negative_prompt ---\n${negative || "(none — folded into the prompt above)"}`,
    );
  }
}

void main()
  .catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e))
  // The MCP client holds its connection open, so the process would otherwise
  // sit there looking hung long after the last line has printed.
  .finally(() => process.exit(0));
