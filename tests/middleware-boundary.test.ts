import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config as middlewareConfig } from "@/middleware";

/**
 * The routes checked here take no request body at all, which makes them the
 * strongest vector: a cross-origin HTML form POST is a simple request, so it is
 * sent without a CORS preflight and the side effect happens whether or not the
 * attacker can read the response.
 */
const BODYLESS_MUTATING_ROUTES = [
  "/api/llm/unload",
  "/api/llm/load",
  "/api/projects/p1/assemble",
  "/api/projects/p1/generate-storyboard",
  "/api/projects/p1/duplicate",
  "/api/projects/p1/scenes/s1/generate",
];

function call(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "localhost:3200", ...init.headers });
  return middleware(
    new NextRequest(`http://localhost:3200${path}`, { method: init.method ?? "POST", headers }),
  );
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("the middleware boundary", () => {
  it("rejects a cross-site form POST to every body-less mutating route", () => {
    for (const path of BODYLESS_MUTATING_ROUTES) {
      // What an auto-submitting <form> on a hostile page actually sends.
      const response = call(path, {
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          origin: "https://evil.example.com",
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      expect(response.status, path).toBe(403);
    }
  });

  it("still serves those routes to the app's own UI", () => {
    for (const path of BODYLESS_MUTATING_ROUTES) {
      const response = call(path, {
        headers: { "sec-fetch-site": "same-origin", origin: "http://localhost:3200" },
      });
      expect(response.status, path).toBe(200);
    }
  });

  it("rejects a rebound host even on a plain read", () => {
    const response = call("/api/projects", {
      method: "GET",
      headers: { host: "evil.example.com", "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(403);
  });

  it("does not echo the offending host or origin", async () => {
    const response = call("/api/projects", {
      headers: { host: "rebound.example.com", origin: "https://evil.example.com" },
    });
    const body = await response.text();
    expect(body).not.toContain("rebound.example.com");
    expect(body).not.toContain("evil.example.com");
    expect(body).toBe("Forbidden");
  });

  it("logs a denial without the offending header value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    call("/api/projects/p1/assemble", {
      headers: { host: "rebound.example.com", origin: "https://evil.example.com" },
    });
    const logged = String(warn.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("access.denied");
    expect(logged).not.toContain("rebound.example.com");
    expect(logged).not.toContain("evil.example.com");
  });

  it("lets a CLI request through, since it carries neither browser header", () => {
    expect(call("/api/projects", { method: "POST" }).status).toBe(200);
  });

  it("leaves static build output out of scope", () => {
    // Next anchors matcher patterns; a bare RegExp would match anywhere.
    const matcher = new RegExp(`^${middlewareConfig.matcher[0]}$`);
    expect(matcher.test("/_next/static/chunk.js")).toBe(false);
    expect(matcher.test("/favicon.ico")).toBe(false);
    expect(matcher.test("/api/projects")).toBe(true);
    // Media reads stay in scope: a rebinding attacker reading project output is
    // the case the host check exists for.
    expect(matcher.test("/api/media/p1/scene.mp4")).toBe(true);
  });
});
