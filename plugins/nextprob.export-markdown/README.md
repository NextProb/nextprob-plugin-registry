# Export Markdown

Exports NextProb notes to portable Markdown files. The plugin converts HTML note
content with Turndown and GitHub Flavored Markdown support, then writes the
result through a save dialog.

## Usage

Once activated, the plugin registers an "Export as Markdown" action on notes in
the sidebar and on note tabs. It also registers the `markdown` format with the
Export Engine, so "Export Note as… Markdown (.md)" works from the export picker.
The native `export:save-markdown` IPC handler validates that the note is inside
the current workspace and prompts for a destination `.md` file.

Conversion details:

- ATX headings, `-` bullets, fenced code blocks, inline links.
- Table, strikethrough, and task-list support via `turndown-plugin-gfm`.
- Tables using `colspan`/`rowspan` fall back to raw HTML.
- `<style>` and `<script>` elements are removed.

- Package id: `nextprob.export-markdown`
- Version: `1.0.0`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`

## Dependencies

| Package | Version | License |
| --- | --- | --- |
| `turndown` | `7.2.2` | MIT |
| `turndown-plugin-gfm` | `1.0.2` | MIT |
| `@mixmark-io/domino` | `2.2.0` (transitive) | BSD-2-Clause |

This plugin also depends on the registry plugin `nextprob.export-engine`
(`>=1.0.0 <2.0.0`). Dependencies are pinned exactly in `package.json` and
`package-lock.json`.

## Manifest summary

The manifest describes a native package with `main.cjs` as its main entry and
`renderer.js` as its renderer entry. It declares the `nextprob.export-engine`
dependency and the `export:save-markdown` IPC handle channel.

## Source

The canonical source for this plugin is now this registry directory:
`plugins/nextprob.export-markdown`. The copy previously bundled with the app is
retained by the app but is no longer the source of truth.

## License

MIT. See [LICENSE](LICENSE).
