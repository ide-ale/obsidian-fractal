# Fractal

[![GitHub release](https://img.shields.io/github/v/release/ide-ale/obsidian-fractal?style=flat-square)](https://github.com/ide-ale/obsidian-fractal/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Obsidian Desktop & Mobile](https://img.shields.io/badge/Obsidian-Desktop%20%26%20Mobile-7c3aed?style=flat-square)](https://obsidian.md)
[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20my%20work-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/alessandroabrami)

**Fractal** lets you visualize and edit standard Markdown notes in a **column-based card tree layout** (inspired by Gingko) or a full **Mind-Map view**, mapped directly to your note's Markdown heading hierarchy (`#` through `######`) without modifying your underlying file format.

![Fractal column tree navigation](https://raw.githubusercontent.com/ide-ale/obsidian-fractal/main/docs/media/fractal-columns-navigation.jpg)

---

## Why Fractal?

Long Markdown documents force you to choose between keeping high-level structure in view or focusing on paragraph-level writing. Fractal turns any note's heading outline into synchronized left-to-right views:

- **Two synchronized spatial views:** Switch anytime between the focused **Column Tree** (default) and a full-outline **Mind-Map** rooted at your note title.
- **See breadth and depth together:** Parent sections stay visible on the left while subsections expand on the right.
- **Zero lock-in:** Every card and node *is* a standard Markdown heading section in your `.md` file. Switch freely between Obsidian's normal editor and Fractal anytime.
- **Built for desktop and mobile:** Uses only standard Obsidian and browser APIs with no Node.js or Electron dependencies.

---

## Visual Walkthrough

### Column Navigation & Inline Card Editing

Browse branches left-to-right, expand active cards, edit directly in place with Obsidian's editor, and switch back to standard Markdown at any time with zero export or conversion.

![Fractal navigation and inline editing demo](https://raw.githubusercontent.com/ide-ale/obsidian-fractal/main/docs/media/fractal-demo-editing.gif)

### Rich Markdown Rendering & Layout Workflow

Active cards and illuminated ancestor paths render full Obsidian Markdown—including embedded vault images, callouts, tables, fenced code blocks, and internal links—while unselected sibling cards collapse into concise previews.

![Fractal workflow and structure demo](https://raw.githubusercontent.com/ide-ale/obsidian-fractal/main/docs/media/fractal-demo-workflow.gif)

![Fractal rich card with embedded image and callout](https://raw.githubusercontent.com/ide-ale/obsidian-fractal/main/docs/media/fractal-rich-card-preview.jpg)

---

## Features

- **Column Tree & Mind-Map Modes:** Switch views on the fly from the **MindMap** toolbar button (or command palette), or choose your preferred **Default visualization** in Settings.
- **Interactive Mind-Map Overview:**
  - Displays the entire heading hierarchy (`Root note title` → `H1`–`H6`) with compact title nodes and optional orthogonal rounded connectors with active-branch aura (`Show connections` toggle in Settings and the Layout popover).
  - Compact nodes keep section body text hidden (with a subtle content icon on sections that contain text or root YAML/intro) and support a 3-step keyboard & mouse flow: `Enter` (or click) expands reading view with automatic zero-overlap layout reflow → `Enter` again (or double-click) opens inline editing → `Esc` returns to reading → second `Esc` collapses back to compact overview.
  - Pure arrow-key branch navigation (`ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown`) without accidentally creating empty nodes.
- **Standard Markdown Storage:** Every card maps 1:1 to a Markdown heading (`#` through `######`). Your vault remains 100% portable plain Markdown.
- **Multi-Column Tree Navigation:** Illuminated ancestor paths, automatic focus scrolling, and optional centered navigation keep your active branch in clear view.
- **Properties & Introduction Panel:** Toggleable header panel (and expandable Root node in Mind-Map mode) for viewing and editing YAML frontmatter properties and introductory prose above the first `# H1` heading.
- **Inline Card Editing:** Double-click any card/node or press `Enter` to edit title and body directly inside the canvas with Obsidian's inline Markdown editor and quick formatting toolbar.
- **Drag & Drop Structuring:** Reorder sibling cards within a column, or drop onto another card or adjacent column to reparent branches and automatically adjust heading levels.
- **Theme-Aware Customization:** Automatically adapts to Obsidian's default theme, third-party community themes (`Obsidian theme`), or your own `Custom` palette colors, plus controls for zoom, column width, inactive card height, grid overlay, and spacing.
- **Per-Note Accents & Branch Folding:** Right-click cards or Mind-Map nodes to apply color accents or collapse branches.
- **Zen Mode:** Expand the Fractal canvas across the workspace by collapsing Obsidian's sidebars.

---

## Quick Start

1. Open any Markdown note in Obsidian.
2. Click the **network** icon in the left ribbon (or open the Command Palette and run **Fractal: Toggle view**).
3. Use the **MindMap** button in the top toolbar to switch between the Column Tree and Mind-Map views.
4. Navigate branches with the arrow keys or mouse, press `Enter` to read/edit, and press `Escape` to return/collapse.
5. Optionally set **Default visualization** (`Default` / `Mind-map`) and **Open notes in Fractal view by default** in **Settings → Fractal**.

### Keyboard Shortcuts

**Column Tree (Default) navigation:**

| Shortcut | Action |
| :--- | :--- |
| `Arrow Up` / `Arrow Down` | Move to previous or next sibling card (creates a new card at boundaries) |
| `Arrow Left` / `Arrow Right` | Move to parent or child column (creates a child card if none exists) |
| `Enter` | Edit the selected card |
| `Escape` | Save changes and exit editing mode |
| `Ctrl + N` / `Alt + N` | Insert a sibling card below |
| `Ctrl + Shift + N` / `Alt + Shift + N` | Insert a child card |
| `Ctrl/Cmd + C` / `Ctrl/Cmd + X` / `Ctrl/Cmd + V` | Copy, cut, or paste card & subtree (`Shift + V` pastes as child) |
| `Ctrl/Cmd + Z` / `Ctrl/Cmd + Y` (or `Ctrl/Cmd + Shift + Z`) | Undo / Redo structural changes |
| `Ctrl/Cmd + Mouse Wheel` | Zoom in / out |

**Mind-Map mode navigation:**

| Shortcut | Action |
| :--- | :--- |
| `Arrow Up` / `Arrow Down` | Navigate across visible nodes at the same hierarchy level (no auto-create) |
| `Arrow Left` / `Arrow Right` | Move between parent/root and child nodes (no auto-create) |
| `Enter` (once) | Expand selected node (or Root YAML & intro) to Reading mode |
| `Enter` (twice) | Edit the expanded node inline |
| `Escape` (once) | Save & exit inline editing back to Reading mode |
| `Escape` (twice) | Collapse expanded text back to compact Mind-Map overview |

---

## Installation

### From Obsidian Community Plugins
1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **Fractal**.
3. Click **Install**, then **Enable**.

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub Release](https://github.com/ide-ale/obsidian-fractal/releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/fractal/`.
3. Reload community plugins in Obsidian settings and enable **Fractal**.

---

## Privacy & Local-First Design

- **100% offline & local:** Fractal makes **zero network requests**, collects **zero telemetry or analytics**, and sends no data outside your device.
- **Your notes stay untouched:** Structural edits update your Markdown file directly via Obsidian's Vault API, while visual preferences (theme overrides, zoom, card accents, collapsed branches) are saved locally in Obsidian's standard plugin `data.json`.

---

## Support

If Fractal helps your writing, research, or planning workflow, you can support ongoing development on Ko-fi:

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/alessandroabrami)

## Author

Developed by **Alessandro Abrami** ([GitHub](https://github.com/ide-ale)).

## License

Licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
