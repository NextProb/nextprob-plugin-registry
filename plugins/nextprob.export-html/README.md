# Export HTML

Exports NextProb notes as HTML files. It supports both a regular copy of the
note's HTML and a single self-contained file with local stylesheets, scripts,
images, fonts, audio, and video inlined as data URIs.

## Usage

Once activated, the plugin registers the `html` format with the Export Engine and
contributes these actions:

- **Export as HTML (copy)** on notes and `.html` files in the sidebar, and on
  note tabs. The saved file is the note's converted HTML content.
- **Export as Single HTML File** on notes in the sidebar. The plugin inlines
  local assets referenced by the note, adds the shared note stylesheet and theme
  script, and writes one portable `.html` file. If the note uses backend APIs
  such as `noteDB`, `noteSQL`, or `noteScripts`, the save dialog warns that those
  APIs will not work in a browser.

The main process also provides the `nextprob.html-inliner` service with
`inlineNoteAsHtml` for other native packages.

## IPC channels

| Kind | Channel | Purpose |
| --- | --- | --- |
| `handle` | `export:save-html` | Converts a note to HTML and writes it to a chosen `.html` file. |
| `handle` | `export:single-html` | Builds a self-contained HTML file with inlined assets. |

Both handlers reject paths outside the current workspace.

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

- Package id: `nextprob.export-html`
- Version: `1.0.0`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`

## Source

`plugins/nextprob.export-html` in the NextProb plugin registry.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
