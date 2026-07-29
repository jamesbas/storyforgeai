/** @type {import('next').NextConfig} */
const nextConfig = {
  // Only for the container image. `next start` — how the Windows launcher runs
  // the app — refuses to serve a standalone build, so asking for one
  // unconditionally warned on every local start.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  reactStrictMode: true,
};

export default nextConfig;
