# BetterScore

BetterScore is an Obsidian plugin for reading and annotating PDF sheet music. It is inspired by forScore, with an emphasis on portable, vault-native data.

The original PDF is never modified. BetterScore stores normalized annotation strokes in a versioned `.betterscore.json` sidecar beside the score, making annotations straightforward to sync, back up, and inspect independently of the plugin.

## Current features

- Continuous vertical PDF reading
- Mouse, stylus, and Apple Pencil annotation input
- Pressure-sensitive pen
- Semi-transparent yellow marker
- Stroke eraser
- Undo and redo, including keyboard shortcuts
- Automatic sidecar saving
- Desktop and mobile support

BetterScore is currently an early prototype.

## Install for development

1. Clone this repository inside or beside an Obsidian vault.
2. Run `npm install`.
3. Adjust `outputDirectory` in `esbuild.config.mjs` if the repository is not stored at `<vault>/BetterScore`.
4. Run `npm run verify`.
5. Enable BetterScore under **Settings → Community plugins** in Obsidian.

Right-click a PDF and choose **Open in BetterScore**, or open a PDF and run **BetterScore: Open active PDF in BetterScore** from the command palette.

## Development

```sh
npm install
npm run verify
```

`npm run verify` runs the TypeScript check, model tests, and production build.

## Annotation format

For a PDF named `Requiem.pdf`, BetterScore creates `Requiem.betterscore.json`. Coordinates and widths are normalized to the PDF page so annotations remain aligned at different display sizes.

The format is versioned and migrations are handled when sidecars are loaded.
