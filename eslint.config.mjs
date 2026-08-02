import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * Flat config, replacing `.eslintrc.json` + `next lint` (removed in Next 16).
 *
 * `next lint` linted only the source directories it knew about; `eslint .`
 * walks the whole tree, so build output has to be excluded explicitly or
 * generated webpack chunks get linted.
 */
export default defineConfig([
  globalIgnores([
    ".next/",
    ".next-e2e/",
    "out/",
    "build/",
    "coverage/",
    "playwright-report/",
    "test-results/",
    "projects/",
    "next-env.d.ts",
  ]),
  {
    extends: [...nextCoreWebVitals],
    rules: {
      // New in eslint-config-next 16, and it fires on the load-on-mount effect
      // every screen uses. Clearing it is a data-loading refactor, which does
      // not belong in a dependency upgrade.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);