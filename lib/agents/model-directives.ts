import type { ModelFamily } from "@/lib/wangp/family";

/**
 * Per-family prompt rules for the Image and Video Prompt Agents.
 *
 * These come from each developer's own published guidance rather than from
 * folklore, because the families disagree on points that matter. FLUX wants
 * exclusions stated positively and treats lighting as the highest-leverage
 * instruction; Qwen wants literal copy quoted and layout named; Wan's official
 * image-to-video formula is motion plus camera and nothing else; LTX wants one
 * flowing present-tense shot and writes the soundtrack from the same text.
 *
 * The family is resolved from the project's model pin, so an unpinned project
 * gets no directive at all. That is deliberate: a directive written for FLUX
 * and rendered by Qwen is worse than none.
 */

export function imagePromptDirective(family: ModelFamily): string {
  switch (family) {
    case "flux":
      return (
        " This scene renders on FLUX, which has no negative prompt: anything you want kept out " +
        "of the frame must be written into the prompt as the thing to render instead. Write " +
        '"crisp subject detail" rather than "no blur", "a sparse, uncluttered setting" rather ' +
        'than "no clutter". State lighting explicitly and in full — source, direction, quality, ' +
        "contrast and colour temperature — because it moves the render further than any other " +
        "instruction. Where a colour must be exact, give the name and its hex value."
      );
    case "qwen":
      return (
        " This scene renders on Qwen-Image, which is unusually literal about structure and text. " +
        "Order the prompt as format, then subject, then layout, then lighting and finish. Any " +
        "lettering that must appear in frame goes in quotation marks exactly as it should read, " +
        "with its position and relative size stated; if no lettering belongs in the shot, say so. " +
        "Describe materials at two scales — the macro structure and the micro texture — since " +
        "that is where this model repays detail."
      );
    case "krea":
      return (
        " This scene renders on Krea, which has no dependable negative prompt: state exclusions " +
        "as the thing to render instead. Separate what is in the frame from how it looks — " +
        "subject, action and composition first, then a single coherent visual language for " +
        "palette, texture and finish. Do not stack competing style labels; one visual system " +
        "described through its visible properties beats five names."
      );
    default:
      return "";
  }
}

export type VideoDirectiveOptions = {
  segmentSeconds: number;
  /** Whether the model writes its own soundtrack from this prompt. */
  nativeAudio: boolean;
};

export function videoPromptDirective(
  family: ModelFamily,
  { segmentSeconds, nativeAudio }: VideoDirectiveOptions,
): string {
  switch (family) {
    case "wan":
      return (
        " This clip renders on Wan, whose published image-to-video formula is motion plus camera " +
        "movement and nothing more. Keep the prompt short and literal: one dominant action with " +
        "its direction and speed, at most one secondary movement, then the camera. Qualify every " +
        'movement with pace — "slowly turns", "takes one cautious step" — because an unqualified ' +
        "verb renders as an average of every speed it could mean. If the camera is locked, say " +
        '"fixed camera, unchanged framing" rather than leaving it unsaid.'
      );
    case "ltx":
      return (
        " This clip renders on LTX. Write one flowing paragraph in the present tense, four to " +
        "eight sentences for a shot with real movement and fewer for a held one. Convey feeling " +
        "through what the body does — a jaw tightening, a gaze dropping — never through an " +
        "emotional label, which the model cannot render. State the camera move relative to the " +
        "subject and say what the framing settles on at the end, so the movement has somewhere " +
        "to finish. Avoid signs, logos and readable text: this model does not hold them steady." +
        (nativeAudio
          ? " LTX writes the soundtrack from this same prompt. Describe the ambience and any " +
            "Foley, and put every spoken line in quotation marks with the delivery named. " +
            `About ${Math.round(segmentSeconds * 2)} words of speech fill ${segmentSeconds} ` +
            "seconds at a natural pace, so use that budget rather than reducing an exchange to " +
            "a single remark — a clip with two words in it wastes the model's one real " +
            "advantage. Only trim when the scene genuinely carries more than will fit."
          : "")
      );
    case "minimax":
      return (
        " This clip renders on MiniMax H3 in first-and-last-frame mode: the two keyframes are " +
        "pinned to the opening and closing moments and the model generates the path between " +
        "them. Describe that path, not the endpoints — the frames already fix how the shot " +
        "opens and closes, so write the opening state, then the visible changes in the order " +
        "they happen, then how the differences narrow until the closing frame is reached. Keep " +
        "it to one continuous shot with no cuts. Open by naming the visual style and the " +
        "framing, then give one dominant action and at most one secondary movement, each " +
        "qualified with its pace. " +
        // MiniMax publishes a controlled camera vocabulary and asks for the move
        // to be written as an action inside the shot rather than appended as
        // labels. Amplitude and speed are stated only when not ordinary.
        "Write the camera as a single move inside the action, in MiniMax's own terms — push in, " +
        "pull out, zoom in, zoom out, pan left or right, truck left or right, tilt up or down, " +
        "pedestal up or down, arc shot, tracking shot, static shot — qualified only where it is " +
        'not ordinary: "with small amplitude" or "with large amplitude", "at slow speed" or ' +
        '"at fast speed". A locked camera holds a static shot, and say so rather than leaving ' +
        "it unsaid. " +
        // Verified against a live WanGP schema: minimax_h3_fl2va declares no
        // negative_prompt field, so an exclusion sent as one never arrives.
        "This model has no negative prompt, so anything that must stay out of the clip has to " +
        "be written as the thing to show in its place. " +
        // MiniMax ask for 350-500 words and their own worked examples are that
        // long. The length is descriptive density, not extra events: padding it
        // with more actions is the one thing the motion budget cannot afford.
        "Write it long and specific — MiniMax ask for roughly 350 to 500 words, and H3 is built " +
        "to consume that much. Fill it by describing more closely, never by adding more events: " +
        "the opening composition and framing, how the subject looks and where it sits in the " +
        "frame, the setting and its light, each stage the one action passes through and what " +
        "changes as it does, the camera, and the sound of whatever is visibly happening. " +
        "Describe what is seen rather than summarising what occurs." +
        (nativeAudio
          ? " H3 writes the soundtrack from this same prompt, and it keeps three layers apart. " +
            "Ambience and physical sound — weather, traffic, footsteps, fabric, impacts, " +
            "breathing — are the scene's continuous soundscape and should be tied to things " +
            "visibly happening. Score that only the audience can hear is described by its " +
            "instrumentation, tempo and how it builds or fades, never by the mood it is meant " +
            "to produce, which the model cannot render. Speech is the third: name who speaks " +
            "and establish them once — age, whether they are on or off screen, pitch and pace " +
            "— and keep the delivery outside the quotation marks with only the spoken words " +
            "inside, word for word. " +
            `About ${Math.round(segmentSeconds * 2)} words of speech fill ${segmentSeconds} ` +
            "seconds at a natural pace — use that budget rather than reducing an exchange to a " +
            "single remark. " +
            // H3 fields the three layers separately, so they are returned
            // separately: `videoSoundscape` for ambience and physical sound,
            // `videoScore` for the audience-only music.
            "Return the ambience as `videoSoundscape` — one to four sentences covering weather, " +
            "room tone, footsteps, fabric, impacts and breathing, but never the dialogue or the " +
            "score. Return the audience-only music as `videoScore`, one to three sentences of " +
            "instrumentation, tempo and how it develops; write `N/A` where the scene should " +
            "carry no score. Keep the spoken lines in the clip prompt itself."
          : "")
      );
    case "flux":
    case "qwen":
    case "krea":
    default:
      return "";
  }
}

/**
 * Whether this video model writes audio from the prompt.
 *
 * Family-derived rather than read from WanGP's `returns_audio` capability,
 * because prompts are written without a WanGP round trip and must work in demo
 * mode. Adding a family here is the cost of that.
 */
export function hasNativeAudio(family: ModelFamily): boolean {
  return family === "ltx" || family === "minimax";
}
