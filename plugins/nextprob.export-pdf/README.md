# Export PDF

Exports NextProb notes as PDF documents. The plugin registers a `pdf` converter
with the Export Engine and renders the note through a hidden Chromium window
using the app's own `note://` resource resolution, so note styles, fonts, and
local assets render as they do in the app.

## Usage

Once activated, the plugin contributes:

- **Export as PDF** on notes and `.html` files in the sidebar.
- **Export as PDF** on note tabs, with the `Cmd+Shift+E` (macOS) or
  `Ctrl+Shift+E` (Windows/Linux) shortcut.
- The `pdf` format in the Export Engine picker.

The converter defaults to A4, portrait, printed backgrounds, and default
margins. The `export:save-pdf` handler also accepts optional `pageSize`,
`landscape`, `printBackground`, and `marginType` values. Rendering fails if the
page does not load within 30 seconds.

## IPC channels

| Kind | Channel | Purpose |
| --- | --- | --- |
| `handle` | `export:save-pdf` | Renders a note to PDF and writes it to a chosen `.pdf` file. |
| `send` | `export:pdf-progress` | Reports `loading` and `saving` progress to the renderer. |

The handler rejects paths outside the current workspace.

## Dependencies

Registry plugins:

| Plugin | Range |
| --- | --- |
| `nextprob.export-engine` | `>=1.0.0 <2.0.0` |

Runtime npm dependencies: none. This package therefore has no
`package-lock.json`.

Registry dependencies only constrain installation and version selection. They do
not grant cross-process API access and do not auto-enable subprocess services.
This package is a native extension and uses the app's native extension APIs
directly.

- Package id: `nextprob.export-pdf`
- Version: `1.0.0`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`

## Source

`plugins/nextprob.export-pdf` in the NextProb plugin registry.

## License

MIT. See [LICENSE](LICENSE).
