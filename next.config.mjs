/** @type {import('next').NextConfig} */
const nextConfig = {
  // Only for the container image. `next start` — how the Windows launcher runs
  // the app — refuses to serve a standalone build, so asking for one
  // unconditionally warned on every local start.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  // The e2e run points this elsewhere. `next start` loads a route's compiled
  // module the first time something asks for it, so a dev server rewriting the
  // same directory mid-session leaves the running app unable to find routes it
  // has not touched yet — media assets being the usual casualty, since nothing
  // requests them until the render finishes.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // Next 14 warned about cross-origin dev requests; Next 16 blocks them, which
  // stops the client bundle loading when the browser uses a different host name
  // than the dev server bound to. Dev-only — `next start` ignores it.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
