import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StoryForgeAI",
  description: "Local-first agentic creative studio for storyboard-driven video generation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
