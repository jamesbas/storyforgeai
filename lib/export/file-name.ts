/**
 * What a file produced by this app is called once it reaches a person.
 *
 * Every project exported as `storyboard.json`, so two of them in the same
 * folder were indistinguishable and the second silently became
 * `storyboard (1).json`. Assembled cuts had the same problem in a worse place:
 * they were all `rough-cut.mp4`, and the download header is built from the
 * file's own basename.
 *
 * The name is also part of a response header, which makes a project title an
 * untrusted input in a place that looks like presentation. A title carrying a
 * quote would end the quoted value early, and one carrying CR/LF could start a
 * header of its own — so control characters and the separators Windows and
 * POSIX reserve are removed rather than escaped.
 */

/** Characters no filesystem will take, plus the ones that would break a header. */
const UNSAFE = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;

/** Long enough for any real title, short enough to survive a path limit. */
const MAX_TITLE = 80;

function titlePart(title: string | undefined): string {
  const cleaned = (title ?? "")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE)
    .trim()
    // A name of dots is a directory entry, and a trailing dot is dropped by
    // Windows, which would leave the extension attached to nothing.
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned;
}

/** `storyboard-Swing Deep.json`, or `storyboard.json` when there is no title. */
export function exportFileName(base: string, title: string | undefined, extension: string): string {
  const part = titlePart(title);
  return part ? `${base}-${part}.${extension}` : `${base}.${extension}`;
}

/** `2026-09-22-1005`, in local time, because it is read by the person who made it. */
function timestampPart(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
    `${pad(at.getHours())}${pad(at.getMinutes())}`,
  ].join("-");
}

/**
 * What an assembled cut is called on disk.
 *
 * Every project's cut was `rough-cut.mp4`, so a folder of finished pieces was a
 * row of identical names — and because the download header is built from the
 * file's own basename, that is what landed in the browser too.
 *
 * The kind is part of the name rather than a suffix on the title because the
 * scored cut sits in the same folder as the unscored one: without it the second
 * would overwrite the first. The timestamp makes a re-assembly distinguishable
 * from the cut it replaces, which matters when one is already downloaded.
 */
export function cutFileName(
  title: string | undefined,
  kind: "rough-cut" | "final-cut",
  at: Date,
): string {
  const part = titlePart(title);
  const stamp = timestampPart(at);
  return part ? `${part}-${stamp}-${kind}.mp4` : `${stamp}-${kind}.mp4`;
}

/**
 * A `Content-Disposition` value carrying both forms of the name.
 *
 * `filename` has to be ASCII, so an accented or em-dashed title is transcribed
 * for it and sent intact in `filename*` (RFC 5987), which every current browser
 * prefers.
 */
export function exportContentDisposition(
  base: string,
  title: string | undefined,
  extension: string,
): string {
  const name = exportFileName(base, title, extension);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
