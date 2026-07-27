import Link from "next/link";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-white/10 bg-panel/60 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            StoryForge<span className="text-accent">AI</span>
          </Link>
          <nav className="flex gap-4 text-sm text-slate-300">
            <Link href="/" className="hover:text-white">
              New Project
            </Link>
            <Link href="/settings" className="hover:text-white">
              Settings
            </Link>
            <Link href="/help" className="hover:text-white">
              Help
            </Link>
            <Link href="/about" className="hover:text-white">
              About
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
