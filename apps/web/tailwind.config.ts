import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#172033",
        muted: "#64748b",
        line: "#dbe3ef",
        canvas: "#f5f7fb"
      }
    }
  },
  plugins: []
} satisfies Config;
