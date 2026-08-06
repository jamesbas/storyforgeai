# StoryForgeAI — repository instructions

## Release log (do this before every commit that is pushed)

The README carries a rolling update log so a user can tell which release they are
running. It is not optional bookkeeping — the footer version is what the app shows
them, so a commit that ships behaviour without bumping it makes the UI lie.

**Before committing and pushing any change that alters behaviour, the UI, or the
documented contract:**

1. Bump the version by **0.01** from the newest entry in the README's update log.
   The series starts at `1.00`; there is no minor/patch distinction, just an
   increment.
2. Add a row to the top of the `## Update log` table in [README.md](../README.md)
   with the new version, today's date (`YYYY-MM-DD`), and what changed. Write it
   for a user deciding whether to update — the problem it solves, not the files it
   touched.
3. **Keep only the five most recent rows.** Delete the oldest.
4. Add the **same row, word for word**, to the top of the table in
   [CHANGELOG.md](../CHANGELOG.md). Nothing is ever deleted from there — it is the
   permanent record, and it is the only reason trimming the README is safe.
5. Update `APP_VERSION` in [lib/version.ts](../lib/version.ts) to match. It is the
   single source for the footer, and it must never disagree with the top row of
   the log.
6. Sweep the rest of the README for anything the change has made untrue.

[tests/version.test.ts](../tests/version.test.ts) enforces all of this — including
that a row dropped from the README still exists in the changelog unchanged.

Skip the bump only for changes that alter nothing a user could observe — a typo in
a comment, a test-only refactor. When in doubt, bump.

## Verification before committing

Run all three and expect them clean:

```
npx vitest run
npm run typecheck
npm run lint
```

## Do not rebuild while a generation is running

The app is normally started with `run-storyforge-ai.bat`, which runs `next build`
then `next start`. A production server reads the prebuilt `.next` output, so
editing source is safe mid-generation — but `npm run build` rewrites `.next`
underneath the live server and will break a batch that may be hours in.

Check first: `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`.
`vitest`, `tsc --noEmit` and `eslint` are always safe.
