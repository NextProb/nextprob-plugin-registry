# Export Bulk

Exports a folder of NextProb notes into a single ZIP archive. Notes can be
copied as-is as HTML or converted to PDF, Markdown, or plain text. Installing
this plugin brings the ordinary format plugins as registry dependencies, so it
acts as an "Export Tools" collection rather than replacing them.

## Usage

Once activated, the plugin adds **Bulk Export…** to the folder context menu.
Choosing it opens a format picker:

- **HTML (as-is)** copies every file verbatim.
- **PDF**, **Markdown (.md)**, and **Plain Text (.txt)** convert each `.html`
  note to the selected format and keep the folder structure.

A save dialog selects the destination `.zip` file. A progress banner shows the
current file and offers **Cancel**. Only one bulk export can run at a time.
Dotfiles, symlinks, and tool directories such as `.git`, `node_modules`, and
`.notes-app` are skipped; empty folders are preserved. Files that fail to
convert are listed in `_errors.txt` inside the archive instead of aborting the
operation. Archives are written with zlib level 6.

## IPC channels

| Kind | Channel | Purpose |
| --- | --- | --- |
| `handle` | `export:bulk` | Starts a bulk export for a folder and format. |
| `on` | `export:bulk-cancel` | Cancels the active bulk export. |
| `send` | `export:bulk-progress` | Sends `{ processed, total, currentFile }` progress updates. |

The handler rejects folders outside the current workspace.

## Dependencies

Registry plugins:

| Plugin | Range |
| --- | --- |
| `nextprob.export-engine` | `>=1.0.0 <2.0.0` |
| `nextprob.export-html` | `>=1.0.0 <2.0.0` |
| `nextprob.export-pdf` | `>=1.0.0 <2.0.0` |
| `nextprob.export-markdown` | `>=1.0.0 <2.0.0` |
| `nextprob.export-plaintext` | `>=1.0.0 <2.0.0` |

Runtime npm dependencies:

| Package | Version | License |
| --- | --- | --- |
| `archiver` | `7.0.1` | MIT |

`package-lock.json` pins `archiver` and its complete transitive runtime
subtree (84 packages) with exact resolved URLs and integrity hashes. Install
with `npm ci --ignore-scripts`.

Registry dependencies only constrain installation and version selection. They do
not grant cross-process API access and do not auto-enable subprocess services.
This package is a native extension and uses the app's native extension APIs
directly.

- Package id: `nextprob.export-bulk`
- Version: `1.0.0`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`

## Source

`plugins/nextprob.export-bulk` in the NextProb plugin registry.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
