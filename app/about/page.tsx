import { AppShell } from "@/components/shell/app-shell";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * About / Settings page. Includes the required WanGP disclosure (spec Section 25)
 * and shows the current feature-flag configuration.
 */
export default function AboutPage() {
  const flags: Array<[string, boolean]> = [
    ["AI planning", config.flags.aiPlanning],
    ["WanGP MCP", config.flags.wangpMcp],
    ["Deepy assist", config.flags.deepyAssist],
    ["Animatic assembly", config.flags.animaticAssembly],
    ["Platform derivatives", config.flags.platformDerivatives],
  ];

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">About StoryForgeAI</h1>
          <p className="mt-1 text-sm text-slate-400">
            A local-first agentic creative studio for storyboard-driven video generation.
          </p>
        </div>

        <section className="rounded-lg border border-white/10 bg-panel/40 p-4 text-sm text-slate-300">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Who made this
          </h2>
          <p className="mt-2">
            StoryForgeAI is designed and built by{" "}
            <a
              href="https://www.jabaisolutions.com/"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              JabAI Solutions
            </a>
            , an AI consulting and development company.
          </p>
        </section>

        <section className="rounded-lg border border-white/10 bg-panel/40 p-4 text-sm text-slate-300">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Using StoryForgeAI
          </h2>
          <p className="mt-2">
            The source is published openly, and you are welcome to run it, study it, modify it and
            share your changes for personal, educational and other non-commercial purposes.
          </p>
          <p className="mt-2">
            <strong className="text-slate-200">Commercial use is by arrangement.</strong> If you
            want to sell it, build a paid product or service on it, or use it inside a commercial
            offering, please contact JabAI Solutions first. The intent is not to block you — it is
            to have the conversation.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Video you generate with StoryForgeAI is yours. This applies to the application, not to
            its output — though the models you generate with carry their own terms; see the
            disclosure above.
          </p>
        </section>

        <section className="rounded-lg border border-white/10 bg-panel/40 p-4 text-sm text-slate-300">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Disclosure</h2>
          <p className="mt-2">
            This application integrates with WanGP/Wan2GP as a local media generation backend.
            WanGP is developed by DeepBeepMeep and is subject to its own license and terms. Review
            the license for each model used inside WanGP, as individual models and checkpoints can
            carry separate commercial-use restrictions.
          </p>
        </section>

        <section className="rounded-lg border border-white/10 bg-panel/40 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Feature flags
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {flags.map(([name, on]) => (
              <li key={name} className="flex items-center justify-between">
                <span>{name}</span>
                <span className={on ? "text-green-300" : "text-slate-500"}>
                  {on ? "enabled" : "disabled"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            Mode: {config.persistence} persistence · WanGP {config.wangp.url}
          </p>
        </section>
      </div>
    </AppShell>
  );
}
