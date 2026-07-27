import { AppShell } from "@/components/shell/app-shell";

export const metadata = {
  title: "Help · StoryForgeAI",
  description: "How to use StoryForgeAI, end to end.",
};

type Section = { id: string; title: string };

const TOC: Section[] = [
  { id: "overview", title: "1. What StoryForgeAI does" },
  { id: "concepts", title: "2. Key concepts" },
  { id: "quickstart", title: "3. Quick start" },
  { id: "workflow", title: "4. The end-to-end workflow" },
  { id: "pages", title: "5. Every screen explained" },
  { id: "agents", title: "6. The creative team (agents)" },
  { id: "wangp", title: "7. WanGP & generation" },
  { id: "qc", title: "8. QC, attempts & approval" },
  { id: "assembly", title: "9. Assembly & exports" },
  { id: "deepy", title: "10. Deepy assist" },
  { id: "flags", title: "11. Modes & feature flags" },
  { id: "faq", title: "12. FAQ & troubleshooting" },
];

function Anchor({ id }: { id: string }) {
  return <span id={id} className="block -mt-24 pt-24" aria-hidden />;
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

        {/* 3. Quick start */}
        <section className={card}>
          <Anchor id="quickstart" />
          <h2 className={h2}>3. Quick start</h2>
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

        {/* 4. Workflow */}
        <section className={card}>
          <Anchor id="workflow" />
          <h2 className={h2}>4. The end-to-end workflow</h2>
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

        {/* 5. Pages */}
        <section className={card}>
          <Anchor id="pages" />
          <h2 className={h2}>5. Every screen explained</h2>

          <h3 className={h3}>New Project (home)</h3>
          <p className={p}>
            Collects your concept, duration, aspect ratio, resolution, style, tone, audience, creative
            mode, generation mode, and toggles for narration, dialogue, music, and SFX. Also lists your
            recent projects. Submitting creates the project and opens its storyboard.
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

        {/* 6. Agents */}
        <section className={card}>
          <Anchor id="agents" />
          <h2 className={h2}>6. The creative team (agents)</h2>
          <p className={p}>Each agent produces one artifact you can review and regenerate:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li className={li}><strong>Intake Producer</strong> — turns your idea into a structured creative brief.</li>
            <li className={li}><strong>Story Architect</strong> — builds the narrative arc, one beat per 20s segment.</li>
            <li className={li}><strong>Variant Explorer</strong> — proposes multiple creative directions.</li>
            <li className={li}><strong>World Builder</strong> — a World Bible: premise, rules, locations, motifs, continuity constraints.</li>
            <li className={li}><strong>Director</strong> — creative thesis, pacing, emotional arc, and per-scene intent.</li>
            <li className={li}><strong>Cinematographer</strong> — camera language, framing, movement, lighting, and transitions.</li>
            <li className={li}><strong>Art Director</strong> — production design, wardrobe, props, set dressing, typography.</li>
            <li className={li}><strong>Visual Bible</strong> — continuity rules that keep every image and clip consistent.</li>
            <li className={li}><strong>Storyboard Artist</strong> — one scene card per 20s segment.</li>
            <li className={li}><strong>Image &amp; Video Prompt Engineers</strong> — start/end frame prompts and the 20s motion prompt.</li>
            <li className={li}><strong>Audio Director</strong> — narration, dialogue, music, SFX, and voice profiles.</li>
            <li className={li}><strong>WanGP Producer</strong> — selects models and builds valid generation settings.</li>
            <li className={li}><strong>Creative Critic / QC</strong> — reviews generated media and flags issues with regeneration notes.</li>
          </ul>
        </section>

        {/* 7. WanGP */}
        <section className={card}>
          <Anchor id="wangp" />
          <h2 className={h2}>7. WanGP &amp; generation</h2>
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
          <h2 className={h2}>8. QC, attempts &amp; approval</h2>
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
          <h2 className={h2}>9. Assembly &amp; exports</h2>
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
          <h2 className={h2}>10. Deepy assist</h2>
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
          <h2 className={h2}>11. Modes &amp; feature flags</h2>
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
          <h2 className={h2}>12. FAQ &amp; troubleshooting</h2>

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
