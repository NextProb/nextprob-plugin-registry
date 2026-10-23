# Catalog signing keys

The marketplace catalog is signed with an Ed25519 key. The NextProb app must
pin the public key below and reject a catalog whose detached signature does not
verify.

## Current key

- Public key: [`catalog-signing-public.pem`](catalog-signing-public.pem) (SPKI PEM)
- Key ID: `c212985bff94fe74d2416b24aa980d0736ffeb9b65ec15a0af7c1bc2daaaf5b2`
- Key ID derivation: SHA-256 of the DER-encoded SubjectPublicKeyInfo, lowercase hex
- Private key: only the encrypted GitHub Actions secret `CATALOG_SIGNING_KEY`
  (PKCS#8 PEM). It is never committed, logged, or rendered to chat.

The public key is intentionally public: it verifies signatures and cannot create
them. Committing it lets the app and independent auditors verify catalog
authenticity.

## What is signed

`catalog.json` on the `catalog` branch, as canonical JSON:

- Object keys sorted recursively by UTF-16 code unit order.
- Arrays keep their order.
- No insignificant whitespace (`JSON.stringify` of the canonicalized value).

The detached signature is `catalog.json.sig`: standard Base64 of the raw Ed25519
signature, followed by a newline. The signature covers the bytes of the canonical
JSON, not the pretty-printed representation.

Published catalog:

```text
https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json
https://raw.githubusercontent.com/NextProb/nextprob-plugin-registry/catalog/catalog.json.sig
```

Every catalog version entry also carries the published ZIP's SHA-256 and size.
Verify both: the signature proves the catalog came from the publishing workflow;
the digest binds the downloaded archive to that signed entry.

## Rotation

Only maintainers may rotate signing keys. Rotation is a reviewed change to `keys/`
and to the repository secret.

1. Generate a new keypair into a temporary path, not directly over the active key:
   `node scripts/generate-signing-key.mjs --private <temporary-private.pem> --public <temporary-public.pem>`.
2. Record the old key ID (from this file or the existing catalog's `keyId`) and
   archive the current public key **before** replacing it:
   `git mv keys/catalog-signing-public.pem keys/archive-<old-keyid>.pem`.
   Then copy the newly generated public key to `keys/catalog-signing-public.pem`.
   Keep archived public keys committed: `publish.mjs` loads every `keys/*.pem` and
   uses the one matching the existing catalog's `keyId` to verify existing catalog
   revisions before merging or re-signing. Do not delete archived keys while any
   catalog revision signed by them may still be served.
3. Add the private key to the repository secret `CATALOG_SIGNING_KEY` (or rotate
   it in the same step). Never commit the private file.
4. Ship an app release that trusts both the old and new public keys before the
   first catalog signed with the new key, or trust the catalog's `keyId` through
   an approved mapping. Do not remove the old key from the app until all clients
   that may still see an old catalog have upgraded.
5. Publish a catalog signed with the new key. The `keyId` field changes, which
   increments `catalogVersion`.
6. Record the rotation in this file with the date and both key IDs.

If a private key is exposed, treat all catalog contents as suspect, rotate
immediately, and announce the rotation. Deleting or rewriting published versions
is not an acceptable response: publish replacements under new versions and mark
the affected versions `withdrawn` in metadata.

## Verification example

```js
import crypto from 'node:crypto';
import fs from 'node:fs';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};

const bytes = Buffer.from(JSON.stringify(canonical(JSON.parse(fs.readFileSync('catalog.json', 'utf8')))));
const signature = Buffer.from(fs.readFileSync('catalog.json.sig', 'utf8').trim(), 'base64');
const publicKey = crypto.createPublicKey(fs.readFileSync('keys/catalog-signing-public.pem', 'utf8'));
if (!crypto.verify(null, bytes, publicKey, signature)) throw new Error('Invalid catalog signature');
```
