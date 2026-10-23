# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub's **private security advisory**:

1. Open <https://github.com/NextProb/nextprob-plugin-registry/security/advisories/new>,
   or use the repository's **Security → Advisories → Report a vulnerability** page.
2. Include the affected plugin or component, version or commit, reproduction steps,
   and impact.

Do not open a public issue for an undisclosed vulnerability. Maintainers will
acknowledge the report, investigate, and coordinate a fix and disclosure. Please
do not include secrets or personal data in reports.

## Security model

The registry distributes executable code. Nothing here makes third-party plugin
code safe to run; review and user trust remain essential. NextProb runs both
native packages and subprocess extensions with the user's privileges. Subprocess
separation is not a sandbox.

### Untrusted builds are isolated from secrets

- Pull-request validation and packaging execute plugin code, build scripts, and
  `npm ci` in an **unprivileged job** with read-only repository permissions and
  **no secrets**.
- The **privileged publish job never executes plugin code**. It only downloads
  already-built artifacts, verifies them, uploads assets, and signs the catalog.
- Publishing runs only after a maintainer merges the reviewed commit. Merging is
  the human authorization; there is no additional manual release approval.

### Immutable releases and digest verification

- A plugin version is published as tag `<plugin-id>-v<semver>` with asset
  `<plugin-id>-<semver>.zip`. Tags and assets are immutable; different bytes are
  never uploaded under an existing version.
- Before publishing, automation verifies each archive's SHA-256 digest, size, and
  filename against the artifact descriptor and verifies the uploaded asset again
  through the GitHub API.
- Published releases are immutable where GitHub supports it. The catalog pins the
  exact source commit, release tag, download URL, size, and SHA-256 for every
  asset.

### Signed catalog

- `catalog.json` and the detached Ed25519 signature `catalog.json.sig` are
  published on the `catalog` branch:
  `https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json`
  and `.../catalog.json.sig`.
- The signature covers canonical JSON (recursively sorted keys, arrays preserved,
  no insignificant whitespace), encoded as base64 text with a trailing newline.
- The trusted public key is committed at `keys/catalog-signing-public.pem` (SPKI
  PEM). The private key exists only as the GitHub Actions secret
  `CATALOG_SIGNING_KEY` (PKCS#8 PEM) and is never committed or printed.
- Clients should reject a catalog whose signature does not verify against the
  trusted key, and should verify every downloaded archive against the catalog's
  SHA-256 and size.

### Archive and package safety

Published packages and the consumers of this registry apply these limits:

- reject path traversal, absolute paths, backslashes, NUL bytes, and symlinks;
- reject special files and duplicate or conflicting entries;
- limit the archive to 25 MiB per file and 100 MiB total, with at most 10,000
  files;
- resolve resources only inside the package directory;
- reject unsafe ids (Windows reserved names, trailing dots) and undeclared IPC
  channels (`extensions:*` is reserved for the host).

Downloads are staged, verified, and installed atomically so an interrupted update
leaves the previous version usable.

## Key management and rotation

The catalog signing key is rotated according to the policy in `keys/README.md`.
That file is maintained by the registry maintainers and documents the current
`keyId` (SHA-256 of the SPKI DER public key), the committed public key, and the
rotation and revocation procedure. Never place private key material in this
repository, an issue, a pull request, or a workflow log.

## Credentials

- Do not commit tokens, credentials, private keys, or `.env` files.
- Workflows receive the minimum permissions they need: validation and build jobs
  have `contents: read`; only the publish job has `contents: write` plus the
  signing secret.
- Plugin authors must not embed secrets in source, build output, or metadata.

## Scope

This policy covers the registry repository, its schemas, tooling, workflows,
releases, and signed catalog. Marketplace installation, update, rollback, and
migration behavior are implemented in the NextProb app repository; report issues
there when the defect is in the app rather than in a published package or the
catalog.
