import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDependencyGraph, validateExtension, validateMetadata } from '../lib/manifest.mjs';
import { validateOwners, validatePluginOwnership } from '../lib/ownership.mjs';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-manifest-'));
}

function write(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const base = {
  id: 'community.native',
  name: 'Native',
  version: '1.0.0',
  apiVersion: 1,
  nextprob: '>=0.4.0 <1.0.0',
  platforms: ['linux-x64'],
};

test('valid native manifest with resources and IPC', () => {
  const directory = workspace();
  try {
    write(directory, { 'main.cjs': 'module.exports = () => {};', 'style.css': 'body {}', 'asset.bin': 'x' });
    const manifest = validateExtension({
      ...base,
      main: 'main.cjs',
      styles: ['style.css'],
      ipc: { handle: ['community:run'], on: [], send: [] },
      packaging: { unpackedResources: ['asset.bin'] },
    }, { directory });
    assert.equal(manifest.execution, 'native');
    assert.deepEqual(manifest.styles, ['style.css']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('packaging.unpackedResources accepts regular directories but rejects symlinks', () => {
  const directory = workspace();
  try {
    write(directory, { 'main.cjs': 'module.exports = () => {};', 'assets/data.txt': 'x' });
    const manifest = validateExtension({
      ...base,
      main: 'main.cjs',
      packaging: { unpackedResources: ['assets'] },
    }, { directory });
    assert.deepEqual(manifest.packaging.unpackedResources, ['assets']);
    assert.throws(() => validateExtension({
      ...base,
      main: 'main.cjs',
      packaging: { unpackedResources: ['missing'] },
    }, { directory }), /does not exist/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('valid subprocess manifest', () => {
  const directory = workspace();
  try {
    const manifest = validateExtension({
      ...base,
      id: 'community.subprocess',
      hooks: [{ event: 'workspace.opened', command: 'node', args: ['hook.js'] }],
      commands: [{ id: 'run', title: 'Run', command: 'node', args: [] }],
      settings: { enabled: { type: 'boolean' } },
    }, { directory });
    assert.equal(manifest.execution, 'subprocess');
    assert.equal(manifest.hooks.length, 1);
    assert.equal(manifest.commands[0].id, 'run');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid ids, missing entry points and missing files are rejected', () => {
  const directory = workspace();
  try {
    assert.throws(() => validateExtension({ ...base, id: 'con', main: 'main.cjs' }, { directory }), /portable/);
    assert.throws(() => validateExtension({ ...base, id: 'bad/id', main: 'main.cjs' }, { directory }), /invalid/);
    assert.throws(() => validateExtension({ ...base, id: 'trailing.', main: 'main.cjs' }, { directory }), /portable|invalid/);
    assert.throws(() => validateExtension({ ...base }, { directory }), /entry point/);
    assert.throws(() => validateExtension({ ...base, main: 'missing.cjs' }, { directory }), /does not exist/);
    assert.throws(() => validateExtension({ ...base, main: '../escape.cjs' }, { directory }), /package-relative|inside/);
    assert.throws(() => validateExtension({ ...base, main: 'main.cjs', hooks: [{ event: 'workspace.opened', command: 'node' }] }, { directory }), /mix/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('metadata validates categories, summary, release notes and files', () => {
  const directory = workspace();
  try {
    write(directory, { 'icon.png': 'png', 'README.md': '# readme' });
    const metadata = validateMetadata({
      publisher: 'community',
      license: 'MIT',
      categories: ['productivity'],
      summary: 'A useful plugin',
      releaseNotes: 'First release',
      icon: 'icon.png',
      documentation: 'README.md',
      source: 'https://example.com/source',
      deprecated: false,
      withdrawn: false,
    }, { directory });
    assert.equal(metadata.publisher, 'community');
    assert.throws(() => validateMetadata({ ...metadata, categories: [] }, { directory }), /categories/);
    assert.throws(() => validateMetadata({ ...metadata, categories: ['unknown'] }, { directory }), /Unknown category/);
    assert.throws(() => validateMetadata({ ...metadata, summary: '' }, { directory }), /summary/);
    assert.throws(() => validateMetadata({ ...metadata, releaseNotes: '' }, { directory }), /releaseNotes/);
    assert.throws(() => validateMetadata({ ...metadata, icon: 'missing.png' }, { directory }), /does not exist/);
    assert.throws(() => validateMetadata({ ...metadata, source: 'http://example.com' }, { directory }), /https/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dependency cycles and unknown dependencies are rejected', () => {
  const plugin = (version, dependencies, dependencyVersions = {}) => ({
    manifest: { version, dependencies, dependencyVersions },
  });
  const cycle = new Map([
    ['community.a', plugin('1.0.0', ['community.b'])],
    ['community.b', plugin('1.0.0', ['community.a'])],
  ]);
  assert.throws(() => validateDependencyGraph(cycle), /cycle/);
  const unknown = new Map([['community.a', plugin('1.0.0', ['community.missing'])]]);
  assert.throws(() => validateDependencyGraph(unknown), /unknown plugin/);
  const satisfied = new Map([
    ['community.a', plugin('1.0.0', ['community.b'], { 'community.b': '^1.0.0' })],
    ['community.b', plugin('1.2.0', [])],
  ]);
  assert.doesNotThrow(() => validateDependencyGraph(satisfied));
  const unsatisfied = new Map([
    ['community.a', plugin('1.0.0', ['community.b'], { 'community.b': '^2.0.0' })],
    ['community.b', plugin('1.2.0', [])],
  ]);
  assert.throws(() => validateDependencyGraph(unsatisfied), /requires/);
});

test('official namespaces require official publishers', () => {
  const owners = {
    schemaVersion: 1,
    maintainers: ['maintainer'],
    officialNamespaces: ['nextprob'],
    publishers: {
      nextprob: { displayName: 'NextProb', official: true, github: ['toutkit'], url: 'https://github.com/NextProb' },
      community: { displayName: 'Community', official: false, github: ['alice'], url: 'https://example.com' },
    },
    namespaces: { nextprob: 'nextprob', community: 'community' },
  };
  assert.doesNotThrow(() => validateOwners(owners));
  assert.throws(() => validateOwners({
    ...owners,
    namespaces: { ...owners.namespaces, nextprob: 'community' },
  }), /official publisher/);
  const nonOfficial = {
    ...owners,
    officialNamespaces: [],
    publishers: { community: owners.publishers.community },
    namespaces: { community: 'community', nextprob: 'community' },
  };
  assert.doesNotThrow(() => validateOwners(nonOfficial));
  assert.throws(() => validatePluginOwnership('nextprob.export', 'community', {
    ...owners,
    plugins: { 'nextprob.export': 'community' },
  }), /official publisher/);
  assert.throws(() => validatePluginOwnership('community.a', 'nextprob', owners), /does not match/);
  const reassigned = { ...owners, plugins: { nextprob: 'community' } };
  assert.throws(() => validatePluginOwnership('nextprob', 'community', reassigned), /official publisher/);
});

test('owners reject unknown top-level and publisher fields', () => {
  const owners = {
    schemaVersion: 1,
    maintainers: ['maintainer'],
    officialNamespaces: [],
    publishers: {
      community: { displayName: 'Community', official: false, github: ['alice'], url: 'https://example.com' },
    },
    namespaces: { community: 'community' },
  };
  assert.doesNotThrow(() => validateOwners(owners));
  assert.throws(() => validateOwners({ ...owners, extra: true }), /Unknown owners\.json field: extra/);
  assert.throws(() => validateOwners({
    ...owners,
    publishers: { community: { ...owners.publishers.community, extra: true } },
  }), /Unknown publisher field for community: extra/);
});
