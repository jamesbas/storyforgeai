/**
 * What an export is called once it reaches a downloads folder.
 *
 * Every project exported as `storyboard.json`, so two of them in the same
 * folder were indistinguishable and the second silently became
 * `storyboard (1).json`.
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
