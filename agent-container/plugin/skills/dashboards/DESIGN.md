---
name: Gamut
version: 0.2.0
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
  ring: "#a3a3a3"
  chart1: "#e76e50"
  chart2: "#2a9d90"
  chart3: "#274754"
  chart4: "#e8c468"
  chart5: "#f4a462"
colorsDark:
  background: "#1a1a1a"
  foreground: "#fafafa"
  card: "#212121"
  cardForeground: "#fafafa"
  popover: "#262626"
  popoverForeground: "#fafafa"
  primary: "#fafafa"
  primaryForeground: "#171717"
  secondary: "#303030"
  secondaryForeground: "#fafafa"
  muted: "#303030"
  mutedForeground: "#a3a3a3"
  accent: "#303030"
  accentForeground: "#fafafa"
  destructive: "#e23636"
  destructiveForeground: "#fafafa"
  border: "#303030"
  input: "#303030"
  ring: "#737373"
  chart1: "#2662d9"
  chart2: "#2eb88a"
  chart3: "#e88c30"
  chart4: "#af57db"
  chart5: "#e23670"
typography:
  fontFamilySans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
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
    fontWeight: 500
  h2:
    fontSize: 22px
    lineHeight: 32px
    fontWeight: 500
  h1:
    fontSize: 28px
    lineHeight: 36px
    fontWeight: 500
  display:
    fontSize: 34px
    lineHeight: 42px
    fontWeight: 500
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

Dashboards render inside the Gamut app, so they should feel like a continuous extension of it rather than a third-party widget pasted in. The tokens above are the app's own theme.

The visual language is **quiet, dense, and content-first**: a near-monochrome neutral palette, restrained accent use, generous whitespace between sections, tight spacing inside components, and minimal chrome. Color is reserved for data and status; it is never decorative.

**Both dashboard scaffolds ship these tokens as `tokens.css`** (`src/tokens.css` in the React template, `tokens.css` beside `index.js` in a plain dashboard). Build with its `var(--color-*)`, `var(--space-*)`, `var(--text-*)`, `var(--radius-*)` variables and its `.sa-page`, `.sa-card`, `.sa-button` (`-primary` / `-secondary`), `.sa-badge` and `.sa-input` classes.

## Colors

The palette is **two grayscale ramps with a small accent set**: one neutral primary (near-black in light mode, near-white in dark) and a single destructive red. Anything else is data color from the chart palette.

- **Background / Foreground**: page surface and primary text. Never use a tinted gray for the background.
- **Card**: grouped content. Equal to the background in light mode and one step lighter in dark; either way the card's edge is a 1px border.
- **Primary**: used sparingly, for the main call to action and active states. Body text is `foreground`, not `primary`.
- **Muted / Muted-foreground**: secondary surfaces (table headers, chip backgrounds) and secondary text (timestamps, helper copy, axis labels).
- **Border**: every divider, card edge, and input outline. One color, applied liberally.
- **Destructive**: errors and destructive confirmations only, never general emphasis.
- **Chart 1–5**: the only colors for data visualization. Use them in order.

**Dark mode is required.** `tokens.css` swaps every color under `@media (prefers-color-scheme: dark)`, which follows the viewer's light/dark setting, so building on the variables is enough; no JS toggle is needed.

## Typography

One sans-serif stack (the system UI font). Monospace only inside `code` / `pre`. Don't load web fonts.

- **The type scale is small**: `base` is 15px, `sm` is 13px, and table and label text is often `xs` (11px). This is a dense product surface, not a marketing page.
- **Text never goes above Medium (500)**, the app's ceiling, headings included. Hierarchy comes from size and color, not weight.
- **Headline numbers** (KPIs) use `--text-display` or `--text-h1`, with the label in `muted-foreground` at `xs` or `sm`.
- **Numbers in tables and KPIs use `font-variant-numeric: tabular-nums`** so columns align (`tokens.css` sets it on tables).

## Layout & Spacing

Spacing follows a 4px scale (`--space-1` = 4px). Inside a component, prefer 8/12/16px (`--space-2` / `3` / `4`); between sections, 24/32px (`--space-6` / `8`). `.sa-page` provides the page padding (24px, 32px on wide screens) and section gap.

- **Use CSS Grid for layout, Flexbox for component internals.**
- **KPI cards** go 3- or 4-up on desktop and stack on narrow screens: `grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))`.
- **Never set fixed pixel widths on top-level containers.** A dashboard is shown at anything from phone width to a full desktop window.

## Elevation & Shapes

This is a **flat system**: separate in-flow cards with borders, not shadows. `--shadow-sm` is for floating elements (popovers, dropdowns) and `--shadow-md` for modals.

`--radius-md` (6px) is the default for buttons, inputs and badges; `--radius-lg` (8px) for cards and panels; `--radius-full` for avatars and pill chips only.

## Components

1. If a `.sa-*` class covers the element, use it.
2. If not, compose from the primitive variables. Don't invent new values.
3. If the system truly lacks something (a warning color, say), add one variable to `tokens.css` with light and dark values and use it, rather than an inline literal.

**Charts**: whichever library you use, pass `chart-1`…`chart-5` explicitly instead of the library's default palette. SVG libraries such as Recharts accept `var(--color-chart-1)` directly; canvas libraries such as Chart.js need the resolved value, `getComputedStyle(document.documentElement).getPropertyValue('--color-chart-1').trim()`, read again when the color scheme changes. Gridlines and axes use `border` and `muted-foreground`.

## Do's and Don'ts

**Do:**
- Use `var(--color-*)` for every color; no hex literals in component code.
- Use borders, not shadows, to separate cards.
- Keep accent color to one or two elements per screen.

**Don't:**
- Don't define a parallel set of variables (`--bg`, `--ink`, `--accent`…). Build on the existing ones and change their values if a dashboard needs its own identity.
- Don't introduce gradients, glassmorphism, or decorative shadows.
- Don't use weights above 500.
- Don't add a sixth chart color; group or stack series instead.
- Don't add a CSS framework (Tailwind, Bootstrap, MUI). `tokens.css` is the framework.
