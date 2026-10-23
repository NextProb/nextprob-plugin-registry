import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readZip } from '../lib/zip.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'package.mjs');
const ID = 'community.package-test';
const COMMIT = 'a'.repeat(40);

const owners = {
  schemaVersion: 1,
  maintainers: ['maintainer'],
  officialNamespaces: [],
  publishers: {
    community: { displayName: 'Community', official: false, github: ['alice'], url: 'https://example.com' },
  },
  namespaces: { community: 'community' },
};

function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function createFixture({ mutateExtension = false } = {}) {
  const base = path.resolve('tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'package-fixture-'));
  write(root, 'owners.json', owners);
  write(root, 'schemas/plugin.schema.json', { $schema: 'https://json-schema.org/draft/2020-12/schema' });
  const plugin = `plugins/${ID}`;
  write(root, `${plugin}/extension.json`, {
    id: ID,
    name: 'Package Test',
    version: '1.0.0',
    apiVersion: 1,
    nextprob: '>=0.4.0 <1.0.0',
    platforms: ['linux-x64', 'darwin-arm64'],
    main: 'main.cjs',
  });
  write(root, `${plugin}/metadata.json`, {
    publisher: 'community',
    license: 'MIT',
    categories: ['developer'],
    summary: 'Package tooling test plugin',
    releaseNotes: 'Initial release',
  });
  write(root, `${plugin}/README.md`, '# Package Test\n');
  write(root, `${plugin}/LICENSE`, 'MIT\n');
  write(root, `${plugin}/main.cjs`, 'module.exports = () => {};\n');
  write(root, `${plugin}/package.json`, {
    name: 'package-test',
    version: '1.0.0',
    private: true,
    scripts: { build: 'node build.js' },
  });
  const buildScript = mutateExtension
    ? "const fs = require('node:fs');\nconst manifest = JSON.parse(fs.readFileSync('extension.json', 'utf8'));\nmanifest.description = 'mutated by build';\nfs.writeFileSync('extension.json', `${JSON.stringify(manifest, null, 2)}\\n`);\n"
    : "const fs = require('node:fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/built.txt', 'built\\n');\n";
  write(root, `${plugin}/build.js`, buildScript);
  return root;
}

function run(root, out, commit = COMMIT) {
  return spawnSync(process.execPath, [
    SCRIPT,
    '--root', root,
    '--plugin', ID,
    '--version', '1.0.0',
    '--source-commit', commit,
    '--out', out,
    '--skip-deps',
  ], { encoding: 'utf8' });
}

test('package produces a deterministic zip and descriptor without mutating the source', () => {
  const root = createFixture();
  try {
    const sourceBefore = fs.readdirSync(path.join(root, 'plugins', ID)).sort();
    const out1 = path.join(root, 'out1');
    const out2 = path.join(root, 'out2');
    const first = run(root, out1);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = run(root, out2);
    assert.equal(second.status, 0, second.stderr || second.stdout);

    const filename = `${ID}-1.0.0.zip`;
    const zip1 = fs.readFileSync(path.join(out1, filename));
    const zip2 = fs.readFileSync(path.join(out2, filename));
    assert.ok(zip1.equals(zip2));
    const descriptor1 = fs.readFileSync(path.join(out1, `${ID}-1.0.0.json`), 'utf8');
    const descriptor2 = fs.readFileSync(path.join(out2, `${ID}-1.0.0.json`), 'utf8');
    assert.equal(descriptor1, descriptor2);

    const descriptor = JSON.parse(descriptor1);
    assert.equal(descriptor.id, ID);
    assert.equal(descriptor.version, '1.0.0');
    assert.equal(descriptor.filename, filename);
    assert.equal(descriptor.sourceCommit, COMMIT);
    assert.match(descriptor.sha256, /^[0-9a-f]{64}$/);
    assert.equal(descriptor.size, zip1.length);
    assert.deepEqual(descriptor.platforms, ['linux-x64', 'darwin-arm64']);
    assert.deepEqual(descriptor.manifest, {
      apiVersion: 1,
      execution: 'native',
      nextprob: '>=0.4.0 <1.0.0',
      dependencies: [],
    });

    const entries = readZip(zip1);
    assert.deepEqual(entries.map(entry => entry.path), ['LICENSE', 'README.md', 'build.js', 'dist/built.txt', 'extension.json', 'main.cjs', 'metadata.json', 'package.json']);
    assert.equal(entries.find(entry => entry.path === 'dist/built.txt').data.toString(), 'built\n');
    assert.deepEqual(fs.readdirSync(path.join(root, 'plugins', ID)).sort(), sourceBefore);
    assert.equal(fs.existsSync(path.join(root, 'plugins', ID, 'dist')), false);

    const again = run(root, out1);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.match(again.stdout, /Unchanged/);

    const different = run(root, out1, 'b'.repeat(40));
    assert.equal(different.status, 1);
    assert.match(different.stderr, /Refusing to overwrite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a build that mutates extension.json is rejected', () => {
  const root = createFixture({ mutateExtension: true });
  try {
    const result = run(root, path.join(root, 'out'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Build changed extension\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
