# Publishing

Publishing adds **Publish as a Link** to NextProb. It packages a note into a
single self-contained HTML document, uploads it as a GitHub Gist, and serves it
through a GitHub Pages renderer so the note can be opened from a URL.

Publishing is the only plugin that is bundled with the app by default. The
marketplace package is the canonical source for that same plugin: it keeps the
existing plugin id (`nextprob.publishing`), settings and GitHub credentials,
sharing metadata (the `publishing` collection and its `__shareId`,
`__shareUrl`, and `__shareVisibility` keys), IPC channels, and publishing
behavior.

## Self-contained inlining

The plugin inlines everything a note needs before upload:

- `<link rel="stylesheet">` files become inline `<style>` blocks.
- Images, fonts, audio, and video referenced by HTML or CSS become `data:` URIs.
- `<script src>` files become inline `<script>` blocks.
- The viewer stylesheet and theme script are added to the document.

The inliner used to live in HTML Export and was reached through the
html-inliner plugin service. This package includes its own copy (`inline.js`
and `share-note-style.js`), so publishing no longer looks up another plugin at
activation time. There are no export-plugin dependencies and no download is
needed on first use.

Publishing adds **no export actions**. It does not save HTML or PDF files, it
does not contribute to the export menu, and it does not depend on HTML Export
or Export Engine.

## GitHub connection and sharing metadata

GitHub OAuth device-flow connection, credential storage, repository selection,
gist creation/update/deletion, Pages provisioning, and the `github:*` IPC
channels are unchanged from the app's bundled plugin. The `export:publish`,
`export:unpublish`, and `notes:listPublished` channels retain their existing
names and payloads so existing settings, credentials, and published-note
metadata keep working without migration.

## Renderer fallback

The share renderer (`share-renderer/index.html` and `robots.txt`) is bundled
with the plugin. At startup the plugin prefers a cached copy, falls back to the
bundled copy, and refreshes from the content repository when the network is
available. First use works offline with the bundled renderer.

## Migration note

The app still ships its own copy of Publishing. Before HTML Export and Export
Engine are removed from the app bundle, that bundled copy must adopt the same
self-contained inliner used here. Until then, removing those export plugins
from the app would leave the bundled Publishing copy unable to activate because
it still requests the html-inliner plugin service.

## Package

- Plugin id: `nextprob.publishing`
- Version: `1.0.0`
- NextProb compatibility: `>=0.4.0 <1.0.0`
- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`
- Runtime dependencies: none

## License

MIT. See [LICENSE](LICENSE).
