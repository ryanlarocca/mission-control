import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Navy "Signal" skin (2026-11-10). The app's greys are hand-written
        // zinc-* classes; remapping the scale here re-skins every one of them.
        zinc: {
          50: "#f4f7fc",
          100: "#e6edf7",
          200: "#d9e0ef",
          300: "#c3cce0",
          400: "#9aa6c0",
          500: "#7d8aa6",
          600: "#5a698d",
          700: "#2a3757",
          800: "#1d2840",
          900: "#101829",
          950: "#0a0f1e",
        },
        // Named tokens for new screens (Today, nav, Hopper).
        signal: {
          bg: "#0a0f1e",
          card: "#101829",
          card2: "#131d33",
          border: "#1d2840",
          ink: "#e6edf7",
          muted: "#7d8aa6",
          accent: "#2dd4bf",
          warn: "#fab219",
          bad: "#f05252",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      fontFamily: {
        // Numbers: monospace, use with `tabular-nums`.
        num: ["ui-monospace", '"SF Mono"', "Menlo", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
}
export default config
