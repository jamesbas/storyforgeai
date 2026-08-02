import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#0b0f17",
        panel: "#131a26",
        /**
         * Two accents, because one cannot do both jobs.
         *
         * Text needs to be light enough to clear 4.5:1 against the dark
         * background; a filled button needs to be dark enough for white text to
         * clear it too. Those pull in opposite directions and no single value
         * satisfies both. `DEFAULT` is for text, borders, rings and tints;
         * `solid` is for filled surfaces carrying white text.
         */
        accent: {
          DEFAULT: "#818cf8",
          solid: "#4f46e5",
        },
        /**
         * The stock slate-500/600 sit at 3.7-4.0:1 on these panels, which reads
         * as "quiet" but fails AA. Nudged up just far enough to pass while
         * keeping the steps distinguishable.
         */
        slate: {
          500: "#8b98ab",
          600: "#7c8a9e",
        },
      },
    },
  },
  plugins: [],
};

export default config;
