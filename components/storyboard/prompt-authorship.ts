import { promptAuthorship, type ArtifactExecution } from "@/lib/schemas/provenance";

/**
 * What the fallback notice can honestly say about the per-scene prompts.
 *
 * The notice used to assert they were unaffected, reasoning from the mechanism:
 * cards are one request, prompts are one request per scene per pass, so a card
 * failure cannot touch a prompt. True in isolation, and routinely false in a
 * run — whatever exhausted the context for the cards is usually still there for
 * the prompts. This reads the answer off the executions instead.
 */
export function promptAuthorshipSentence(
  executions: ArtifactExecution[] | undefined,
  sceneIds: readonly string[],
): string {
  const image = promptAuthorship(executions, sceneIds, "image_prompt");
  const video = promptAuthorship(executions, sceneIds, "video_prompt");
  const written = (pass: typeof image) => pass.llm + pass.hybrid;

  if (image.total === 0) return "";

  // Nothing recorded either way. Older projects have no provenance, and
  // claiming the prompts are fine is exactly the guess this replaced.
  if (image.unrecorded === image.total && video.unrecorded === video.total) {
    return (
      "This project predates prompt provenance, so whether the per-scene prompts were written " +
      "by the model is not recorded. Expand Prompts on any card to read what will be sent to WanGP."
    );
  }

  const imageWritten = written(image);
  const videoWritten = written(video);

  if (imageWritten === image.total && videoWritten === video.total) {
    return (
      `The per-scene prompts came through: all ${image.total} image and all ${video.total} video ` +
      "prompts were written by the planning model, so only the cards above are mechanical. " +
      "Expand Prompts on any card to read what will be sent to WanGP."
    );
  }

  return (
    `The prompts were hit too: ${imageWritten} of ${image.total} image prompts and ` +
    `${videoWritten} of ${video.total} video prompts were written by the planning model. ` +
    "The rest came from the built-in builder, like the cards, and will render literally. " +
    "Expand Prompts on any card to read what will be sent to WanGP."
  );
}
