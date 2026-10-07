---
name: AutoCom
description: Zero-touch order-to-cash automation for partner purchase orders
colors:
  deep-violet: "#7c3aed"
  deep-violet-dark: "#4c1d95"
  hot-pink: "#ec4899"
  hot-pink-hover: "#db2777"
  cyan-accent: "#22d3ee"
  bg-light: "#f6f5fb"
  surface-light: "#ffffff"
  surface-alt-light: "#f8f7fd"
  border-light: "#e7e3f5"
  border-strong-light: "#d4cdec"
  text-light: "#1c1730"
  text-muted-light: "#6b6483"
  text-faint-light: "#9891ac"
  bg-dark: "#0f0b1e"
  surface-dark: "#171227"
  surface-alt-dark: "#130f20"
  border-dark: "#2a2242"
  border-strong-dark: "#3c2f5e"
  text-dark: "#f1eefb"
  text-muted-dark: "#a89cc4"
  text-faint-dark: "#6f6690"
  hot-pink-dark-theme: "#f472b6"
  hot-pink-hover-dark-theme: "#f9a8d4"
  cyan-accent-dark-theme: "#67e8f9"
  status-success-bg-from: "#d6f5e3"
  status-success-bg-to: "#bdf0d3"
  status-success-text: "#0f7a4f"
  status-info-bg-from: "#ede4ff"
  status-info-bg-to: "#e0d3ff"
  status-info-text: "#6d28d9"
  status-warning-bg-from: "#fff0d6"
  status-warning-bg-to: "#ffe3b0"
  status-warning-text: "#b45309"
  status-danger-bg-from: "#ffe1ec"
  status-danger-bg-to: "#ffc9de"
  status-danger-text: "#be123c"
  status-neutral-bg: "#f1eefb"
  status-neutral-text: "#6b6483"
typography:
  display:
    fontFamily: "var(--font-display), var(--font-body), sans-serif"
    fontSize: "1.2rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
  title:
    fontFamily: "var(--font-display), var(--font-body), sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
  body:
    fontFamily: "var(--font-body), \"Segoe UI\", sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
  label:
    fontFamily: "var(--font-body), sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.03em"
rounded:
  sm: "11px"
  md: "16px"
  pill: "999px"
spacing:
  xs: "0.35rem"
  sm: "0.65rem"
  md: "1.25rem"
  lg: "1.75rem"
components:
  button-primary:
    backgroundColor: "linear-gradient({colors.deep-violet}, {colors.hot-pink})"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0.55rem 1.2rem"
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.sm}"
    padding: "0.55rem 1.2rem"
  card:
    backgroundColor: "{colors.surface-light}"
    rounded: "{rounded.md}"
    padding: "1.25rem"
  status-pill:
    backgroundColor: "{colors.status-neutral-bg}"
    textColor: "{colors.status-neutral-text}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.7rem"
---

# Design System: AutoCom

## Overview

**Creative North Star: "The Gradient Ops Desk"**

AutoCom's UI is an energetic, modern ops console for enterprise order automation. It replaces the sterile grays of a typical internal admin tool with a confident violet-to-pink brand gradient that signals "this is the future of order processing," while keeping tables, forms, and data-entry surfaces calm, dense, and legible for daily operational use. The topbar and primary actions carry the brand's boldness; the body of every page (cards, tables, inputs) stays quiet and neutral so operators can scan real data without visual noise.

Both a light and a dark theme are first-class (`data-theme="dark"` on `<html>`, user-selectable, defaulting to dark), with the branded topbar keeping fixed colors in both.

**Key Characteristics:**
- Bold, animated brand gradient (violet → pink → cyan) reserved for the topbar, brand mark, and primary buttons only.
- Calm, neutral surfaces (cards, tables, inputs) in both themes — brand color is the exception, not the rule.
- Soft layered elevation: flat at rest, lifting shadow on hover/interaction.
- Rounded, pill-shaped status badges as the primary state-communication device across orders/inventory.
- Full dark/light theme parity via CSS custom properties.

## Colors

The palette pairs a violet/pink brand gradient against quiet neutral surfaces, so color reads as "signal" (state, brand, action) rather than decoration.

### Primary
- **Deep Violet** (`#7c3aed`, dark: `#4c1d95`): topbar gradient start, order-number accents (light theme), primary button gradient start.

### Secondary
- **Hot Pink** (`#ec4899`, dark theme: `#f472b6`): brand-mark gradient, primary button gradient end, auth submit button, hover state `#db2777` / `#f9a8d4`.

### Tertiary
- **Cyan** (`#22d3ee`, dark theme: `#67e8f9`): brand-mark gradient third stop, order-number accent in dark theme only.

### Neutral
- **Background** (`#f6f5fb` light / `#0f0b1e` dark): page background.
- **Surface** (`#ffffff` light / `#171227` dark): cards, inputs, modals.
- **Surface Alt** (`#f8f7fd` light / `#130f20` dark): upload/dropzone background, hover backgrounds.
- **Border** (`#e7e3f5` light / `#2a2242` dark) / **Border Strong** (`#d4cdec` light / `#3c2f5e` dark): dividers, input borders.
- **Text** (`#1c1730` light / `#f1eefb` dark), **Text Muted** (`#6b6483` / `#a89cc4`), **Text Faint** (`#9891ac` / `#6f6690`).

### Status tones
Each status pill uses a two-stop gradient background with a matching dark text color: **success** (mint green `#d6f5e3→#bdf0d3`, text `#0f7a4f`), **info** (lavender `#ede4ff→#e0d3ff`, text `#6d28d9`), **warning** (amber `#fff0d6→#ffe3b0`, text `#b45309`), **danger** (rose `#ffe1ec→#ffc9de`, text `#be123c`), **neutral** (`#f1eefb`, text `#6b6483`).

### Named Rules
**The Gradient-Is-Signal Rule.** The animated brand gradient (violet/pink/cyan) appears only on the topbar, brand mark, and primary call-to-action buttons. Every other surface — cards, tables, inputs, modals — stays flat and neutral. If the gradient starts appearing on data surfaces, it has stopped meaning anything.

## Typography

**Display Font:** Space Grotesk (`var(--font-display)`), with Plus Jakarta Sans / system sans-serif fallback.
**Body Font:** Plus Jakarta Sans (`var(--font-body)`), with "Segoe UI", sans-serif fallback.

**Character:** Space Grotesk's geometric confidence for headings/brand pairs with Plus Jakarta Sans's warmer, rounder body text — bolder and friendlier than a plain system-font stack, while staying highly legible in dense tables.

### Hierarchy
- **Display/Brand** (700, 1.2rem, -0.01em tracking): topbar brand title (`.brand-text h1`).
- **Title** (700, 1.15rem): page headings (`.page-heading h2`), card headers (`.card-header h3`, 0.95rem), auth card title (`.auth-card h1`, 1.1rem).
- **Body** (400, 0.9rem): default text, inputs, table cells (0.86rem).
- **Label** (700, 0.72rem, 0.03em tracking, uppercase): table column headers (`th`).
- **Subtext** (400, 0.8–0.88rem, muted color): card subtext, page-heading descriptions.

## Layout

Single-column `.container` (max-width 1240px, centered, `1.75rem 2rem 3rem` padding) holds a page heading followed by stacked `.card` blocks. The dashboard's `.workspace` is a responsive grid (1 column by default, widening for the orders table + detail panel side-by-side on larger viewports). Tables use `table-layout: fixed` with explicit `<colgroup>` widths so status pills and long values never overflow their card.

## Elevation & Depth

Layered: surfaces are flat at rest, gaining a lifting shadow (`--shadow-md`) on hover. Cards use a subtle resting shadow (`--shadow-sm`, `0 1px 2px`) and deepen to `--shadow-md` (`0 10px 28px`, brand-tinted in light theme, pure black in dark theme) on hover. The topbar carries `--shadow-md` permanently to read as the fixed, elevated command layer above page content.

### Shadow Vocabulary
- **Resting** (`--shadow-sm`: `0 1px 2px rgba(76,29,149,0.07)` light / `rgba(0,0,0,0.35)` dark): default card shadow.
- **Elevated** (`--shadow-md`: `0 10px 28px rgba(124,58,237,0.14)` light / `rgba(0,0,0,0.45)` dark): topbar, card hover, auth card (`0 20px 60px rgba(76,29,149,0.28)`).

### Named Rules
**The Hover-Lifts Rule.** Nothing gains a heavier shadow at rest. Depth is always a response to interaction (hover/focus), never a static decoration.

## Shapes

Two radius steps run the whole system: `--radius` (16px) for cards, modals, and the auth card family; `--radius-sm` (11px) for buttons, inputs, and compact banners. Status badges and topbar nav links use fully pill-shaped (`999px`) radii to visually separate "state" chips from "container" surfaces.

## Components

### Buttons
- **Shape:** `--radius-sm` (11px).
- **Primary:** animated violet→pink gradient background, white text, `0.55rem 1.2rem` padding, brand-tinted glow shadow; on hover the gradient position shifts and the button lifts (`translateY(-1px) scale(1.02)`) with a stronger glow.
- **Secondary:** flat surface background, themed text, `1px solid var(--border-strong)`, no shadow at rest, `--shadow-sm` + lift on hover.
- **Danger link** (`.danger-link`): transparent background, red border/text (`#dc2626`), fills solid red with white text on hover — used for destructive row actions (e.g. remove SKU).
- **Disabled:** 50% opacity, no shadow, not clickable.

### Status pills
- **Style:** pill radius (999px), two-stop tonal gradient background matched to a saturated text color per tone (success/info/warning/danger/neutral); scale up slightly (1.04×) on hover.
- **Use:** order status, stock-level badges ("low stock" = warning, "out of stock" = danger).

### Cards / Containers
- **Corner Style:** 16px radius.
- **Background:** `--surface` (flat neutral, not the brand gradient).
- **Shadow Strategy:** resting `--shadow-sm`, elevated `--shadow-md` on hover (see Elevation & Depth).
- **Border:** `1px solid var(--border)`.
- **Internal Padding:** `1.25rem`, `0.9rem` bottom margin between header and body.
- **Upload/dropzone variant** (`.upload-card`): dashed `var(--border-strong)` border, `--surface-alt` background instead of solid border/shadow.

### Inputs / Fields
- **Style:** `--radius-sm` (11px), `1px solid var(--border-strong)`, `--surface` background, `0.5rem 0.65rem` padding.
- **Currency-prefixed inputs** (`.input-prefix`, e.g. unit price): leading `€` symbol in muted text inside the same bordered pill, inner input borderless.
- **Focus:** relies on default browser outline; currency-prefix inputs suppress it since the wrapper carries the border.

### Navigation
- **Topbar** (`.topbar`): fixed violet-to-dark-violet diagonal gradient, white text, permanent `--shadow-md`.
- **Nav links** (`.topbar-nav-link`): pill-shaped, translucent white text/background at rest, brighten and lift on hover; the active link inverts to a solid white pill with brand-dark text (`data-active="true"`).
- **Brand mark** (`.brand-mark`): 34×34px rounded-square with the animated violet/pink/cyan gradient, looping every 6s — the one place motion runs continuously rather than only on interaction.

## Do's and Don'ts

### Do:
- **Do** reserve the animated brand gradient for the topbar, brand mark, and primary buttons only (The Gradient-Is-Signal Rule).
- **Do** use pill-shaped status badges with tonal gradients for every state communicated to the user (order status, stock level).
- **Do** keep card/table surfaces flat and neutral at rest, lifting only on hover (The Hover-Lifts Rule).
- **Do** preserve full dark/light theme parity for any new component — define both `:root` and `[data-theme="dark"]` values.

### Don't:
- **Don't** apply the brand gradient to data surfaces (tables, cards, inputs) — it dilutes its meaning as an action/brand signal.
- **Don't** introduce a third shadow tier or a permanently "elevated" resting card; depth is earned only through interaction.
- **Don't** invent new radius scales — reuse 11px (controls), 16px (containers), or pill (badges/nav).
