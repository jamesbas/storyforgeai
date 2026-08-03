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
    ["Media prompt composer v2", config.flags.mediaPromptComposerV2],
    ["Durable tasks", config.flags.durableTasks],
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
              className="text-accent underline underline-offset-2"
            >
              JabAI Solutions
            </a>
            , an AI consulting and development company.
          </p>
        </section>

        <section className="rounded-lg border border-white/10 bg-panel/40 p-4 text-sm text-slate-300">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Licence
          </h2>
          <p className="mt-2">
            StoryForgeAI is released under the <strong>StoryForgeAI Community License 1.0</strong>,
            modelled on and deliberately aligned with the{" "}
            <a
              href="https://github.com/deepbeepmeep/Wan2GP/blob/main/LICENSE.txt"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2"
            >
              WanGP Community License 2.0
            </a>
            . StoryForgeAI exists to drive WanGP, so it would be unhelpful for the two to grant
            rights on different terms.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              <strong className="text-slate-200">Free to use, including inside a company.</strong>{" "}
              Personal, hobby, research, educational, internal business, studio, agency and client
              work are all covered. Modify it, deploy it privately, share it free of charge.
            </li>
            <li>
              <strong className="text-slate-200">The video you make is yours.</strong> Sell it,
              licence it, publish it. Credit — &ldquo;Made with StoryForgeAI&rdquo; — is asked for
              only when you sell an output directly, not for client work or free publication.
            </li>
            <li>
              <strong className="text-slate-200">Charge for your own labour.</strong> Installation,
              customisation, consulting, support and integration work are all fine, as long as you
              are not charging for access to the software itself.
            </li>
            <li>
              <strong className="text-slate-200">Selling the software needs a conversation.</strong>{" "}
              Reselling it, white-labelling it, embedding it in a paid product, or offering paid
              API/SaaS/hosted access requires a separate written licence from JabAI Solutions.
            </li>
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            If you commercialise a service built on StoryForgeAI you will likely need a commercial
            licence from the WanGP authors as well — exposing WanGP to third parties for
            consideration is restricted under their terms, and complying with ours does not satisfy
            theirs.
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
          <p className="mt-2">
            StoryForgeAI is an independent project and is{" "}
            <strong className="text-slate-200">not affiliated with, endorsed by, or sponsored by</strong>{" "}
            the WanGP/Wan2GP project or its authors. References to WanGP, Wan2GP and model names
            describe compatibility only. Get WanGP from its{" "}
            <a
              href="https://github.com/deepbeepmeep/Wan2GP"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2"
            >
              official repository
            </a>
            .
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
