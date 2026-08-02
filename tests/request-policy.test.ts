import { describe, it, expect } from "vitest";
import {
  evaluateRequest,
  isAllowedHost,
  parseAllowedHosts,
  type PolicyRequest,
} from "@/lib/security/request-policy";
import { bindConfigError, isLoopbackBind } from "@/lib/security/bind-policy.mjs";

const DEFAULT_ALLOWED = parseAllowedHosts("localhost,127.0.0.1,[::1]", "3200");

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    method: "POST",
    host: "localhost:3200",
    origin: null,
    secFetchSite: null,
    ...overrides,
  };
}

/**
 * The Host check is what closes DNS rebinding: once an attacker's domain
 * re-resolves to 127.0.0.1 the browser treats it as same-origin, CORS stops
 * applying, and the Host header is the only thing left that still differs.
 */
describe("host allowlisting", () => {
  it("accepts each default host with and without the port", () => {
    for (const host of ["localhost", "localhost:3200", "127.0.0.1", "127.0.0.1:3200"]) {
      expect(isAllowedHost(host, DEFAULT_ALLOWED), host).toBe(true);
    }
  });

  it("accepts bracketed IPv6 loopback, ported or not", () => {
    expect(isAllowedHost("[::1]", DEFAULT_ALLOWED)).toBe(true);
    expect(isAllowedHost("[::1]:3200", DEFAULT_ALLOWED)).toBe(true);
  });

  it("ignores case, because Host is case-insensitive", () => {
    expect(isAllowedHost("LocalHost:3200", DEFAULT_ALLOWED)).toBe(true);
  });

  it("rejects a rebinding attacker's domain", () => {
    expect(isAllowedHost("evil.example.com", DEFAULT_ALLOWED)).toBe(false);
    expect(isAllowedHost("evil.example.com:3200", DEFAULT_ALLOWED)).toBe(false);
  });

  it("rejects a missing or empty Host", () => {
    expect(isAllowedHost(null, DEFAULT_ALLOWED)).toBe(false);
    expect(isAllowedHost("   ", DEFAULT_ALLOWED)).toBe(false);
  });

  it("does not treat a LAN address as loopback just because loopback is allowed", () => {
    expect(isAllowedHost("192.168.1.20:3200", DEFAULT_ALLOWED)).toBe(false);
  });

  it("admits a configured tailnet name on either form", () => {
    const allowed = parseAllowedHosts("localhost,box.tailnet.ts.net", "3200");
    expect(isAllowedHost("box.tailnet.ts.net", allowed)).toBe(true);
    expect(isAllowedHost("box.tailnet.ts.net:3200", allowed)).toBe(true);
  });

  it("keeps an explicitly ported entry from also matching other ports", () => {
    const allowed = parseAllowedHosts("box.tailnet.ts.net:3200", "3200");
    expect(isAllowedHost("box.tailnet.ts.net:3200", allowed)).toBe(true);
    expect(isAllowedHost("box.tailnet.ts.net:9999", allowed)).toBe(false);
  });

  it("skips blank entries in the allowlist", () => {
    expect(parseAllowedHosts("localhost, ,127.0.0.1", "3200").has("")).toBe(false);
  });
});

describe("cross-site mutation policy", () => {
  it("serves safe methods regardless of where they came from", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const verdict = evaluateRequest(
        request({ method, secFetchSite: "cross-site", origin: "https://evil.example.com" }),
        DEFAULT_ALLOWED,
      );
      expect(verdict.allowed, method).toBe(true);
    }
  });

  it("rejects every unsafe method when Sec-Fetch-Site says cross-site", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const verdict = evaluateRequest(
        request({ method, secFetchSite: "cross-site" }),
        DEFAULT_ALLOWED,
      );
      expect(verdict, method).toEqual({ allowed: false, reason: "cross_site" });
    }
  });

  it("rejects same-site, because a sibling tailnet host is not this app", () => {
    expect(evaluateRequest(request({ secFetchSite: "same-site" }), DEFAULT_ALLOWED)).toEqual({
      allowed: false,
      reason: "cross_site",
    });
  });

  it("allows same-origin", () => {
    expect(
      evaluateRequest(request({ secFetchSite: "same-origin" }), DEFAULT_ALLOWED).allowed,
    ).toBe(true);
  });

  it("allows Sec-Fetch-Site: none, which only a typed URL or bookmark produces", () => {
    expect(evaluateRequest(request({ secFetchSite: "none" }), DEFAULT_ALLOWED).allowed).toBe(true);
  });

  it("trusts Sec-Fetch-Site over a spoofed Origin", () => {
    // Origin is settable by a hostile page in some contexts; Sec-Fetch-Site is
    // a forbidden header name and is not.
    const verdict = evaluateRequest(
      request({ secFetchSite: "cross-site", origin: "http://localhost:3200" }),
      DEFAULT_ALLOWED,
    );
    expect(verdict).toEqual({ allowed: false, reason: "cross_site" });
  });

  it("falls back to Origin when Sec-Fetch-Site is absent", () => {
    expect(
      evaluateRequest(request({ origin: "http://localhost:3200" }), DEFAULT_ALLOWED).allowed,
    ).toBe(true);
    expect(evaluateRequest(request({ origin: "https://evil.example.com" }), DEFAULT_ALLOWED)).toEqual(
      { allowed: false, reason: "cross_site" },
    );
  });

  it("rejects an opaque Origin", () => {
    expect(evaluateRequest(request({ origin: "null" }), DEFAULT_ALLOWED)).toEqual({
      allowed: false,
      reason: "cross_site",
    });
  });

  it("rejects an unparseable Origin rather than ignoring it", () => {
    expect(evaluateRequest(request({ origin: "not a url" }), DEFAULT_ALLOWED)).toEqual({
      allowed: false,
      reason: "cross_site",
    });
  });

  it("allows a request carrying neither header, so CLI scripts keep working", () => {
    // `npm run smoke` and the wangp:* scripts are not browsers, and the attack
    // this guards against needs the operator's browser as its vehicle.
    expect(evaluateRequest(request(), DEFAULT_ALLOWED).allowed).toBe(true);
  });

  it("checks the host before the method, so a bad host fails as a host problem", () => {
    expect(
      evaluateRequest(
        request({ method: "GET", host: "evil.example.com", secFetchSite: "same-origin" }),
        DEFAULT_ALLOWED,
      ),
    ).toEqual({ allowed: false, reason: "host" });
  });
});

describe("bind configuration", () => {
  it("recognises the loopback forms", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackBind(host), host).toBe(true);
    }
  });

  it("does not mistake a wildcard or LAN bind for loopback", () => {
    for (const host of ["0.0.0.0", "192.168.1.20", "100.71.40.31", "::"]) {
      expect(isLoopbackBind(host), host).toBe(false);
    }
  });

  it("accepts a loopback bind with the default allowlist", () => {
    expect(bindConfigError("127.0.0.1", false)).toBeNull();
  });

  it("refuses a non-loopback bind while the allowlist is still the default", () => {
    const error = bindConfigError("0.0.0.0", false);
    expect(error).toContain("STORYFORGE_ALLOWED_HOSTS");
  });

  it("accepts a non-loopback bind once the allowlist is named deliberately", () => {
    expect(bindConfigError("100.71.40.31", true)).toBeNull();
  });
});
