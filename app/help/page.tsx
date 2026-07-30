import { AppShell } from "@/components/shell/app-shell";
import {
  ASPECT_RATIO_DOCS,
  AUDIENCE_PRESETS,
  AUDIO_TOGGLE_DOCS,
  CREATIVE_MODE_DOCS,
  GENERATION_MODE_DOCS,
  RESOLUTION_DOCS,
  SCENE_CONTINUITY_OPTIONS,
  STYLE_PRESETS,
  TONE_PRESETS,
  type PresetOption,
} from "@/lib/presets";

export const metadata = {
  title: "Help · StoryForgeAI",
  description: "How to use StoryForgeAI, end to end.",
};

type Section = { id: string; title: string };

const TOC: Section[] = [
  { id: "overview", title: "1. What StoryForgeAI does" },
  { id: "concepts", title: "2. Key concepts" },
  { id: "fields", title: "3. Field reference (New Project)" },
  { id: "characters", title: "4. Character library" },
  { id: "quickstart", title: "5. Quick start" },
  { id: "workflow", title: "6. The end-to-end workflow" },
  { id: "pages", title: "7. Every screen explained" },
  { id: "agents", title: "8. The creative team (agents)" },
  { id: "wangp", title: "9. WanGP & generation" },
  { id: "qc", title: "10. QC, attempts & approval" },
  { id: "assembly", title: "11. Assembly & exports" },
  { id: "deepy", title: "12. Deepy assist" },
  { id: "flags", title: "13. Modes & feature flags" },
  { id: "faq", title: "14. FAQ & troubleshooting" },
];

function Anchor({ id }: { id: string }) {
  return <span id={id} className="block -mt-24 pt-24" aria-hidden />;
}

/** Option list rendered from the same catalog the New Project form uses. */
function OptionList({ options }: { options: readonly PresetOption[] }) {
  return (
    <dl className="mt-2 space-y-2">
      {options.map((option) => (
        <div key={option.value}>
          <dt className="text-sm font-medium text-slate-100">{option.label}</dt>
          <dd className="text-sm leading-relaxed text-slate-300">{option.description}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocList({ docs }: { docs: Readonly<Record<string, string>> }) {
  return (
    <dl className="mt-2 space-y-2">
      {Object.entries(docs).map(([key, description]) => (
        <div key={key}>
          <dt className="text-sm font-medium text-slate-100">
            <code>{key}</code>
          </dt>
          <dd className="text-sm leading-relaxed text-slate-300">{description}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function HelpPage() {
  const card = "rounded-lg border border-white/10 bg-panel/40 p-5";
  const h2 = "text-xl font-semibold";
  const h3 = "mt-4 font-semibold text-slate-100";
  const p = "mt-2 text-sm leading-relaxed text-slate-300";
  const li = "text-sm leading-relaxed text-slate-300";

  return (
    <AppShell>
      <div className="space-y-8">
        <header>
          <h1 className="text-3xl font-semibold">Help &amp; user guide</h1>
          <p className="mt-2 text-sm text-slate-400">
            Everything you need to take a single idea all the way to an assembled video —
            explained step by step. StoryForgeAI runs fully offline in demo mode, so you can
            explore every feature without any setup.
          </p>
        </header>

        {/* Table of contents */}
        <nav className={card} aria-label="Contents">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Contents</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {TOC.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-sm text-accent hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* 1. Overview */}
        <section className={card}>
          <Anchor id="overview" />
          <h2 className={h2}>1. What StoryForgeAI does</h2>
          <p className={p}>
            StoryForgeAI is a local-first <strong>agentic creative studio</strong>. You give it a
            concept and a target duration; it plans a full production the way a small studio would —
            a creative brief, story arc, visual style guide, scene-by-scene storyboard, image and
            video prompts, generation settings, and finally an assembled cut.
          </p>
          <p className={p}>
            Instead of sending one big prompt to a video model, it builds a structured, editable
            plan first, then uses that plan to drive generation. You stay in control with review and
            approval steps along the way.
          </p>
        </section>

        {/* 2. Concepts */}
        <section className={card}>
          <Anchor id="concepts" />
          <h2 className={h2}>2. Key concepts</h2>
          <h3 className={h3}>Segment length</h3>
          <p className={p}>
            Every video is planned as a series of <strong>equal-length scenes</strong>. Clip length is
            set per project, from 5 to 20 seconds, and the number of scenes is{" "}
            <code>ceil(duration ÷ clip length)</code>. If your target isn&apos;t an exact multiple of
            the clip length, the final scene is marked with a trim so the finished video matches your
            requested length. Example: a 90-second video at 20s clips → 5 scenes (100s generated),
            with the last scene trimmed by 10 seconds. The 20-second ceiling is the video model&apos;s
            native window; longer clips would need sliding-window generation.
          </p>
          <h3 className={h3}>Project</h3>
          <p className={p}>
            A project holds everything for one video: your inputs, the creative artifacts each agent
            produces, generated media attempts, the assembly, and a decision history.
          </p>
          <h3 className={h3}>Agents &amp; artifacts</h3>
          <p className={p}>
            Each agent is a specialist that produces one artifact (e.g. the Story Architect produces
            the story arc). You can regenerate any artifact at any time.
          </p>
          <h3 className={h3}>Demo mode</h3>
          <p className={p}>
            Out of the box the app uses deterministic mock agents and a mocked generation backend, so
            it works with no API keys, no database, and no WanGP server. Turning on real integrations
            is a configuration change (see <a href="#flags" className="text-accent hover:underline">Modes &amp; feature flags</a>).
          </p>
        </section>

        {/* 3. Field reference */}
        <section className={card}>
          <Anchor id="fields" />
          <h2 className={h2}>3. Field reference (New Project)</h2>
          <p className={p}>
            Every field on the New Project form changes what the agents plan and, for most of them,
            what text is sent to the generation models. This section defines each option.
          </p>

          <h3 className={h3}>Concept</h3>
          <p className={p}>
            Your idea in plain language. It is the seed for the creative brief, the story arc and
            every scene description, so a sentence with a subject, a setting and a change works far
            better than a single noun.
          </p>

          <h3 className={h3}>Duration &amp; clip length</h3>
          <p className={p}>
            Duration is the runtime you want. Clip length is how long each generated segment is, from
            5 to 20 seconds. Scene count is <code>ceil(duration ÷ clip length)</code>. Shorter clips
            give you more cuts and tighter control but multiply render time; longer clips cover more
            ground per render but drift more within a shot.
          </p>

          <h3 className={h3}>Aspect ratio</h3>
          <p className={p}>
            The shape of the frame. Together with the resolution preset it decides the exact size
            sent to WanGP — a 9:16 project renders portrait, not a cropped landscape. If the model
            publishes a list of sizes it accepts, the nearest one of the same orientation is used;
            a portrait project is never snapped to a landscape size.
          </p>
          <DocList docs={ASPECT_RATIO_DOCS} />

          <h3 className={h3}>Style</h3>
          <p className={p}>
            The visual look. It reaches generation directly: <code>&quot;&lt;style&gt; style&quot;</code>{" "}
            is appended to every start-frame, end-frame and video prompt after the prompt agent has
            written it, so it lands whether or not the agent thought to mention it. A term the
            prompt already contains is not repeated — a duplicated word in a diffusion prompt
            carries double the weight. Pick <em>Custom…</em> to type your own wording; it is used
            verbatim.
          </p>
          <OptionList options={STYLE_PRESETS} />

          <h3 className={h3}>Tone</h3>
          <p className={p}>
            The emotional register, appended alongside the style as{" "}
            <code>&quot;&lt;tone&gt; mood&quot;</code>. Also used to write the music cue prompts and
            the narrator voice profile.
          </p>
          <OptionList options={TONE_PRESETS} />

          <h3 className={h3}>Audience</h3>
          <p className={p}>
            Who the piece is for. Shapes vocabulary, pacing and content limits in the creative brief
            and the story arc, and is appended to each render prompt as{" "}
            <code>&quot;Intended audience: …&quot;</code>.
          </p>
          <p className={p}>
            StoryForgeAI applies no content filtering of its own — there is no moderation step, no
            blocklist and no age gate anywhere in the pipeline. What you can actually produce is
            decided by the planning model you have configured and by the licence of each WanGP model
            you generate with; several carry their own restrictions. Setting an adult audience tells
            the planning agents not to soften the material, nothing more.
          </p>
          <OptionList options={AUDIENCE_PRESETS} />

          <h3 className={h3}>Resolution</h3>
          <p className={p}>
            Quality, which sets both the frame size and the floor on denoising steps. At 16:9 that
            is 848×480, 1280×720 and 1920×1088; the step floor scales with it.
          </p>
          <p className={p}>
            The floor exists because WanGP reports whatever was last set in its own UI as a
            model&apos;s defaults. A model last used with a Lightning accelerator LoRA comes back
            asking for 4 steps — and since StoryForgeAI writes the LoRA stack on every job, that
            would strip the accelerator and keep its step count, which renders a smear. The floor
            only applies when nothing is accelerating the model: a step count named in an
            accelerator LoRA&apos;s filename (<code>Lightning-8steps</code> → 8) wins, and a
            distilled model keeps its own count. Override either on the project settings screen.
          </p>
          <DocList docs={RESOLUTION_DOCS} />

          <h3 className={h3}>Creative mode</h3>
          <p className={p}>
            The format you are making. Its definition below is handed to the Story Architect and
            Storyboard agents as a hard instruction, so it shapes act structure, pacing and shot
            selection — a microdrama gets a cliffhanger per scene where a film short gets a
            three-act shape.
          </p>
          <DocList docs={CREATIVE_MODE_DOCS} />

          <h3 className={h3}>Generation mode</h3>
          <p className={p}>
            How far the pipeline is allowed to run. It is a ceiling, enforced in the services rather
            than only in the buttons: a mode that renders no video never loads the video model.
            Editable at any time from the <strong>Storyboard</strong> screen, so you can plan first
            and decide to render later.
          </p>
          <DocList docs={GENERATION_MODE_DOCS} />

          <h3 className={h3}>Narration, dialogue, music &amp; SFX</h3>
          <DocList docs={AUDIO_TOGGLE_DOCS} />

          <h3 className={h3}>Scene continuity (set on the Storyboard screen)</h3>
          <p className={p}>
            Each scene is rendered as an independent job, so by default nothing ties one clip to the
            next beyond the prompt. This control decides what a scene inherits from the one before
            it, trading render cost against continuity at the seam. It applies to scenes generated
            from that point on — no regeneration needed — and scene 1 always renders its own frames.
            If a scene&apos;s predecessor has not been generated yet, it falls back to a cut.
          </p>
          <OptionList options={SCENE_CONTINUITY_OPTIONS} />

          <h3 className={h3}>Batch generation (Storyboard screen)</h3>
          <p className={p}>
            <strong>Generate all media</strong> queues every scene that has no media yet;{" "}
            <strong>Regenerate all</strong> re-runs the whole storyboard. Scenes are generated one
            at a time and strictly in order, for two reasons: WanGP runs a single job at a time, and
            the continuity modes above read the previous scene&apos;s finished attempt, so overlapping
            them would quietly degrade them to plain cuts.
          </p>
          <p className={p}>
            The queue runs on the server, so closing the page does not abandon it. A scene that fails
            is marked and skipped rather than stopping the rest, and{" "}
            <strong>Cancel remaining</strong> abandons everything that has not started (the scene
            already in flight finishes).
          </p>
          <p className={p}>
            Two things protect a long run. Starting a batch <strong>unloads the planning model</strong>{" "}
            first, because a local LLM and the image/video models cannot share one consumer GPU —
            overlapping them makes WanGP thrash while swapping models and scenes die partway with
            CUDA errors. And a scene that fails with a transient GPU fault (a CUDA error, or an
            out-of-memory) is <strong>retried automatically</strong> after a pause; a chip showing
            &quot;try 2&quot; means the first attempt hit one. Errors that a retry cannot fix, such as
            an unsupported reference image, fail immediately instead.
          </p>

          <h3 className={h3}>Planning model (set on the Storyboard screen)</h3>
          <p className={p}>
            When planning runs on a local LLM, that model and the image/video models compete for the
            same GPU. LM Studio keeps its model resident long after planning finishes — its default
            idle timeout is an hour — so on a single-card machine the next render can fail with an
            out-of-memory message from WanGP.
          </p>
          <p className={p}>
            The Storyboard screen therefore shows the planning model&apos;s state with{" "}
            <strong>Load for planning</strong> and <strong>Unload to free GPU</strong> buttons. The
            working order is: load, generate or regenerate the storyboard, unload, then generate
            media. The panel appears only when a local OpenAI-compatible server is configured via{" "}
            <code>OPENAI_BASE_URL</code>, and it drives LM Studio through its <code>lms</code> CLI,
            which the LM Studio installer puts on your PATH.
          </p>
        </section>

        {/* 4. Character library */}
        <section className={card}>
          <Anchor id="characters" />
          <h2 className={h2}>4. Character library</h2>
          <p className={p}>
            Each scene is rendered as an independent job, so nothing inherently stops a face from
            changing between clips. The character library is how you stop it: describe a character
            once, then reuse that exact description in every project that features them.
          </p>

          <h3 className={h3}>Where it lives</h3>
          <p className={p}>
            Under <strong>Settings</strong> in the top navigation. It is global, not per-project, and
            available whether or not you have a project open. Descriptions are saved to disk, so they
            survive a restart.
          </p>

          <h3 className={h3}>What a character holds</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}>
              <strong>Name</strong> — how the character is referred to in scene cards, dialogue
              attribution and continuity notes.
            </li>
            <li className={li}>
              <strong>Physical description</strong> — the text injected into prompts. Write it as
              prompt-ready prose (age, build, hair, face, skin, distinguishing features) rather than a
              biography; it is concatenated verbatim, so backstory only dilutes it.
            </li>
            <li className={li}>
              <strong>Default wardrobe</strong> — optional, and usually best left blank. Costume
              belongs to the story rather than the person, so it is normally set{" "}
              <em>per project</em> when you pick the cast. Fill this in only for a character whose
              outfit never changes, such as a uniform or a mascot costume.
            </li>
            <li className={li}>
              <strong>Negative prompt terms</strong> — traits to actively suppress for this character,
              appended to the negative prompt of every scene they appear in.
            </li>
            <li className={li}>
              <strong>Facial description</strong> — optional, and the field to use for eyes, nose,
              jaw, skin and expression. It is <em>withheld from image and video prompts once a
              reference image exists</em>, because a written face and a photograph are competing
              instructions and the text tends to win — which is backwards when you supplied the photo
              precisely to fix the likeness. Removing these sentences measurably improved likeness in
              testing. Planning agents still receive it, since they have no photo to work from.
            </li>
            <li className={li}>
              <strong>Reference images</strong> — up to two pictures, most representative first. They
              are sent to the generation backend as reference input for the start and end frames, so
              the render is conditioned on the actual likeness rather than only the words. A second
              angle helps; two is the ceiling of the reference-capable models in use. Requires an
              image model that accepts reference images; if the pinned model cannot, StoryForgeAI
              substitutes one that can. The background behind the subject is stripped automatically,
              so the setting in the photo does not become part of the reference.
            </li>
            <li className={li}>
              <strong>Face swap generated frames</strong> — optional. See below.
            </li>
          </ul>

          <h3 className={h3}>Face swap</h3>
          <p className={p}>
            Reference conditioning gets identity close but not exact — the model is still synthesising
            a face rather than transplanting one. Ticking <strong>Face swap generated frames</strong>
            {" "}runs a dedicated pass after each keyframe renders, replacing the head in the generated
            frame with the head from the character&apos;s first reference image.
          </p>
          <p className={p}>
            It runs automatically as part of generation, not as a background task, and that ordering
            is deliberate: the end frame is rendered <em>against</em> the start frame and the clip is
            rendered from both, so a swap arriving afterwards would be overwritten by the very frames
            it was meant to correct. The swap therefore sits between renders — start frame, swap, end
            frame, swap, then the clip. What you see on the storyboard is the swapped frame, because
            it is the frame everything downstream uses.
          </p>
          <p className={p}>
            The pass is four steps with an accelerator LoRA, so it costs seconds rather than the
            minutes a keyframe takes. With <em>Continue from previous end frame</em> continuity you
            pay for roughly one swap per scene. If it fails, the original frame is kept and the scene
            still completes — a lost improvement, not a lost render.
          </p>
          <p className={p}>
            Two requirements. The character needs a reference image, and it must be the{" "}
            <strong>only</strong> character in the project with face swap enabled: the underlying
            recipe is written around a single subject, so with two there is no way to say which face
            belongs where and the swap is skipped rather than guessed. It also needs a Qwen Image Edit
            model and its two face-swap LoRAs installed in WanGP.
          </p>

          <h3 className={h3}>Using it in a project</h3>
          <p className={p}>
            On the New Project form, tick <em>Use saved character descriptions</em> and select the
            characters that appear in this story. Leave it off and nothing changes — the agents invent
            their own cast as before.
          </p>
          <p className={p}>
            Each selected character gets a <strong>wardrobe</strong> box for that project. Name
            specific garments, colours and materials: clothing is the detail that drifts hardest,
            because a scene&apos;s start and end frames are separate renders and an unstated outfit
            gets reinvented each time. Vague wording such as &quot;casual attire&quot; is the same as
            saying nothing. The same character can wear something entirely different in your next
            project, and wardrobe stays editable afterwards from the project&apos;s Settings screen.
          </p>

          <h3 className={h3}>What it actually changes</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}>
              The <strong>Visual Bible</strong> is seeded with your characters, and the library
              description wins if the model tries to paraphrase or rename them.
            </li>
            <li className={li}>
              The <strong>Storyboard Artist</strong> is told the cast is locked, so scene cards refer
              to characters by name and continuity notes point back to the library.
            </li>
            <li className={li}>
              The <strong>Image and Video Prompt agents</strong> append the canonical description to
              every start frame, end frame and motion prompt, and merge the character&apos;s negative
              terms into the negative prompt.
            </li>
            <li className={li}>
              Any <strong>reference images</strong> are sent to the image model when rendering the two
              keyframes. The video clip is generated from those frames, so the likeness carries into
              the motion without a second reference pass.
            </li>
          </ul>
          <p className={p}>
            Descriptions are read at generation time, not at project creation. Editing a character and
            regenerating the storyboard picks up the new wording.
          </p>

          <h3 className={h3}>Keeping a scene consistent with itself</h3>
          <p className={p}>
            A scene&apos;s start and end frames are two independent renders, so without help the model
            reinvents anything the prompt does not pin down. Three things hold them together. The{" "}
            <strong>end frame is rendered with the start frame as a reference image</strong>, which
            carries wardrobe, styling, location and lighting across while the prompt still drives the
            change in framing and action. The <strong>Image Prompt agent</strong> is instructed to
            name specific garments and repeat that wording in both frames rather than writing a vague
            placeholder. And a character&apos;s <strong>wardrobe</strong> field states the outfit
            outright.
          </p>
          <p className={p}>
            End-frame conditioning needs an image model that accepts reference images; it is skipped
            automatically when continuity is set to continue from the previous clip, since no frames
            are rendered then. Set <code>END_FRAME_REFERENCES_START_FRAME=false</code> to turn it off.
          </p>
        </section>

        {/* 5. Quick start */}
        <section className={card}>
          <Anchor id="quickstart" />
          <h2 className={h2}>5. Quick start</h2>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li className={li}>
              Open <strong>New project</strong> from the header. Enter a concept and a duration, then
              click <em>Create Storyboard</em>.
            </li>
            <li className={li}>
              On the <strong>Storyboard</strong> screen, click <em>Generate storyboard</em> to plan
              your scenes.
            </li>
            <li className={li}>
              For any scene, click <em>Generate media</em>, then <em>Approve attempt</em> once you are
              happy with it.
            </li>
            <li className={li}>
              Open <strong>Assembly</strong>, click <em>Assemble rough cut</em>, and download the
              export package.
            </li>
          </ol>
          <p className={p}>
            That&apos;s the shortest path. The full workflow below adds variant exploration, the
            creative canvas, and an animatic preview.
          </p>
        </section>

        {/* 6. Workflow */}
        <section className={card}>
          <Anchor id="workflow" />
          <h2 className={h2}>6. The end-to-end workflow</h2>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li className={li}><strong>New project</strong> — describe the idea and settings.</li>
            <li className={li}><strong>Variant Review</strong> (optional) — generate 3 creative directions and select one.</li>
            <li className={li}><strong>Storyboard</strong> — generate the brief, visual bible, and 20s scene cards; edit and approve.</li>
            <li className={li}><strong>Agentic Canvas</strong> — run the World Builder, Director, Cinematographer, Art Director, and Audio Director; review each artifact.</li>
            <li className={li}><strong>Animatic</strong> (optional) — preview pacing and captions before spending time on video.</li>
            <li className={li}><strong>Generation Console</strong> — check the WanGP connection and available models.</li>
            <li className={li}><strong>Per scene</strong> — generate start/end keyframes + the 20s video, run QC, and approve the best attempt.</li>
            <li className={li}><strong>Assembly</strong> — assemble a rough cut and export the package.</li>
          </ol>
          <p className={p}>
            Steps are not strictly linear — you can jump between screens using the buttons in each
            screen&apos;s header. Variants, plans, and the animatic are optional; the minimum path is
            storyboard → media → assemble.
          </p>
        </section>

        {/* 7. Pages */}
        <section className={card}>
          <Anchor id="pages" />
          <h2 className={h2}>7. Every screen explained</h2>

          <h3 className={h3}>Home</h3>
          <p className={p}>
            What StoryForgeAI is, the four stages of the pipeline, and the projects you touched most
            recently. Use <strong>Projects</strong> in the header to see every project; the tab stays
            highlighted while you are inside one, so it is always the way back.
          </p>

          <h3 className={h3}>New project</h3>
          <p className={p}>
            Collects your concept, duration, clip length, aspect ratio, resolution, style, tone,
            audience, creative mode, generation mode, the narration/dialogue/music/SFX toggles, and
            whether to pin characters from the{" "}
            <a href="#characters" className="text-accent hover:underline">
              character library
            </a>
            . Every option is defined in the{" "}
            <a href="#fields" className="text-accent hover:underline">
              field reference
            </a>
            . Submitting creates the project and opens its storyboard.
          </p>
          <p className={p}>
            <strong>Deleting a project.</strong> Hover a project on the Projects screen and use the{" "}
            <span aria-hidden>✕</span> to remove it. You are asked to confirm first, and the
            deletion cannot be undone — the storyboard, prompts, attempts and history all go.
            Generated images and video are removed with it by default, since once the project is
            gone that folder is unreachable from the app; tick{" "}
            <em>Keep generated images and video on disk</em> if the clips are worth more than the
            project that produced them. Any queued scenes for that project are cancelled first.
          </p>

          <h3 className={h3}>Settings (global)</h3>
          <p className={p}>
            Reachable from the top navigation at any time, with or without an open project. Holds the
            character library and links through to each project&apos;s model pins.
          </p>

          <h3 className={h3}>Storyboard Review</h3>
          <p className={p}>
            The heart of the app. Shows the project title, logline, synopsis, duration summary, and one
            card per scene. Each scene card includes its objective, visual description, camera
            movement, and expandable prompts. From here you can generate/regenerate the storyboard,
            generate media per scene, approve attempts, and export. Header buttons jump to Variant
            Review, Agentic Canvas, and the Generation Console.
          </p>
          <p className={p}>
            A <strong>Creative plans</strong> panel sits near the top. It lists the four canvas plans
            that shape rendering and marks each one <em>in this storyboard</em>, <em>not applied
            yet</em>, or <em>not generated</em>. &quot;Not applied yet&quot; means the plan was
            generated <em>after</em> the current storyboard, so none of its direction is reaching
            your images or video until you regenerate — see{" "}
            <a href="#agents" className="text-accent hover:underline">The creative team</a> for why.
          </p>

          <p className={p}>
            Each scene card also carries two panels of its own. <strong>Prompts</strong> is editable —
            it holds the exact text sent to WanGP, so you can fix a phrase or add a LoRA trigger word
            for one shot without regenerating anything. <strong>LoRAs</strong> lets a scene override
            the storyboard-wide selection. Both are covered in{" "}
            <a href="#wangp" className="text-accent hover:underline">WanGP &amp; generation</a>.
          </p>

          <h3 className={h3}>Variant Review</h3>
          <p className={p}>
            Generates 3 distinct creative directions (hook, story angle, visual style, strengths,
            risks, best-fit platform). Select one to steer the storyboard, or regenerate for new ideas.
          </p>

          <h3 className={h3}>Agentic Canvas</h3>
          <p className={p}>
            A creative-team view. Each agent appears as a card with its role, current status
            (pending/ready), a summary of its latest output, and a Generate/Regenerate action. A
            decision history logs what happened and when. This is where you run the World Builder,
            Director, Cinematographer, Art Director, Audio Director, and Animatic.
          </p>
          <p className={p}>
            <strong>Run core agents</strong> does the whole sequence for you: World Builder →
            Director → Cinematographer → Art Director, one at a time, then the storyboard if you
            leave that option ticked. Order is the point — the storyboard folds in whichever plans
            exist <em>at the moment it runs</em>, so running it last is what makes the plans reach
            your renders. Progress is shown as it goes, and <strong>Stop after this one</strong>
            halts cleanly at the next boundary. If an agent fails the run stops there rather than
            continuing, since a later plan built on a missing earlier one is not what you asked for.
          </p>
          <p className={p}>
            Variant Explorer is deliberately not part of that run: choosing a direction is your
            decision, and generating variants nobody selects changes nothing downstream.
          </p>
          <p className={p}>
            <strong>Agent calls are queued.</strong> A local model serves one request at a time, so
            overlapping calls are slower at best and can exhaust VRAM at worst. Every planning call
            is serialised server-side when a local server is configured — including the ones the
            storyboard makes per scene — so nothing collides even if you start something else from
            another tab. Buttons also lock while any agent is running. Hosted APIs are left to run
            in parallel, where there is no such limit.
          </p>

          <h3 className={h3}>Animatic Review</h3>
          <p className={p}>
            Builds an animatic from the storyboard: ordered frames, captions, per-scene timing, and
            transitions. Use it to approve pacing and story flow before spending time on video
            generation. You can export the animatic plan.
          </p>

          <h3 className={h3}>Generation Console</h3>
          <p className={p}>
            Shows the WanGP connection status and mode, the available image and video models, and a
            job queue. You can submit a test job and refresh its status. This is the window into the
            generation backend.
          </p>

          <h3 className={h3}>Assembly</h3>
          <p className={p}>
            Combines approved scene clips into a rough cut, shows the final-cut plan (clips, durations,
            total runtime), offers per-clip Deepy inspection, and lists the downloadable export package.
          </p>

          <h3 className={h3}>About</h3>
          <p className={p}>
            Shows the WanGP disclosure and the current feature-flag configuration and mode.
          </p>
        </section>

        {/* 8. Agents */}
        <section className={card}>
          <Anchor id="agents" />
          <h2 className={h2}>8. The creative team (agents)</h2>
          <p className={p}>Each agent produces one artifact you can review and regenerate:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>Intake Producer</strong> — turns your idea into a structured creative brief: logline, synopsis, narrative arc, visual style, tone, audience and constraints.</li>
            <li className={li}><strong>Story Architect</strong> — builds the narrative arc: title, logline, emotional progression, and one story beat per segment.</li>
            <li className={li}><strong>Variant Explorer</strong> — proposes three distinct creative directions (hook, story angle, visual style, strengths, risks, best-fit platform) before you commit.</li>
            <li className={li}><strong>World Builder</strong> — a World Bible for continuity across a series: premise, universe and timeline rules, locations, character relationships, recurring motifs, and the contradictions that are forbidden.</li>
            <li className={li}><strong>Director</strong> — the creative thesis, pacing strategy, emotional arc, performance direction and per-scene intent. Answers &quot;what is this scene <em>for</em>&quot;.</li>
            <li className={li}><strong>Cinematographer</strong> — the camera language: lens and framing rules, movement rules, lighting rules, per-scene shot plans and transition grammar.</li>
            <li className={li}><strong>Art Director</strong> — production design, wardrobe, props, set dressing, typography and product-placement rules.</li>
            <li className={li}><strong>Visual Bible</strong> — the continuity guide that binds it together: characters, locations, props, colour palette, lighting, camera style and negative rules. Seeded from the character library when a project pins a cast.</li>
            <li className={li}><strong>Storyboard Artist</strong> — one scene card per segment: objective, story beat, visual description, action, camera movement, transitions and continuity notes.</li>
            <li className={li}><strong>Image &amp; Video Prompt Engineers</strong> — turn each scene card into start/end frame prompts and the motion prompt actually sent to the model, plus negative prompts.</li>
            <li className={li}><strong>Audio Director</strong> — the project audio plan: music and SFX beds anchored to a scene with an offset, duration and prompt. Dialogue and narration are performed by the video model from the scene prompt, not synthesised separately.</li>
            <li className={li}><strong>WanGP Producer</strong> — selects models and builds valid generation settings.</li>
            <li className={li}><strong>Creative Critic / QC</strong> — reviews generated media and flags issues with regeneration notes.</li>
          </ul>
          <p className={p}>
            The World Builder, Director, Cinematographer and Art Director run on demand from the
            Agentic Canvas rather than as part of the storyboard pipeline — run them in any order, or
            not at all. Whichever plans exist when you generate the storyboard are folded into it:
            the plan documents go to the Visual Bible and Storyboard agents in full, while each
            scene&apos;s prompts receive only that scene&apos;s directorial intent and shot plan plus a
            short art-direction summary. Render prompts are kept deliberately tight, because a prompt
            that buries the subject and action behind pages of world-building produces worse video,
            not better.
          </p>
          <p className={p}>
            When two sources disagree — say the Art Director specifies one wardrobe and a pinned
            library character specifies another — precedence is fixed:{" "}
            <strong>character library, then Visual Bible, then the canvas plans</strong>. An
            explicitly pinned character is the strongest statement of intent you can make, so it
            wins. Regenerate the storyboard after changing a plan to pick up the new direction.
          </p>

          <h3 className={h3}>How a plan reaches a rendered frame</h3>
          <p className={p}>
            Worth being precise about, because the failure mode is silent. The chain is:
          </p>
          <p className="mt-2 rounded-md border border-white/10 bg-canvas/60 p-3 font-mono text-xs text-slate-400">
            canvas plans → storyboard generation → each scene&apos;s prompts → WanGP
          </p>
          <p className={p}>
            The plans are read <strong>only at the moment the storyboard is generated</strong>. Their
            content is baked into <code>startFramePrompt</code>, <code>endFramePrompt</code>,{" "}
            <code>videoPromptSegment</code> and the negative prompts. Media generation later reads
            nothing but those prompt strings — it never looks at a plan again.
          </p>
          <p className={p}>
            So <strong>order matters more than anything else in this app</strong>. A plan generated
            after the storyboard has no effect whatsoever until you regenerate. The Agentic canvas
            will still show it as &quot;ready&quot;, because it exists — it simply was not in scope
            when the scene prompts were written. The Storyboard screen flags this for you: any plan
            newer than the current storyboard is marked <em>not applied yet</em>.
          </p>

          <h3 className={h3}>Recommended order</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li className={li}><strong>Variant Explorer</strong> — optional; pick a creative direction first, since it steers everything after it.</li>
            <li className={li}><strong>World Builder</strong> — premise, locations, motifs, forbidden contradictions.</li>
            <li className={li}><strong>Director</strong> — per-scene intent.</li>
            <li className={li}><strong>Cinematographer</strong> — per-scene shot plans and camera rules.</li>
            <li className={li}><strong>Art Director</strong> — production design, wardrobe, props, set dressing.</li>
            <li className={li}><strong>Storyboard Artist last</strong> — this is what folds every plan above into the scene prompts.</li>
            <li className={li}><strong>Then generate media.</strong> Audio Director and Animatic can run any time after the storyboard exists.</li>
          </ol>
          <p className={p}>
            Steps 2 to 6 are exactly what <strong>Run core agents</strong> on the Agentic Canvas does
            in one click, in that order.
          </p>
          <p className={p}>
            Regenerating is cheap in the sense that matters: scene ids are deterministic, so an
            existing scene keeps its generated media, attempts and LoRA selections as long as the
            scene count does not change.
          </p>

          <h3 className={h3}>What does <em>not</em> affect image and video</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>Audio Director</strong> — feeds the audio plan, cues and assembly. It never reaches an image or video prompt.</li>
            <li className={li}><strong>Animatic</strong> — a previsualisation assembled from stills you have already generated.</li>
            <li className={li}><strong>Variant Explorer</strong> — influences rendering only indirectly, through the storyboard generated after a variant is selected.</li>
          </ul>
          <p className={p}>
            Two details worth knowing when judging whether a plan &quot;worked&quot;. Only about one
            clause is taken from each rule list — a twenty-line Art Direction plan contributes a
            sentence, deliberately, because rules that bury the subject and action cost adherence
            rather than buying it. And with AI planning enabled the plans are given to the prompt
            agent as context and the model writes the prompt, so adherence depends on the model; with
            AI planning off the plan text is concatenated mechanically and always appears. Either
            way, expanding <strong>Prompts</strong> on a scene card shows the exact text sent to
            WanGP, which is the only reliable way to confirm what landed.
          </p>
        </section>

        {/* 9. WanGP */}
        <section className={card}>
          <Anchor id="wangp" />
          <h2 className={h2}>9. WanGP &amp; generation</h2>
          <p className={p}>
            StoryForgeAI generates media through WanGP/Wan2GP. It is <strong>discovery-first</strong>:
            it lists available models, prefers ones that support start frames (for scene continuity),
            fetches each model&apos;s default settings, then changes only validated fields. Video length
            is derived from frame rate (<code>fps × clip length + 1</code> frames, aligned to an
            8-frame boundary).
          </p>
          <p className={p}>
            In demo mode a built-in mock backend returns a catalog of example models and simulates job
            progress, so you can explore the whole flow. To use a real WanGP server, enable it in the
            configuration (see below).
          </p>

          <h3 className={h3}>LoRAs</h3>
          <p className={p}>
            A LoRA is a small add-on trained onto a base model to push it toward a particular look,
            subject or motion. You can select them at two scopes:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>Whole storyboard</strong> — in <em>Settings</em> for the project. Applies to every scene.</li>
            <li className={li}><strong>One scene</strong> — the <em>LoRAs</em> panel on any scene card. Choose &quot;Override for this scene&quot; and the scene uses your selection <em>instead of</em> the storyboard-wide one, not in addition to it.</li>
          </ul>
          <p className={p}>
            Image and video LoRAs are chosen separately, because a project pins an image model and a
            video model independently and their catalogues have nothing in common — an LTX-2 motion
            LoRA means nothing to Flux. Each list is filtered to the LoRAs actually installed for the
            model you have pinned, so changing a model pin can drop selections that do not exist for
            the new one. Each LoRA has a <strong>strength</strong> (default 1.0); up to eight can be
            stacked, though VRAM and coherence both suffer long before that.
          </p>
          <p className={p}>
            WanGP&apos;s MCP server publishes no LoRA inventory, so the list is read directly from
            your WanGP <code>loras</code> folder. Set <code>WANGP_LORA_ROOT</code> to that folder to
            turn the feature on. If the picker is empty it will tell you why rather than showing a
            blank list.
          </p>

          <h3 className={h3}>Trigger words</h3>
          <p className={p}>
            Many LoRAs do nothing at all unless a specific word appears in the prompt. That makes
            &quot;I selected a LoRA and nothing changed&quot; the most common way to conclude a LoRA
            is broken when it is merely dormant.
          </p>
          <p className={p}>
            Where WanGP&apos;s <code>loras_metadata</code> folder holds a record for a LoRA,
            StoryForgeAI reads its trained words and <strong>appends any that the prompt does not
            already contain</strong>, automatically, at generation time. Only missing words are
            added, so a prompt you wrote yourself that already names the trigger is left alone and
            editing a prompt never produces duplicates. Matching ignores case and respects word
            boundaries, so &quot;concatenate&quot; does not count as containing &quot;cat&quot;.
          </p>
          <p className={p}>
            <strong>Multi-concept LoRAs.</strong> Trigger words are not always additive. One file can
            pack several mutually exclusive behaviours, selected by which word you use — applying
            them all would ask for contradictory output in a single shot. StoryForgeAI cannot tell
            those apart from a style LoRA whose words belong together, so it follows a simple rule:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>One trigger word</strong> — used automatically; there is nothing to decide.</li>
            <li className={li}><strong>Several</strong> — <em>none</em> are used until you pick. The LoRA panel lists them as toggles; click the ones you want. Choosing several deliberately is allowed.</li>
            <li className={li}><strong>Explicitly none</strong> — deselecting everything is remembered as a decision, not treated as &quot;not chosen yet&quot;.</li>
          </ul>
          <p className={p}>
            A LoRA awaiting a choice is flagged in the panel, and a choice that a LoRA no longer
            offers is dropped rather than sent, so replacing a LoRA cannot leave a stale word behind.
          </p>
          <p className={p}>
            Trigger words are shown in the picker before you select a LoRA and beneath it afterwards,
            and each prompt field on a scene card lists the words that will be appended to it. They
            are never added to negative prompts. Set{" "}
            <code>LORA_APPEND_TRIGGER_WORDS=false</code> to manage them by hand instead.
          </p>
          <p className={p}>
            Not every LoRA has a record — sidecars come from the tool you downloaded the LoRA with.
            Where one is missing, the LoRA still works and still appears in the picker; it simply
            shows its filename and contributes no trigger words, so check the LoRA&apos;s own
            documentation and add the word to the prompt yourself.
          </p>

          <h3 className={h3}>Editing prompts by hand</h3>
          <p className={p}>
            The prompts on a scene card are editable. Expand <strong>Prompts</strong> on any scene to
            change the start-frame, end-frame or motion prompt, or either negative prompt, then save.
            The change affects that scene only and takes effect on its next generation — useful for
            adding a trigger word yourself, fixing a clumsy phrase, or steering one shot without
            touching the other twenty.
          </p>
          <p className={p}>
            Edits live in the storyboard, which keeps a useful guarantee: what the Prompts panel shows
            is what gets sent. The trade-off is that <strong>regenerating the storyboard rewrites
            them</strong>, so make hand edits after you are happy with the plans rather than before.
          </p>
        </section>

        {/* 8. QC */}
        <section className={card}>
          <Anchor id="qc" />
          <h2 className={h2}>10. QC, attempts &amp; approval</h2>
          <p className={p}>
            Generating media for a scene creates an <strong>attempt</strong> — a start frame, an end
            frame, and a video clip. Each attempt is automatically checked by QC, which reports
            pass/fail, a severity, and specific issues (continuity breaks, missing outputs, artifacts,
            etc.).
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>Regenerate</strong> to create a new attempt (attempt numbers increment; history is kept).</li>
            <li className={li}><strong>Approve</strong> the attempt you want to use — this marks the scene approved and selects that clip for assembly.</li>
          </ul>
        </section>

        {/* 9. Assembly */}
        <section className={card}>
          <Anchor id="assembly" />
          <h2 className={h2}>11. Assembly &amp; exports</h2>
          <p className={p}>
            Assembly builds a final-cut plan from your approved clips and produces a rough cut. The last
            scene&apos;s trim is applied automatically so the total runtime matches your request.
          </p>
          <p className={p}>The export package includes:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><code>storyboard.json</code> and <code>storyboard.md</code> — the full storyboard.</li>
            <li className={li}><code>generation-manifest.json</code> — per-scene status, chosen attempt, and media paths.</li>
            <li className={li}><code>animatic-plan.json</code> — the animatic (once generated).</li>
            <li className={li}><code>final-cut-plan.json</code> — the assembled cut plan (once assembled).</li>
          </ul>
          <p className={p}>
            Items appear as active links on the Assembly page once they are available.
          </p>
        </section>

        {/* 10. Deepy */}
        <section className={card}>
          <Anchor id="deepy" />
          <h2 className={h2}>12. Deepy assist</h2>
          <p className={p}>
            Deepy is an optional media helper. On the Assembly page you can &quot;Ask Deepy&quot; about a
            clip to inspect it, extract the final frame, transcribe audio, suggest why a generation
            struggled, or propose a regeneration prompt. When Deepy is disabled, responses are clearly
            labeled as simulated so the UI stays useful in demo mode.
          </p>
        </section>

        {/* 11. Flags */}
        <section className={card}>
          <Anchor id="flags" />
          <h2 className={h2}>13. Modes &amp; feature flags</h2>
          <p className={p}>
            Every external integration is off by default. An administrator can enable them via
            environment variables (see the project README and the <a href="/about" className="text-accent hover:underline">About</a> page for current status):
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>AI planning</strong> — use a real LLM for the agents (otherwise deterministic mocks).</li>
            <li className={li}><strong>WanGP MCP</strong> — connect to a live WanGP generation server.</li>
            <li className={li}><strong>Deepy assist</strong> — enable the real Deepy helper.</li>
            <li className={li}><strong>Animatic assembly</strong> — build a rough preview video for the animatic.</li>
            <li className={li}><strong>Platform derivatives</strong> — YouTube/Shorts/social output variants.</li>
            <li className={li}><strong>Persistence</strong> — in-memory (demo) or PostgreSQL for durable, shared storage.</li>
          </ul>
          <p className={p}>
            The <a href="/about" className="text-accent hover:underline">About</a> page always shows which flags are currently enabled.
          </p>
        </section>

        {/* 12. FAQ */}
        <section className={card}>
          <Anchor id="faq" />
          <h2 className={h2}>14. FAQ &amp; troubleshooting</h2>

          <h3 className={h3}>Why are all my scenes 20 seconds?</h3>
          <p className={p}>
            By design — equal-length segments keep generation consistent and continuity manageable.
            Clip length is configurable from 5 to 20 seconds per project.
            The final scene is trimmed so the finished video matches your requested duration.
          </p>

          <h3 className={h3}>My requested length isn&apos;t a multiple of 20. What happens?</h3>
          <p className={p}>
            The app rounds up the number of scenes and trims the last one. For 90 seconds you get 5
            scenes with the final clip trimmed by 10 seconds.
          </p>

          <h3 className={h3}>&quot;Generate media&quot; or &quot;Assemble&quot; is unavailable or errors.</h3>
          <p className={p}>
            Generate a storyboard first. Media generation needs scenes; assembly needs at least one
            approved (or generated) clip per scene.
          </p>

          <h3 className={h3}>The connection shows &quot;mock&quot; in the Generation Console.</h3>
          <p className={p}>
            That&apos;s expected in demo mode — the app is using the built-in mock backend. Enable the
            WanGP integration to connect to a real server.
          </p>

          <h3 className={h3}>Are my projects saved permanently?</h3>
          <p className={p}>
            In demo mode projects live in memory for the current server session. Switch persistence to
            PostgreSQL for durable, shared storage.
          </p>

          <h3 className={h3}>Can I edit an artifact after it&apos;s generated?</h3>
          <p className={p}>
            You can regenerate any artifact (storyboard, plans, variants, media) at any time. Approvals
            and history are preserved.
          </p>

          <h3 className={h3}>Where can I learn more?</h3>
          <p className={p}>
            See the project README and <code>docs/ARCHITECTURE.md</code> for design detail, and the
            <a href="/about" className="text-accent hover:underline"> About</a> page for licensing and
            configuration.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
