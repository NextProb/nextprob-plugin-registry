import test from 'node:test';
import assert from 'node:assert/strict';
import { assetFilename, makeVersionEntry, mergeCatalog } from '../lib/catalog.mjs';

const ID = 'community.alpha';
const REPO = 'NextProb/nextprob-plugin-registry';
const PUBLISHER = { id: 'community', displayName: 'Community', official: false, github: ['alice'], url: 'https://example.com' };

function metadata(summary) {
  return {
    publisher: 'community',
    license: 'MIT',
    categories: ['productivity'],
    summary,
    releaseNotes: 'Release notes',
  };
}

function descriptor(version, { sha = 'a'.repeat(64), size = 100, sourceCommit = 'c'.repeat(40) } = {}) {
  return {
    id: ID,
    version,
    sourceCommit,
    filename: assetFilename(ID, version),
    sha256: sha,
    size,
    platforms: ['linux-x64'],
    manifest: {
      apiVersion: 1,
      execution: 'native',
      nextprob: '>=0.4.0 <1.0.0',
      dependencies: [{ id: 'community.beta', range: '^1.0.0' }],
    },
  };
}

function versionEntry(version, options, now) {
  return makeVersionEntry({ descriptor: descriptor(version, options), metadata: metadata('Release'), repo: REPO, now });
}

function existingCatalog(now) {
  return {
    schemaVersion: 1,
    catalogVersion: 5,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourceCommit: '0'.repeat(40),
    keyId: 'old-key',
    plugins: [
      {
        id: ID,
        publisher: PUBLISHER,
        official: false,
        metadata: metadata('Old summary'),
        versions: [
          versionEntry('1.0.0', { sha: 'b'.repeat(64), size: 90, sourceCommit: 'd'.repeat(40) }, now),
          versionEntry('0.9.0', { sha: 'e'.repeat(64), size: 80, sourceCommit: 'd'.repeat(40) }, now),
        ],
      },
    ],
  };
}

test('catalog merge preserves old versions and updates metadata', () => {
  const now = '2026-02-01T00:00:00.000Z';
  const existing = existingCatalog('2026-01-01T00:00:00.000Z');
  const newVersion = versionEntry('1.1.0', { sha: 'f'.repeat(64), size: 110, sourceCommit: '1'.repeat(40) }, now);
  const update = {
    id: ID,
    record: { id: ID, publisher: PUBLISHER, official: false, metadata: metadata('New summary') },
    versions: [newVersion],
  };
  const { catalog, changed } = mergeCatalog(existing, [update], {
    sourceCommit: '1'.repeat(40),
    keyId: 'new-key',
    now,
  });
  assert.equal(changed, true);
  assert.equal(catalog.catalogVersion, 6);
  assert.equal(catalog.generatedAt, now);
  assert.equal(catalog.sourceCommit, '1'.repeat(40));
  assert.equal(catalog.keyId, 'new-key');
  assert.deepEqual(catalog.plugins[0].versions.map(version => version.version), ['1.1.0', '1.0.0', '0.9.0']);
  assert.equal(catalog.plugins[0].metadata.summary, 'New summary');
  assert.equal(catalog.plugins[0].versions.find(version => version.version === '1.0.0').assets[0].sha256, 'b'.repeat(64));

  const metadataOnly = mergeCatalog(catalog, [{
    id: ID,
    record: { id: ID, publisher: PUBLISHER, official: false, metadata: metadata('Newer summary') },
    versions: [],
  }], { sourceCommit: '2'.repeat(40), keyId: 'new-key', now: '2026-03-01T00:00:00.000Z' });
  assert.equal(metadataOnly.changed, true);
  assert.equal(metadataOnly.catalog.catalogVersion, 7);
  assert.deepEqual(metadataOnly.catalog.plugins[0].versions.map(version => version.version), ['1.1.0', '1.0.0', '0.9.0']);
  assert.equal(metadataOnly.catalog.plugins[0].metadata.summary, 'Newer summary');

  const currentVersion = metadataOnly.catalog.plugins[0].versions.find(version => version.version === '1.1.0');
  const noChange = mergeCatalog(metadataOnly.catalog, [{
    id: ID,
    record: { id: ID, publisher: PUBLISHER, official: false, metadata: metadata('Newer summary') },
    versions: [currentVersion],
  }], { sourceCommit: '3'.repeat(40), keyId: 'new-key', now: '2026-04-01T00:00:00.000Z' });
  assert.equal(noChange.changed, false);
  assert.equal(noChange.catalog.catalogVersion, 7);
});

test('metadata changes propagate deprecated and withdrawn to existing versions', () => {
  const existing = existingCatalog('2026-01-01T00:00:00.000Z');
  const updatedMetadata = { ...metadata('Retired summary'), deprecated: true, withdrawn: true };
  const { catalog, changed } = mergeCatalog(existing, [{
    id: ID,
    record: { id: ID, publisher: PUBLISHER, official: false, metadata: updatedMetadata },
    versions: [],
  }], { sourceCommit: '2'.repeat(40), keyId: 'old-key', now: '2026-03-01T00:00:00.000Z' });
  assert.equal(changed, true);
  assert.equal(catalog.plugins[0].metadata.deprecated, true);
  for (const version of catalog.plugins[0].versions) {
    assert.equal(version.deprecated, true);
    assert.equal(version.withdrawn, true);
    assert.equal(version.releaseNotes, 'Release notes');
  }
});

test('existing versions are reused when bytes match even from another source commit', () => {
  const existing = versionEntry('1.0.0', {
    sha: 'b'.repeat(64),
    size: 90,
    sourceCommit: 'a'.repeat(40),
  }, '2026-01-01T00:00:00.000Z');
  const same = makeVersionEntry({
    descriptor: descriptor('1.0.0', { sha: 'b'.repeat(64), size: 90, sourceCommit: 'b'.repeat(40) }),
    metadata: metadata('Release'),
    repo: REPO,
    existing,
  });
  assert.equal(same, existing);
  assert.equal(same.sourceCommit, 'a'.repeat(40));
  assert.throws(() => makeVersionEntry({
    descriptor: descriptor('1.0.0', { sha: 'd'.repeat(64), size: 90, sourceCommit: 'b'.repeat(40) }),
    metadata: metadata('Release'),
    repo: REPO,
    existing,
  }), /Refusing to replace/);
  assert.throws(() => makeVersionEntry({
    descriptor: descriptor('1.0.0', { sha: 'b'.repeat(64), size: 91, sourceCommit: 'b'.repeat(40) }),
    metadata: metadata('Release'),
    repo: REPO,
    existing,
  }), /Refusing to replace/);
});
