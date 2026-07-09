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
        accent: "#6366f1",
      },
    },
  },
  plugins: [],
};

export default config;
