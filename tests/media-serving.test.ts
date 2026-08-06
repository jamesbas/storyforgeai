import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  buildFilterConcatArgs,
  normalizeClips,
  parseResolution,
  probeDurationSeconds,
  probeMedia,
  runProcess,
  NativeFfmpegRunner,
  MockFfmpegRunner,
} from "@/lib/media/ffmpeg";
import { parseRangeHeader, contentTypeFor, streamFile } from "@/lib/media/streaming";
import { isPathInsideRoot, assertPathInsideRoots, MediaAccessError } from "@/lib/media/path-policy";
import { encodeMediaRef, parseMediaRef, mediaKindFor, listProjectMedia } from "@/lib/media/refs";
import { config } from "@/lib/config";
import type { ProjectRecord } from "@/lib/schemas/storyboard";

describe("path policy", () => {
  const root = path.resolve("C:/data/projects");

  it("accepts the root itself and paths beneath it", () => {
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(path.join(root, "p1", "a.mp4"), root)).toBe(true);
  });

  it("rejects traversal, siblings, and an empty root", () => {
    expect(isPathInsideRoot(path.join(root, "..", "secrets.env"), root)).toBe(false);
    expect(isPathInsideRoot(path.resolve("C:/data/projects-other/a.mp4"), root)).toBe(false);
    expect(isPathInsideRoot(root, "")).toBe(false);
  });

  it("throws for a path outside every approved root", () => {
    expect(() => assertPathInsideRoots(path.resolve("C:/windows/system32/config"), [root])).toThrow(
      MediaAccessError,
    );
  });

  it("throws when no root is configured", () => {
    expect(() => assertPathInsideRoots("anything", [])).toThrow(MediaAccessError);
  });

  it("allows a not-yet-written path inside the root", () => {
    const pending = path.join(root, "p1", "assembly", "rough-cut.mp4");
    expect(assertPathInsideRoots(pending, [root])).toBe(path.resolve(pending));
  });
});

describe("media refs", () => {
  it("round-trips a scene reference", () => {
    const id = encodeMediaRef({ kind: "scene", sceneId: "s-1", attemptId: "a-2", role: "video" });
    expect(id).toBe("scene~s-1~a-2~video");
    expect(parseMediaRef(id)).toEqual({
      kind: "scene",
      sceneId: "s-1",
      attemptId: "a-2",
      role: "video",
    });
  });

  it("round-trips cut references", () => {
    expect(parseMediaRef(encodeMediaRef({ kind: "rough_cut" }))).toEqual({ kind: "rough_cut" });
    expect(parseMediaRef(encodeMediaRef({ kind: "final_cut" }))).toEqual({ kind: "final_cut" });
  });

  it("rejects malformed, traversal, and unknown-role references", () => {
    expect(parseMediaRef("scene~s1~a1")).toBeNull();
    expect(parseMediaRef("scene~../../etc~a1~video")).toBeNull();
    expect(parseMediaRef("scene~s1~a1~audio")).toBeNull();
    expect(parseMediaRef("../../etc/passwd")).toBeNull();
    expect(parseMediaRef("scene~s1~a1~video~extra")).toBeNull();
  });

  it("classifies media kind by extension", () => {
    expect(mediaKindFor("/x/a.mp4")).toBe("video");
    expect(mediaKindFor("/x/a.MOV")).toBe("video");
    expect(mediaKindFor("/x/a.png")).toBe("image");
  });

  it("marks mock paths as unavailable so the UI does not render dead players", () => {
    const record = {
      project: { id: "p1" },
      storyboard: { scenes: [{ id: "s1", sceneNumber: 1 }] },
      attempts: {
        s1: [
          {
            id: "a1",
            approved: true,
            startImagePath: "/.wangp-mock/x.out",
            videoPath: "/.wangp-mock/y.out",
          },
        ],
      },
    } as unknown as ProjectRecord;

    // Mock paths sit outside every approved root, so they resolve to nothing.
    expect(listProjectMedia(record)).toEqual([]);
  });

  /**
   * Generating a clip for an already-approved scene forks a new attempt: same
   * frames, plus the clip, unapproved. Playing the approved attempt then showed
   * a scene with no clip while the card above it named the newer attempt and
   * printed the clip's path — so the take could not be watched before being
   * approved, which is the only reason to approve it.
   */
  it("plays the newest attempt, not an older approved one", () => {
    const inside = path.resolve(config.dataDir, "p1");
    const record = {
      project: { id: "p1" },
      storyboard: { scenes: [{ id: "s1", sceneNumber: 1 }] },
      attempts: {
        s1: [
          { id: "a1", approved: true, startImagePath: path.join(inside, "a.jpg") },
          {
            id: "a2",
            approved: false,
            startImagePath: path.join(inside, "a.jpg"),
            videoPath: path.join(inside, "b.mp4"),
          },
        ],
      },
    } as unknown as ProjectRecord;

    const media = listProjectMedia(record);
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((m) => m.attemptId === "a2")).toBe(true);
    expect(media.some((m) => m.role === "video")).toBe(true);
  });

  /**
   * A face swap, an imported frame and a carried-over start frame all replace an
   * attempt's image without opening a new attempt, so the asset id is unchanged.
   * When the URL was the id alone, nothing told the browser its `<img>` was out
   * of date and it went on showing the picture it had already painted — the new
   * image was on the record and invisible on the screen.
   */
  it("gives a replaced frame a different URL even though its asset id is unchanged", async () => {
    const inside = path.resolve(config.dataDir, "p1");
    await fs.mkdir(inside, { recursive: true });
    const before = path.join(inside, "rendered.png");
    const after = path.join(inside, "imported.png");
    await fs.writeFile(before, Buffer.alloc(64, 1));
    await fs.writeFile(after, Buffer.alloc(4096, 2));

    const at = (framePath: string) =>
      ({
        project: { id: "p1" },
        storyboard: { scenes: [{ id: "s1", sceneNumber: 1 }] },
        attempts: { s1: [{ id: "a1", approved: false, startImagePath: framePath }] },
      }) as unknown as ProjectRecord;

    const [original] = listProjectMedia(at(before));
    const [replaced] = listProjectMedia(at(after));

    expect(replaced!.assetId).toBe(original!.assetId);
    expect(replaced!.url).not.toBe(original!.url);
    expect(replaced!.downloadUrl).toMatch(/[?&]download=1$/);
    // The version rides on the query, so the route still parses the same ref.
    expect(parseMediaRef(original!.assetId)).not.toBeNull();

    await fs.rm(before, { force: true });
    await fs.rm(after, { force: true });
  });
});

describe("range parsing", () => {
  it("parses open-ended and closed ranges", () => {
    expect(parseRangeHeader("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader("bytes=100-199", 1000)).toEqual({ start: 100, end: 199 });
  });

  it("clamps an end beyond the file size", () => {
    expect(parseRangeHeader("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("supports the suffix form", () => {
    expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("rejects unsatisfiable and malformed ranges", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=500-100", 1000)).toBeNull();
    expect(parseRangeHeader("items=0-10", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=-", 1000)).toBeNull();
  });

  it("maps extensions to content types", () => {
    expect(contentTypeFor("a.mp4")).toBe("video/mp4");
    expect(contentTypeFor("a.PNG")).toBe("image/png");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
  });
});

describe("ffmpeg argument builders", () => {
  const opts = {
    width: 1280,
    height: 720,
    fps: 24,
    crf: 20,
    preset: "medium",
    audioSampleRate: 48000,
    audioChannelLayout: "stereo",
    audioCodec: "aac",
    audioBitrate: "192k",
  };

  it("normalizes string and object clip inputs", () => {
    expect(normalizeClips(["a.mp4", { path: "b.mp4", durationSeconds: 5 }])).toEqual([
      { path: "a.mp4" },
      { path: "b.mp4", durationSeconds: 5 },
    ]);
  });

  it("parses a resolution and falls back on garbage", () => {
    expect(parseResolution("1920x1080")).toEqual([1920, 1080]);
    expect(parseResolution("nonsense")).toEqual([1280, 720]);
  });

  it("builds a trimming, normalizing concat filter graph", () => {
    const args = buildFilterConcatArgs(
      [
        { path: "a.mp4", durationSeconds: 20 },
        { path: "b.mp4", durationSeconds: 12 },
      ],
      "out.mp4",
      opts,
    );
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[0:v]trim=0:20,");
    expect(filter).toContain("[1:v]trim=0:12,");
    expect(filter).toContain("scale=1280:720:force_original_aspect_ratio=decrease");
    expect(filter).toContain("fps=24");
    expect(filter).toContain("[v0][v1]concat=n=2:v=1:a=0[outv]");
    expect(args).toContain("-movflags");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("stays video-only when no clip has audio", () => {
    const args = buildFilterConcatArgs([{ path: "a.mp4", durationSeconds: 5 }], "out.mp4", opts);
    expect(args).not.toContain("-c:a");
    expect(args.filter((a) => a === "-map")).toHaveLength(1);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("a=0[outv]");
  });

  it("carries LTX-2 audio through the concat", () => {
    const args = buildFilterConcatArgs(
      [
        { path: "a.mp4", durationSeconds: 20, hasAudio: true },
        { path: "b.mp4", durationSeconds: 12, hasAudio: true },
      ],
      "out.mp4",
      opts,
    );
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[0:a]apad,atrim=0:20,");
    expect(filter).toContain("[1:a]apad,atrim=0:12,");
    expect(filter).toContain("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo");
    expect(filter).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]");
    expect(args).toContain("-c:a");
    expect(args).toContain("aac");
    expect(args).toContain("192k");
    expect(args.filter((a) => a === "-map")).toHaveLength(2);
  });

  it("pads a silent clip with anullsrc when mixed with audio clips", () => {
    const args = buildFilterConcatArgs(
      [
        { path: "withaudio.mp4", durationSeconds: 20, hasAudio: true },
        { path: "silent.mp4", durationSeconds: 12, hasAudio: false },
      ],
      "out.mp4",
      opts,
    );
    // The silence input is appended after the real inputs, so it takes index 2.
    expect(args).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    const silenceFlagIndex = args.indexOf("lavfi");
    expect(args[silenceFlagIndex + 1]).toBe("-t");
    expect(args[silenceFlagIndex + 2]).toBe("12");

    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[0:a]apad,atrim=0:20,");
    expect(filter).toContain("[2:a]apad,atrim=0:12,");
    expect(filter).toContain("concat=n=2:v=1:a=1[outv][outa]");
  });

  it("refuses to invent silence for a clip of unknown length", () => {
    expect(() =>
      buildFilterConcatArgs(
        [
          { path: "a.mp4", durationSeconds: 20, hasAudio: true },
          { path: "b.mp4", hasAudio: false },
        ],
        "out.mp4",
        opts,
      ),
    ).toThrow(/silence cannot be generated/);
  });

  it("omits the trim when a clip has no planned duration", () => {
    const args = buildFilterConcatArgs([{ path: "a.mp4" }], "out.mp4", {
      ...opts,
      width: 640,
      height: 360,
      fps: 30,
      crf: 18,
      preset: "fast",
    });
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("trim=");
  });

  it("refuses an empty clip list", () => {
    expect(() => buildFilterConcatArgs([], "out.mp4", opts)).toThrow(/No clips/);
  });

  it("mock runner still returns the output path", async () => {
    expect(await new MockFfmpegRunner().concat(["a.mp4"], "rough.mp4")).toBe("rough.mp4");
  });
});

/**
 * End-to-end ffmpeg check. Skipped automatically when ffmpeg is not installed,
 * so CI without ffmpeg stays green.
 */
const hasFfmpeg = await runProcess("ffmpeg", ["-version"], 15_000)
  .then((r) => r.code === 0)
  .catch(() => false);

describe.skipIf(!hasFfmpeg)("native ffmpeg runner (integration)", () => {
  let dir: string;
  const clips: string[] = [];
  /** Clip with an aac/48k/stereo track, mirroring WanGP LTX-2 output. */
  let audioClip = "";
  /** Clip with no audio track at all, mirroring an image-to-video model. */
  let silentClip = "";

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-ffmpeg-"));
    // Two synthetic clips with deliberately different sizes and frame rates,
    // which is what a copy-concat cannot handle.
    const sources = [
      { name: "a.mp4", size: "320x240", rate: "30", seconds: 3, color: "red" },
      { name: "b.mp4", size: "640x360", rate: "24", seconds: 3, color: "blue" },
    ];
    for (const source of sources) {
      const out = path.join(dir, source.name);
      const result = await runProcess(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${source.color}:s=${source.size}:r=${source.rate}:d=${source.seconds}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          out,
        ],
        120_000,
      );
      expect(result.code).toBe(0);
      clips.push(out);
    }

    audioClip = path.join(dir, "with-audio.mp4");
    const withAudio = await runProcess(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=512x288:r=24:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-shortest",
        audioClip,
      ],
      120_000,
    );
    expect(withAudio.code).toBe(0);
    silentClip = clips[0]!;
  }, 240_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("probes duration and stream layout", async () => {
    const withAudio = await probeMedia(audioClip);
    expect(withAudio?.hasAudio).toBe(true);
    expect(withAudio?.hasVideo).toBe(true);

    const silent = await probeMedia(silentClip);
    expect(silent?.hasAudio).toBe(false);
    expect(silent?.hasVideo).toBe(true);

    expect(await probeMedia(path.join(dir, "missing.mp4"))).toBeNull();
  });

  it("concatenates mixed-format clips and applies per-clip trims", async () => {
    const runner = new NativeFfmpegRunner();
    const output = path.join(dir, "nested", "rough-cut.mp4");

    await runner.concat(
      [
        { path: clips[0]!, durationSeconds: 2 },
        { path: clips[1]!, durationSeconds: 1 },
      ],
      output,
    );

    const stats = await fs.stat(output);
    expect(stats.size).toBeGreaterThan(0);

    const duration = await probeDurationSeconds(output);
    expect(duration).not.toBeNull();
    expect(duration!).toBeGreaterThan(2.5);
    expect(duration!).toBeLessThan(3.5);
  }, 180_000);

  it("preserves audio when every clip has a track", async () => {
    const runner = new NativeFfmpegRunner();
    const output = path.join(dir, "audio-cut.mp4");

    await runner.concat(
      [
        { path: audioClip, durationSeconds: 2 },
        { path: audioClip, durationSeconds: 2 },
      ],
      output,
    );

    const probe = await probeMedia(output);
    expect(probe?.hasAudio).toBe(true);
    expect(probe?.hasVideo).toBe(true);
    expect(probe!.durationSeconds!).toBeGreaterThan(3.5);
    expect(probe!.durationSeconds!).toBeLessThan(4.6);
  }, 180_000);

  it("fills silence for a soundless clip mixed with an audio clip", async () => {
    const runner = new NativeFfmpegRunner();
    const output = path.join(dir, "mixed-cut.mp4");

    // The runner probes each source, so hasAudio is discovered, not declared.
    await runner.concat(
      [
        { path: audioClip, durationSeconds: 2 },
        { path: silentClip, durationSeconds: 2 },
      ],
      output,
    );

    const probe = await probeMedia(output);
    expect(probe?.hasAudio).toBe(true);
    expect(probe!.durationSeconds!).toBeGreaterThan(3.5);
    expect(probe!.durationSeconds!).toBeLessThan(4.6);
  }, 180_000);

  it("clamps a planned duration that exceeds the source length", async () => {
    const runner = new NativeFfmpegRunner();
    const output = path.join(dir, "clamped.mp4");

    // The source is 4s but the plan asks for 20s; over-trimming would freeze.
    await runner.concat([{ path: audioClip, durationSeconds: 20 }], output);

    const duration = await probeDurationSeconds(output);
    expect(duration!).toBeLessThan(5);
  }, 180_000);

  it("trims an assembled cut to the requested runtime, keeping audio", async () => {
    const runner = new NativeFfmpegRunner();
    const source = path.join(dir, "for-trim.mp4");
    await runner.concat([{ path: audioClip, durationSeconds: 4 }], source);

    const trimmed = await runner.trim(source, path.join(dir, "final-cut.mp4"), 2);
    const probe = await probeMedia(trimmed);
    expect(probe!.durationSeconds!).toBeLessThan(3);
    expect(probe?.hasAudio).toBe(true);
  }, 180_000);

  it("streams a real file with a satisfiable range", async () => {
    const target = path.join(dir, "a.mp4");
    const size = (await fs.stat(target)).size;

    const full = await streamFile(target, new Request("http://localhost/x"));
    expect(full.status).toBe(200);
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.headers.get("Content-Type")).toBe("video/mp4");

    const partial = await streamFile(
      target,
      new Request("http://localhost/x", { headers: { range: "bytes=0-99" } }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Length")).toBe("100");
    expect(partial.headers.get("Content-Range")).toBe(`bytes 0-99/${size}`);
    expect((await partial.arrayBuffer()).byteLength).toBe(100);

    const bad = await streamFile(
      target,
      new Request("http://localhost/x", { headers: { range: `bytes=${size + 10}-` } }),
    );
    expect(bad.status).toBe(416);

    const download = await streamFile(target, new Request("http://localhost/x?download=1"));
    expect(download.headers.get("Content-Disposition")).toContain('attachment; filename="a.mp4"');
  });

  it("returns 404 for a missing file", async () => {
    const res = await streamFile(path.join(dir, "nope.mp4"), new Request("http://localhost/x"));
    expect(res.status).toBe(404);
  });
});
