import { getWangpClient } from "./lib/wangp/factory";
import { selectVideoModel } from "./lib/wangp/model-router";
(async () => {
  const c = getWangpClient();
  const models = await c.listModels("video");
  const picked = selectVideoModel(models, { modelStrategy: "auto" });
  console.log("auto-selected video model:", picked?.modelType);
  if (!picked) return;
  const s = await c.getModelSchema(picked.modelType);
  for (const n of ["video_length", "force_fps", "duration_seconds", "num_inference_steps"]) {
    const f = s.fields.find(x => x.name === n);
    console.log("  " + n.padEnd(20), f ? JSON.stringify({ min: f.min, max: f.max, allowed: f.allowed }) : "(not declared)",
      " default=" + JSON.stringify((s.defaultSettings as Record<string, unknown>)[n]));
  }
})().catch(e => console.log("ERR", (e as Error).message));
