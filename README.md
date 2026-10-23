# NextProb Plugin Registry

Official and community plugins for [NextProb](https://github.com/NextProb), with
reviewed submissions and automated publication. This repository holds the plugin
sources, their marketplace metadata, the JSON schemas, and the ownership map. It
also hosts the signed catalog and the versioned plugin packages that the NextProb
app consumes.

**Scope:** this repository publishes the catalog and packages. Marketplace UI,
catalog fetching/caching, installation, updates, rollback, and migration of
existing bundled plugins are implemented in the NextProb app repository and are
**not** part of this repository.

## Catalog and package locations

The generated catalog lives on the `catalog` branch, separate from reviewed source
so publication commits do not trigger another source publication.

| Item | Location |
| --- | --- |
| Catalog | `https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json` |
| Detached signature | `https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json.sig` |
| Releases | `https://github.com/NextProb/nextprob-plugin-registry/releases` |
| Trusted public key | [`keys/catalog-signing-public.pem`](keys/catalog-signing-public.pem) |

The signature is detached Ed25519 over canonical JSON (recursively sorted object
keys, arrays preserved, no insignificant whitespace), encoded as base64 text with
a trailing newline. The catalog is machine-generated; do not edit it by hand.

## Release, tag, and asset naming

Each plugin releases independently. There is no repository-wide "latest" release
URL; always use the version-specific URL from the catalog.

| Item | Convention | Example |
| --- | --- | --- |
| Release tag | `<plugin-id>-v<semver>` | `nextprob.export-markdown-v1.0.0` |
| Asset | `<plugin-id>-<semver>.zip` | `nextprob.export-markdown-1.0.0.zip` |
| Download URL | `https://github.com/NextProb/nextprob-plugin-registry/releases/download/<tag>/<asset>` | `.../nextprob.export-markdown-v1.0.0/nextprob.export-markdown-1.0.0.zip` |

Versions are strict SemVer `x.y.z` (no leading `v`, no build metadata). A version
and its asset are immutable: different bytes are never published under an existing
version.

## Plugin directory layout

Every plugin lives at `plugins/<plugin-id>/` and contains at minimum:

```text
plugins/<plugin-id>/
├── extension.json   # runtime manifest (API v1), native or subprocess
├── metadata.json    # marketplace metadata
├── README.md        # user documentation
├── LICENSE          # plugin license
└── ...              # implementation, assets, and optional package.json
```

A `package.json` is required when the plugin has runtime npm dependencies or a
build step; its `version` must match `extension.json`, and a committed
`package-lock.json` is required when it has dependencies. Schemas:

- [`schemas/plugin.schema.json`](schemas/plugin.schema.json) — `extension.json`
- [`schemas/metadata.schema.json`](schemas/metadata.schema.json) — `metadata.json`
- [`schemas/owners.schema.json`](schemas/owners.schema.json) — `owners.json`
- [`schemas/catalog.schema.json`](schemas/catalog.schema.json) — generated catalog

## Dependency semantics

- Registry `dependencies` constrain installation and version selection only; they
  do not grant cross-process API access or automatically enable subprocess services
  across workspaces.
- A native plugin may depend only on other native plugins. Native activation
  supports native dependencies only, so native-to-subprocess dependencies are
  rejected.

## Ownership and the official namespace

Reviewed ownership is declared in [`owners.json`](owners.json). It defines
maintainers, publishers, official namespaces, and the namespace-to-publisher map.

- Any plugin id matching an official namespace (the exact namespace id or
  `<namespace>.*`) is **official** and must map to a publisher with
  `official: true`.
- A plugin id is owned by the longest matching namespace at a `.` boundary, unless
  an exact `plugins.<id>` override exists.
- `metadata.publisher` must equal the derived owner, and official status is derived
  from `owners.json`, never from author-supplied metadata.
- **Only maintainers may change `owners.json`.** A maintainer must add a community
  publisher and its authors to the base branch first; only then can those authors
  submit plugin code in a later pull request. A non-maintainer cannot add
  themselves as a maintainer or register a publisher or namespace.
- Ownership changes require maintainer review; [`.github/CODEOWNERS`](.github/CODEOWNERS)
  protects ownership, schemas, scripts, workflows, signing keys, and official
  namespaces.

Community authors do not receive repository write access. They submit changes by
pull request for the plugins they own.

## Contributing and publication flow

1. Open a pull request changing `plugins/<plugin-id>/`. See
   [CONTRIBUTING.md](CONTRIBUTING.md) for submission, ownership, version, and
   dependency rules.
2. Automation validates manifests, metadata, ownership/authorization, dependency
   graph, platform coverage, and package build. Validation runs without secrets.
3. A maintainer reviews and merges. **Merging is the publication authorization**;
   there is no second release approval or manual release step.
4. On merge, automation packages the exact merged commit, creates or reuses the
   versioned release, uploads and verifies the asset, and only then updates and
   signs the catalog on the `catalog` branch.
5. If any artifact or catalog step fails, the previous usable catalog is retained.
   A retry or manual re-run rebuilds the same version; when the rebuilt archive
   matches the published bytes and size, it is reused rather than replaced, so the
   run can complete a missing catalog update even from a later commit.

## Trust and security

Plugin code and build scripts are untrusted. Builds run in an unprivileged job
without secrets; the privileged publish job never executes plugin code. Released
assets are immutable and verified by size and SHA-256 digest, and the catalog is
signed and verified against the committed public key. The client additionally
enforces archive safety limits (no traversal, symlinks, or special files, and
bounded file count and size).

Report vulnerabilities through GitHub's private security advisory; see
[SECURITY.md](SECURITY.md). Key rotation policy lives in `keys/README.md`.

## Licensing

The registry infrastructure and all official NextProb plugins are licensed under
the [MIT License](LICENSE), copyright 2026 Helicase Space LLC. Each plugin includes
its own `LICENSE`, and its marketplace metadata declares the applicable license.

Community plugins retain their authors' ownership and declared licenses; adding a
plugin to this registry does not automatically license it under MIT. Third-party
code, dependencies, and assets retain their original licenses and required notices.

The NextProb application is licensed separately. This repository's MIT license does
not change the application's license or grant an exception to it.

## Links

- [CONTRIBUTING.md](CONTRIBUTING.md) — submission and review process
- [SECURITY.md](SECURITY.md) — reporting and trust model
- [owners.json](owners.json) — maintainers, publishers, namespaces
- [schemas/](schemas/) — JSON Schemas (draft 2020-12)
- NextProb app documentation (`docs/plugin-marketplace.md` and
  `docs/extensions.md` in the NextProb app repository)
