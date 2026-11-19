# BetterScore

BetterScore is an Obsidian plugin for reading and annotating PDF sheet music. It is inspired by forScore, with an emphasis on portable, vault-native data.

The original PDF is never modified. BetterScore stores normalized annotation strokes in a versioned `.betterscore.json` sidecar beside the score, making annotations straightforward to sync, back up, and inspect independently of the plugin.

## Current features

- Continuous vertical PDF reading
- Mouse, stylus, and Apple Pencil annotation input
- Pressure-sensitive pen
- Semi-transparent yellow marker with a persistent right-click width menu
- Positioned multiline text annotations
- Stroke eraser
- Undo and redo, including keyboard shortcuts
- Automatic sidecar saving
- Desktop and mobile support

BetterScore is currently an early prototype.

## Install for development

1. Clone this repository to `<vault>/.obsidian/plugins/betterscore`.
2. Run `npm install`.
3. Run `npm run verify`.
4. Enable BetterScore under **Settings → Community plugins** in Obsidian.

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

## License

BetterScore is free software licensed under the [GNU General Public License v3.0 only](LICENSE).
