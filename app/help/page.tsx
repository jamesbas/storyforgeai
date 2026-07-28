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
          <DocList docs={ASPECT_RATIO_DOCS} />

          <h3 className={h3}>Style</h3>
          <p className={p}>
            The visual look. This one reaches generation directly: it is appended to every start and
            end frame prompt and to every video prompt as{" "}
            <code>&quot;&lt;style&gt; style, &lt;tone&gt; mood&quot;</code>. Pick <em>Custom…</em> to
            type your own wording — it is used verbatim.
          </p>
          <OptionList options={STYLE_PRESETS} />

          <h3 className={h3}>Tone</h3>
          <p className={p}>
            The emotional register. Also appended to every image and video prompt, and additionally
            used to write the music cue prompts and the narrator voice profile.
          </p>
          <OptionList options={TONE_PRESETS} />

          <h3 className={h3}>Audience</h3>
          <p className={p}>
            Who the piece is for. Shapes vocabulary, pacing and content limits in the creative brief
            and the story arc, and is carried into the frame prompts so the framing suits the viewer.
          </p>
          <OptionList options={AUDIENCE_PRESETS} />

          <h3 className={h3}>Resolution</h3>
          <DocList docs={RESOLUTION_DOCS} />

          <h3 className={h3}>Creative mode</h3>
          <DocList docs={CREATIVE_MODE_DOCS} />

          <h3 className={h3}>Generation mode</h3>
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
              <strong>Reference image</strong> — an optional picture. It is sent to the generation
              backend as reference input for the start and end frames, so the render is conditioned
              on the actual likeness rather than only the words. Requires an image model that accepts
              reference images; if the pinned model cannot, StoryForgeAI substitutes one that can.
            </li>
          </ul>

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
              Open <strong>New Project</strong> (the home page). Enter a concept and a duration, then
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
            <li className={li}><strong>New Project</strong> — describe the idea and settings.</li>
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

          <h3 className={h3}>New Project (home)</h3>
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
            . Also lists your recent projects. Submitting creates the project and opens its
            storyboard.
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
