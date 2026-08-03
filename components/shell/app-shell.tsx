"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
  { href: "/about", label: "About" },
];

const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

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
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={
                    isActive
                      ? "rounded-md bg-accent/15 px-3 py-1.5 font-medium text-white"
                      : "rounded-md px-3 py-1.5 text-slate-300 hover:bg-white/5 hover:text-white"
                  }
                >
                  {item.label}
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
