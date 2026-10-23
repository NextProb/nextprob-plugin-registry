# Export Engine

Shared export tools for NextProb. This plugin provides the format registry, the
`export:note` and `export:formats` IPC handlers, and the export menu used by
other export plugins.

## Usage

The plugin exposes the export engine as the `nextprob.export-engine` service, so
other native packages can `api.require('nextprob.export-engine')` and register a
converter for a built-in format:

```js
const engine = api.require('nextprob.export-engine');
engine.registerConverter('markdown', async (htmlContent, options) => markdown);
```

Built-in formats are `html`, `pdf`, `markdown`, and `plaintext`. Only `html` has
a working converter in this release; the others must be supplied by another
plugin. The renderer contributes the "Export Note as…" picker and the
`nextprob.export-formats` renderer service. The picker lists only formats with
a currently registered provider; when none are installed it shows an empty
state directing you to install or enable an export format plugin in
Settings → Plugins.

- Package id: `nextprob.export-engine`
- Version: `1.0.1`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`
- Runtime dependencies: none

## Manifest summary

The manifest describes a native package with `main.cjs` as its main entry,
`renderer.js` as its renderer entry, `renderer.css` as a style, and declares the
`export:note` and `export:formats` IPC handle channels.

## Source

The canonical source for this plugin is now this registry directory:
`plugins/nextprob.export-engine`. The copy previously bundled with the app is
retained by the app but is no longer the source of truth.

## License

MIT. See [LICENSE](LICENSE).
