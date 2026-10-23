import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createZip, crc32 } from '../lib/zip.mjs';
import { canonicalJson, keyId, sign } from '../lib/sign.mjs';
import {
  assertPlanMatchesArtifacts,
  verifyArtifactArchive,
  verifyExistingCatalogSignature,
} from '../publish.mjs';

const ID = 'community.alpha';
const VERSION = '1.0.0';
const MAX_ARTIFACT_SIZE = 100 * 1024 * 1024;

function extension(overrides = {}) {
  return {
    id: ID,
    name: 'Alpha',
    version: VERSION,
    apiVersion: 1,
    nextprob: '>=0.4.0 <1.0.0',
    platforms: ['linux-x64'],
    main: 'main.cjs',
    ...overrides,
  };
}

function descriptor(overrides = {}) {
  return {
    id: ID,
    version: VERSION,
    sourceCommit: 'a'.repeat(40),
    filename: `${ID}-${VERSION}.zip`,
    sha256: '0'.repeat(64),
    size: 0,
    platforms: ['linux-x64'],
    manifest: {
      apiVersion: 1,
      execution: 'native',
      nextprob: '>=0.4.0 <1.0.0',
      dependencies: [],
    },
    ...overrides,
  };
}

function rawZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function metadata(overrides = {}) {
  return {
    publisher: 'community',
    license: 'MIT',
    categories: ['developer'],
    summary: 'Alpha plugin',
    releaseNotes: 'Initial release',
    ...overrides,
  };
}

function archive(manifest = extension(), extra = [], meta = metadata()) {
  return createZip([
    { path: 'extension.json', data: `${JSON.stringify(manifest)}\n` },
    { path: 'metadata.json', data: `${JSON.stringify(meta)}\n` },
    { path: 'README.md', data: '# Alpha\n' },
    { path: 'LICENSE', data: 'MIT\n' },
    { path: 'main.cjs', data: 'module.exports = () => {};\n' },
    ...extra,
  ]);
}

test('publish archive verification accepts a matching archive', () => {
  const entries = verifyArtifactArchive(descriptor(), archive(), metadata());
  assert.ok(entries.some(entry => entry.path === 'extension.json'));
});

test('publish archive verification rejects metadata mismatches', () => {
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(), metadata({ summary: 'Different summary' })),
    /metadata\.json does not match/,
  );
});

test('publish archive verification rejects missing referenced files', () => {
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(extension({ main: 'missing.cjs' }))),
    /missing main/,
  );
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(extension(), [], metadata({ icon: 'icon.png' }))),
    /missing Icon/,
  );
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(extension({
      main: 'main.cjs',
      packaging: { unpackedResources: ['assets'] },
    }))),
    /missing unpacked resource/,
  );
});

test('publish archive verification rejects unsafe paths and special entries', () => {
  const manifest = JSON.stringify(extension());
  assert.throws(() => verifyArtifactArchive(descriptor(), rawZip([
    { name: 'extension.json', data: manifest },
    { name: '../evil', data: 'x' },
  ])), /inside the package/);
  assert.throws(() => verifyArtifactArchive(descriptor(), rawZip([
    { name: 'extension.json', data: manifest },
    { name: 'link', data: 'main.cjs', mode: 0o120777 },
  ])), /symbolic links/);
  assert.throws(() => verifyArtifactArchive(descriptor(), rawZip([
    { name: 'extension.json', data: manifest },
    { name: 'dir/', data: '', mode: 0o040755 },
  ])), /directory entries/);
});

test('publish archive verification rejects embedded manifest mismatches', () => {
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(extension({ version: '1.1.0' }))),
    /does not match descriptor version/,
  );
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(extension({ id: 'community.other' }))),
    /does not match descriptor id/,
  );
  assert.throws(
    () => verifyArtifactArchive(descriptor(), archive(extension({ nextprob: '>=0.4.0 <2.0.0' }))),
    /nextprob range does not match/,
  );
  assert.throws(
    () => verifyArtifactArchive(descriptor({ platforms: ['darwin-arm64'] }), archive()),
    /platforms do not match/,
  );
});

test('publish archive verification rejects case-insensitive duplicate names', () => {
  assert.throws(() => verifyArtifactArchive(descriptor(), rawZip([
    { name: 'extension.json', data: JSON.stringify(extension()) },
    { name: 'README.md', data: 'one' },
    { name: 'readme.md', data: 'two' },
  ])), /case-insensitive/);
});

test('publish archive verification rejects oversized descriptors before reading', () => {
  assert.throws(
    () => verifyArtifactArchive(descriptor({ size: MAX_ARTIFACT_SIZE + 1 }), archive()),
    /100 MiB/,
  );
});

test('publication plan must match artifacts exactly', () => {
  const artifact = { descriptor: descriptor() };
  assert.doesNotThrow(() => assertPlanMatchesArtifacts({
    changed: [
      { id: ID, version: VERSION, action: 'publish' },
      { id: 'community.other', version: '2.0.0', action: 'metadata' },
    ],
  }, [artifact]));
  assert.throws(
    () => assertPlanMatchesArtifacts({ changed: [{ id: ID, version: VERSION, action: 'publish' }] }, []),
    /no matching artifact/,
  );
  assert.throws(
    () => assertPlanMatchesArtifacts({ changed: [] }, [artifact]),
    /no matching publish action/,
  );
  assert.throws(
    () => assertPlanMatchesArtifacts({ changed: [{ id: ID, version: VERSION, action: 'metadata' }] }, [artifact]),
    /no matching publish action/,
  );
});

test('existing catalog signatures are verified against committed key ids', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = keyId(publicKey);
  const catalog = { schemaVersion: 1, catalogVersion: 1, keyId: id, plugins: [] };
  const signature = sign(Buffer.from(canonicalJson(catalog)), privateKey);
  const keys = [{ name: 'test.pem', key: publicKey, keyId: id }];
  assert.doesNotThrow(() => verifyExistingCatalogSignature(catalog, signature, keys));
  assert.throws(() => verifyExistingCatalogSignature(catalog, 'not-a-signature', keys), /invalid/);
  assert.throws(() => verifyExistingCatalogSignature(catalog, '', keys), /missing/);
  assert.throws(
    () => verifyExistingCatalogSignature({ ...catalog, keyId: 'f'.repeat(64) }, signature, keys),
    /No committed public key/,
  );
});
