"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { NewProjectForm } from "@/components/intake/new-project-form";
import type { CreateProjectInput } from "@/lib/schemas/intake";
import type { Project } from "@/lib/schemas/project";

export default function NewProjectPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (values: CreateProjectInput, references: File[]) => {
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Failed to create project");
        }
        const data = (await res.json()) as { project: Project };

        // The upload route is keyed by project id, so this cannot happen before
        // the project exists. A failure here leaves a created project with fewer
        // references than asked for, which is worth saying rather than hiding.
        for (const file of references) {
          const form = new FormData();
          form.append("file", file);
          form.append("kind", "reference");
          const upload = await fetch(`/api/projects/${data.project.id}/concept-images`, {
            method: "POST",
            body: form,
          });
          if (!upload.ok) {
            const body = (await upload.json().catch(() => ({}))) as { error?: string };
            throw new Error(
              `Project created, but ${file.name} did not upload: ${body.error ?? "unknown error"}. ` +
                "Add it from project settings.",
            );
          }
        }

        router.push(`/storyboard/${data.project.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create project");
        setSubmitting(false);
      }
    },
    [router],
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
          <Link href="/projects" className="hover:text-slate-300">
            Projects
          </Link>
          <span className="px-1.5">/</span>
          <span className="text-slate-400">New</span>
        </nav>

        <h1 className="mt-2 text-2xl font-semibold">New project</h1>
        <p className="mt-1 text-sm text-slate-400">
          Describe a concept and target duration. StoryForgeAI plans a storyboard in equal-length
          segments of 5 to 20 seconds. Everything here can be changed later —{" "}
          <Link href="/help#fields" className="text-accent underline underline-offset-2">
            the field reference
          </Link>{" "}
          explains each option.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="mt-6 rounded-lg border border-white/10 bg-panel/40 p-6">
          <NewProjectForm onSubmit={handleSubmit} submitting={submitting} />
        </div>
      </div>
    </AppShell>
  );
}
