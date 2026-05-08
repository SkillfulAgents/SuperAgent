---
name: Superagent
version: 0.1.0
colors:
  background: "#ffffff"
  foreground: "#0a0a0a"
  card: "#ffffff"
  cardForeground: "#0a0a0a"
  popover: "#ffffff"
  popoverForeground: "#0a0a0a"
  primary: "#171717"
  primaryForeground: "#fafafa"
  secondary: "#f5f5f5"
  secondaryForeground: "#171717"
  muted: "#f5f5f5"
  mutedForeground: "#737373"
  accent: "#f5f5f5"
  accentForeground: "#171717"
  destructive: "#ef4444"
  destructiveForeground: "#fafafa"
  border: "#e5e5e5"
  input: "#e5e5e5"
  ring: "#0a0a0a"
  chart1: "#e8794a"
  chart2: "#2a9d8f"
  chart3: "#264653"
  chart4: "#e9c46a"
  chart5: "#f4a261"
colorsDark:
  background: "#0a0a0a"
  foreground: "#fafafa"
  card: "#0a0a0a"
  cardForeground: "#fafafa"
  popover: "#0a0a0a"
  popoverForeground: "#fafafa"
  primary: "#fafafa"
  primaryForeground: "#171717"
  secondary: "#262626"
  secondaryForeground: "#fafafa"
  muted: "#262626"
  mutedForeground: "#a3a3a3"
  accent: "#262626"
  accentForeground: "#fafafa"
  destructive: "#7f1d1d"
  destructiveForeground: "#fafafa"
  border: "#262626"
  input: "#262626"
  ring: "#d4d4d4"
  chart1: "#3b82f6"
  chart2: "#22c55e"
  chart3: "#f97316"
  chart4: "#a855f7"
  chart5: "#ec4899"
typography:
  fontFamilySans: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  fontFamilyMono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  text2xs:
    fontSize: 10px
    lineHeight: 14px
    fontWeight: 500
  textXs:
    fontSize: 11px
    lineHeight: 16px
    fontWeight: 400
  textSm:
    fontSize: 13px
    lineHeight: 20px
    fontWeight: 400
  textBase:
    fontSize: 15px
    lineHeight: 24px
    fontWeight: 400
  textLg:
    fontSize: 17px
    lineHeight: 28px
    fontWeight: 500
  h3:
    fontSize: 20px
    lineHeight: 28px
    fontWeight: 600
  h2:
    fontSize: 22px
    lineHeight: 32px
    fontWeight: 600
  h1:
    fontSize: 28px
    lineHeight: 36px
    fontWeight: 600
spacing:
  px: 1px
  "0_5": 2px
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "10": 40px
  "12": 48px
  "16": 64px
rounded:
  none: 0
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  full: 9999px
elevation:
  none: "none"
  sm: "0 1px 2px rgba(0,0,0,0.04)"
  md: "0 4px 12px rgba(0,0,0,0.06)"
  lg: "0 12px 32px rgba(0,0,0,0.10)"
components:
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.cardForeground}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
    padding: "{spacing.6}"
  buttonPrimary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primaryForeground}"
    rounded: "{rounded.md}"
    padding: "{spacing.2} {spacing.4}"
    typography: "{typography.textSm}"
    fontWeight: 500
  buttonSecondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondaryForeground}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.md}"
    padding: "{spacing.2} {spacing.4}"
    typography: "{typography.textSm}"
    fontWeight: 500
  badge:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.mutedForeground}"
    rounded: "{rounded.sm}"
    padding: "{spacing.0_5} {spacing.2}"
    typography: "{typography.text2xs}"
    fontWeight: 500
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.input}"
    rounded: "{rounded.md}"
    padding: "{spacing.2} {spacing.3}"
    typography: "{typography.textSm}"
---

## Overview

Superagent dashboards live inside the Superagent desktop and web app. They render through an iframe alongside the host UI, so they must feel like a continuous extension of it — not like a third-party widget pasted in.

The visual language is **quiet, dense, and content-first**. We borrow from shadcn/ui: a near-monochrome neutral palette, restrained accent use, generous whitespace at the macro level, tight spacing at the micro level, and minimal chrome. Color is reserved for data and status — it is never decorative.

## Colors

The palette is **two grayscale ramps with a small accent set**. There is one neutral primary (near-black in light mode, near-white in dark) and a single destructive red. Anything else is data color from the chart palette.

- **Background / Foreground** — page surface and primary text. Light mode is pure white on near-black; dark mode is near-black on near-white. Never use a tinted gray for the background.
- **Card** — slightly differentiated surface for grouped content. In practice equal to background, separated by a 1px border instead of a fill.
- **Primary** — used sparingly: the main CTA, active nav state, focus ring. Do not use it for body text — that's `foreground`.
- **Muted / Muted-foreground** — secondary surfaces (table headers, chip backgrounds) and secondary text (timestamps, helper copy, axis labels).
- **Border** — every divider, every card edge, every input outline. One color, applied liberally.
- **Destructive** — error states, destructive confirmations only. Never for general "important" highlighting.
- **Chart 1–5** — the only colors permitted in data visualizations. Use them in order; do not introduce additional hues.

**Dark mode is required.** Every dashboard must respond to `prefers-color-scheme: dark`. The `colorsDark` token group is the dark equivalent. Build with CSS custom properties that swap on `@media (prefers-color-scheme: dark)` so no JS toggle is needed.

## Typography

Single sans-serif family: **Inter**, falling through system fonts. Monospace only inside `code`/`pre`.

- **Type scale is unusually small** — `base` is 15px, `sm` is 13px, table/label text is often `xs` (11px). Reach for smaller sizes than you would on a marketing site; this is a dense product surface.
- **Headings are medium weight (500–600)**, never bold (700+). Visual hierarchy comes from size and color, not weight.
- **Numbers in tables and KPIs should use `font-variant-numeric: tabular-nums`** so columns align.

## Layout & Spacing

Spacing tokens follow a 4px base scale (`spacing.1` = 4px). Inside a component, prefer 8/12/16px (`spacing.2` / `3` / `4`). Between sections, prefer 24/32px (`spacing.6` / `8`). Page-level outer padding is 24px on small viewports, 32px on wide.

- **Dashboards typically use a 12-column responsive grid** with 16–24px gutters. KPI cards are 3- or 4-up at desktop, stacking to 1-up on narrow.
- **Use CSS Grid for layout, Flex for component internals.**
- **Never set fixed pixel widths on top-level containers.** The iframe width is variable — assume anywhere from 600px to 1600px.

## Elevation & Depth

This is a **flat design system**. Default to `elevation.none` and rely on borders for separation. Use `elevation.sm` only for floating elements (popovers, dropdowns), `elevation.md` for modals. Never apply elevation to in-flow cards.

## Shapes

`rounded.md` (6px) is the default — buttons, inputs, badges. `rounded.lg` (8px) for cards and panels. `rounded.full` for avatars and pill chips only. Square corners (0px) are reserved for inline indicators that touch an edge.

## Components

The token block defines canonical recipes (`card`, `buttonPrimary`, `buttonSecondary`, `badge`, `input`). When building a new component:

1. Check whether one of the recipes already covers it. If so, use those tokens verbatim.
2. If not, compose from primitive tokens (colors, spacing, rounded). Do not invent new values.
3. If a value seems missing (e.g., a warning color), ask the user — do not improvise.

For data visualization, prefer **Recharts** or **uPlot** over Chart.js — they ship cleaner defaults that match this aesthetic. Always pass `chart1`–`chart5` as the explicit color array; never use library defaults.

## Do's and Don'ts

**Do:**
- Use `var(--color-*)` from `tokens.css` for every color — never hex literals in component code.
- Respect `prefers-color-scheme: dark`.
- Use borders, not shadows, to separate cards.
- Keep accent color usage to one or two elements per screen.

**Don't:**
- Don't introduce gradients, glassmorphism, or decorative shadows.
- Don't use bold (700+) for headings.
- Don't hardcode pixel widths on top-level layout.
- Don't add a sixth chart color — if you need more series, group/stack instead.
- Don't add a CSS framework (Tailwind, Bootstrap, MUI). The token CSS is the framework.

## Per-Dashboard Overrides

A dashboard may override the system identity by editing its own local `DESIGN.md` (copied into the dashboard at scaffold time). Edit the YAML token values to taste, then update `tokens.css` to match — they must stay in sync. Prose sections may be edited or extended to capture dashboard-specific guidance (e.g., "this dashboard uses red for alerts because…"). The system-level DESIGN.md at `~/.claude/skills/dashboards/DESIGN.md` remains the default for any dashboard that does not ship its own.
