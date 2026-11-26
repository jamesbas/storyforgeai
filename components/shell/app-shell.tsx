"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { APP_VERSION } from "@/lib/version";

type NavItem = {
  href: string;
  label: string;
  /**
   * Routes that belong to this tab without living under its path. A storyboard
   * is a project screen, so the Projects tab has to stay lit while you are in
   * one — otherwise the header goes blank exactly when you most need to know
   * where you are and how to get back.
   */
  owns?: string[];
};

const NAV: NavItem[] = [
  {
    href: "/projects",
    label: "Projects",
    owns: [
      "/storyboard",
      "/variant-review",
      "/agentic-canvas",
      "/animatic",
      "/generation-console",
      "/assembly",
    ],
  },
  { href: "/projects/new", label: "New project" },
  { href: "/scheduler", label: "Scheduler" },
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
  { href: "/about", label: "About" },
];

const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/**
 * Whether the Scheduler is running, read once per navigation.
 *
 * Not polled: the header is on every screen, and a timer per screen would put
 * a request on a loop the operator never asked for. The Scheduler tab itself
 * polls while it is open.
 */
function useSchedulerRunning(pathname: string): boolean {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/scheduler?summary=1", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { state?: string };
        if (live) setRunning(body.state === "running");
      } catch {
        // The dot is a hint; a failed read leaves it off.
      }
    })();
    return () => {
      live = false;
    };
  }, [pathname]);
  return running;
}

/**
 * The single active tab, or none on the landing page.
 *
 * Longest match wins so `/projects/new` lights its own tab rather than the
 * Projects tab it nests under.
 */
function activeHref(pathname: string): string | undefined {
  return NAV.filter(
    (item) => under(pathname, item.href) || item.owns?.some((base) => under(pathname, base)),
  )
    .map((item) => item.href)
    .sort((a, b) => b.length - a.length)[0];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const active = activeHref(pathname);
  const schedulerRunning = useSchedulerRunning(pathname);

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="border-b border-white/10 bg-panel/60 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            StoryForge<span className="text-accent">AI</span>
          </Link>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-1 text-sm">
            {NAV.map((item) => {
              const isActive = item.href === active;
              const running = item.href === "/scheduler" && schedulerRunning;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={running ? `${item.label} — running` : undefined}
                  className={
                    isActive
                      ? "rounded-md bg-accent/15 px-3 py-1.5 font-medium text-white"
                      : "rounded-md px-3 py-1.5 text-slate-300 hover:bg-white/5 hover:text-white"
                  }
                >
                  {item.label}
                  {running && (
                    <span
                      aria-hidden
                      data-testid="scheduler-running-dot"
                      className="ml-1.5 inline-block h-2 w-2 rounded-full bg-emerald-400 align-middle"
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        {children}
      </main>
      <footer className="mt-8 border-t border-white/10 bg-panel/40">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-4 text-xs text-slate-400">
          <p>
            Designed and built by{" "}
            <a
              href="https://www.jabaisolutions.com/"
              target="_blank"
              rel="noreferrer"
              className="text-slate-300 underline underline-offset-2 hover:text-accent"
            >
              JabAI Solutions
            </a>
            <span className="ml-2 text-slate-500" data-testid="app-version">
              v{APP_VERSION}
            </span>
          </p>
          <p>
            Free to use — reselling needs a licence.{" "}
            <Link href="/about" className="hover:text-accent underline underline-offset-2">
              Licence
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
