# Contributing to the NextProb plugin registry

This repository reviews plugin source, builds versioned packages, and publishes
the signed catalog consumed by NextProb. Marketplace UI and installation live in
the NextProb app repository and are out of scope here.

By submitting a pull request you confirm you have the right to license the
contribution under the plugin's declared license. The registry itself is
AGPL-3.0 (see [LICENSE](LICENSE)); individual plugins carry their own `LICENSE`.

## Repository layout

```text
plugins/<plugin-id>/   reviewed plugin source and metadata
schemas/               JSON Schemas for manifests, metadata, ownership, catalog
owners.json            maintainers, publishers, namespaces, official mapping
scripts/               validation, packaging, signing, publishing tooling
.github/workflows/     CI and automatic publication
keys/                  committed catalog public key and rotation policy
```

Every plugin directory contains `extension.json`, `metadata.json`, `README.md`,
and `LICENSE`. Add `package.json` when the plugin has runtime npm dependencies or
a build step; add `package-lock.json` when it has dependencies.

## Submitting a community plugin

1. **Fork and branch.** Work from the current `main` and add a branch in your fork.
2. **Add the plugin directory** at `plugins/<plugin-id>/` with a stable id that
   you own. Do not change another publisher's plugin.
3. **Author `extension.json`** for API v1. It must include `id`, `name`, `version`
   (`x.y.z`), `apiVersion: 1`, `nextprob` (a range that includes `0.4.0`), and a
   non-empty `platforms` list. Provide at least one entry point: `main`/`renderer`
   for native, or `hooks`/`commands`/`service` for subprocess. Entry, style, and
   resource paths must be package-relative existing files with no `..`, absolute
   paths, backslashes, or NUL.
4. **Author `metadata.json`** with `publisher`, `license` (SPDX expression),
   1–3 `categories` from `export`, `publishing`, `automation`, `integration`,
   `productivity`, `developer`, `theme`, a 1–280 character `summary`, and
   `releaseNotes`. Optional fields: `displayName`, `icon`, `documentation`,
   `source`, `homepage`, `deprecated`, `withdrawn`, `replacement`.
5. **Add `README.md` and `LICENSE`.** These are user-facing and required.
6. **Declare dependencies correctly** (see below) and commit exact dependency
   versions with a lockfile when needed.
7. **Run the checks locally:**
   ```sh
   node --test scripts/test
   node scripts/validate.mjs --all --no-tags
   ```
   If your plugin has a build, make sure `npm run build` succeeds in a clean copy.
8. **Open a pull request** describing the plugin, its publisher, and what changed.
   The PR author must already be listed in the **base branch** `owners.json` (as a
   maintainer or in the owning publisher's `github` array) for ownership
   authorization to pass. A new publisher or author must be onboarded by a
   maintainer in a separate, earlier change.

## Submitting an official plugin

Official plugins use ids beginning with `nextprob.` and follow the same pull
request workflow. The id must map to an official publisher in `owners.json`, and
the submitting author must be authorized for that publisher. Official code gets
the same validation and review as community code; there is no separate release
submission or approval step.

## Ownership and namespace requests

Ownership is defined solely by the reviewed [`owners.json`](owners.json), and
**only maintainers may change it**. A non-maintainer cannot add themselves as a
maintainer, register a publisher or namespace, or change an ownership override.

To onboard a community publisher:

1. The publisher requests ownership (for example in an issue) with the publisher
   id, display name, namespace, GitHub accounts, and URL.
2. A maintainer reviews and commits the `owners.json` change: add a `publishers`
   entry with `displayName`, `official`, `github` logins, and a URL, add a
   `namespaces` mapping, and keep every `officialNamespaces` entry mapped to a
   publisher with `official: true`.
3. That ownership change must be merged to `main` **before** the publisher's
   authors submit plugin code. A later pull request from those authors is then
   authorized against the base branch owners.

Rules enforced by validation and review:

- Only maintainers may change `owners.json`.
- A plugin id is owned by the longest matching namespace at a `.` boundary, unless
  an exact `plugins.<id>` override exists.
- `metadata.publisher` must equal the derived owner.
- Ids matching an official namespace (the exact namespace id or `<namespace>.*`)
  must be owned by an official publisher.
- A non-official publisher must not own an official namespace.
- For plugin changes, the PR author must be a maintainer in the base branch or a
  `github` login of the **base branch** owning publisher. During the initial
  bootstrap, when no base owners exist, the head owners are used. Unknown authors
  fail validation.
- If any part of the ownership snapshot (maintainers, official namespaces,
  publishers, namespaces, or plugin overrides) differs from the base branch, the
  PR author must be a maintainer in the base branch.

**Any pull request changing `owners.json` requires maintainer review.** Authorship,
official status, schema, script, workflow, key, and official-namespace changes are
protected by [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Version bump rules

- **Any distributable change requires a new, previously unused semantic version**
  in `extension.json` (and the matching `package.json` when present). This includes
  implementation code, assets, entry points, dependencies, and any
  `extension.json` change.
- The new version must be greater than every existing release tag for that plugin.
  Tags are immutable; validation rejects reuse of an existing version.
- **Metadata-only changes do not require a version bump.** Changes limited to
  `metadata.json`, `README.md`, and `LICENSE` update the catalog metadata without
  repackaging or republishing the existing version.
- Metadata-only edits must not alter what the published package executes. If in
  doubt, bump the version.

## Dependencies and lockfiles

- `dependencies` in `extension.json` lists ids of other registry plugins. Every id
  must exist in the registry.
- `dependencyVersions` maps those ids to semver ranges. It must not name unknown
  ids, and each range must satisfy the dependency plugin's current version.
- Dependency cycles are rejected.
- A **native** plugin may depend only on other **native** plugins. Native
  activation supports native dependencies only, so native-to-subprocess
  dependencies are rejected.
- Registry `dependencies` constrain installation and version selection only. They
  do not grant cross-process API access or automatically enable subprocess
  services across workspaces.
- Runtime npm dependencies must use **exact versions** (no `^`, `~`, `*`, or
  ranges) and be committed with `package-lock.json` (`lockfileVersion` 3). Install
  with `npm ci --ignore-scripts`; do not rely on install scripts. Native
  dependencies that need rebuilding must be documented in the plugin's README.
- Builds and installs run with network access only to package registries. Never
  commit credentials, tokens, or signing keys.

## Tests and builds

Plugins requiring a build must build successfully from a clean staging copy before
merge. Builds run untrusted code without secrets. Include focused tests where the
plugin has testable logic, and document any manual verification in the PR. CI
packages changed plugins and verifies deterministic archive output.

## PR checks and review

- `validate` checks repository invariants, ownership/authorization, manifests,
  metadata, dependency graph, schemas, and version/tag rules, then writes a
  publication plan artifact.
- `package` builds the changed plugins from the PR commit without secrets and
  uploads the resulting packages for verification.
- A maintainer reviews the change and the plan. Merging is the only human approval
  required.

## What merge authorizes

**Merging an approved pull request authorizes publication.** There is no second
release approval, manual release button, or environment approval. After merge,
automation:

1. identifies changed plugins on `main`;
2. packages the exact merged commit;
3. creates or reuses the `<plugin-id>-v<version>` release, uploads the ZIP, and
   verifies its size and SHA-256;
4. only after every artifact succeeds, updates and signs
   `catalog.json` on the `catalog` branch.

If packaging, upload, or the catalog update fails, the previous catalog stays
usable. A retry or manual re-run rebuilds the same version; matching published
bytes are reused rather than replaced, so the run completes the remaining steps,
including a missing catalog update, even when it starts from a later commit.

## Immutability

- Published tags, assets, and catalog versions are immutable. Never overwrite
  different bytes under an existing version.
- The catalog branch is updated append-only (no force pushes). Existing versions
  are preserved for compatibility and rollback.
- Deleting a plugin directory is an error. Withdraw it through metadata instead.

## Deprecation and withdrawal

Set `deprecated: true` and optionally `replacement` to recommend a successor, or
`withdrawn: true` to stop recommending installs. Withdrawn packages remain in the
catalog and on GitHub Releases; withdrawal is metadata, not deletion.

## Where the catalog appears

After publication, the signed catalog is available at:

```text
https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json
https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json.sig
```

NextProb fetches and verifies these files, then selects a compatible version for
the installed app, OS, architecture, and dependency graph. Installation, updates,
and migration are implemented in the app repository.
