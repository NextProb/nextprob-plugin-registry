# Export Plain Text

Exports the readable text of NextProb notes as `.txt` files. The converter
removes markup and invisible content while keeping the note's text structure.

## Usage

Once activated, the plugin registers the `plaintext` format with the Export
Engine and contributes:

- **Export as Plain Text** on notes and `.html` files in the sidebar.
- **Export as Plain Text** on note tabs.
- The `plaintext` format in the Export Engine picker.

Conversion keeps headings and paragraphs as separated text, converts lists to
`-` and `1.` items with indentation, renders table rows with ` | ` separators,
turns images into their `alt` text, and preserves `<pre>` block whitespace.
Scripts, styles, and document metadata are dropped, and output ends with a
single newline.

## IPC channels

| Kind | Channel | Purpose |
| --- | --- | --- |
| `handle` | `export:save-plaintext` | Converts a note to plain text and writes it to a chosen `.txt` file. |

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

- Package id: `nextprob.export-plaintext`
- Version: `1.0.0`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`

## Source

`plugins/nextprob.export-plaintext` in the NextProb plugin registry.

## License

MIT. See [LICENSE](LICENSE).
