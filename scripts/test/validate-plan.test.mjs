import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'validate.mjs');

const owners = {
  schemaVersion: 1,
  maintainers: ['maintainer'],
  officialNamespaces: ['nextprob'],
  publishers: {
    nextprob: { displayName: 'NextProb', official: true, github: ['toutkit', 'bob'], url: 'https://github.com/NextProb' },
    community: { displayName: 'Community', official: false, github: ['alice'], url: 'https://example.com' },
  },
  namespaces: { nextprob: 'nextprob', community: 'community' },
};

function extension(version = '1.0.0', description = 'Alpha') {
  return {
    id: 'community.alpha',
    name: 'Alpha',
    description,
    version,
    apiVersion: 1,
    nextprob: '>=0.4.0 <1.0.0',
    platforms: ['linux-x64'],
    hooks: [{ event: 'workspace.opened', command: 'node', args: ['hook.js'] }],
  };
}

function metadata(summary = 'Alpha plugin') {
  return {
    publisher: 'community',
    license: 'MIT',
    categories: ['productivity'],
    summary,
    releaseNotes: 'First release',
  };
}

function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-plan-'));
  write(root, 'owners.json', owners);
  write(root, 'schemas/plugin.schema.json', { $schema: 'https://json-schema.org/draft/2020-12/schema' });
  const plugin = 'plugins/community.alpha';
  write(root, `${plugin}/extension.json`, extension());
  write(root, `${plugin}/metadata.json`, metadata());
  write(root, `${plugin}/README.md`, '# Alpha\n');
  write(root, `${plugin}/LICENSE`, 'MIT\n');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  const mustGit = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  mustGit('init', '-b', 'main');
  mustGit('config', 'user.name', 'Test');
  mustGit('config', 'user.email', 'test@example.com');
  mustGit('config', 'commit.gpgsign', 'false');
  mustGit('add', '-A');
  mustGit('commit', '-m', 'initial');
  const initial = mustGit('rev-parse', 'HEAD');
  return { root, git, mustGit, initial };
}

function commit(repository, message) {
  repository.mustGit('add', '-A');
  repository.mustGit('commit', '-m', message);
  return repository.mustGit('rev-parse', 'HEAD');
}

function validate(repository, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repository.root, encoding: 'utf8' });
}

function plan(repository, args, name = 'plan.json') {
  const file = path.join(repository.root, name);
  const result = validate(repository, [...args, '--plan', file]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('changed plan distinguishes metadata-only updates from publication', () => {
  const repository = createRepository();
  try {
    repository.mustGit('tag', 'community.alpha-v1.0.0');
    write(repository.root, 'plugins/community.alpha/metadata.json', metadata('Updated summary'));
    const metadataHead = commit(repository, 'metadata');
    const metadataPlan = plan(repository, ['--base', repository.initial, '--head', metadataHead]);
    assert.deepEqual(metadataPlan.changed, [{ id: 'community.alpha', version: '1.0.0', action: 'metadata' }]);

    write(repository.root, 'plugins/community.alpha/extension.json', extension('1.1.0', 'Updated'));
    const publishHead = commit(repository, 'version');
    const publishPlan = plan(repository, ['--base', repository.initial, '--head', publishHead], 'plan2.json');
    assert.deepEqual(publishPlan.changed, [{ id: 'community.alpha', version: '1.1.0', action: 'publish' }]);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('first push and all-zero base publish every plugin', () => {
  const repository = createRepository();
  try {
    const result = validate(repository, ['--base', '0'.repeat(40), '--head', repository.initial, '--plan', path.join(repository.root, 'plan.json')]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(fs.readFileSync(path.join(repository.root, 'plan.json'), 'utf8'));
    assert.deepEqual(value.changed, [{ id: 'community.alpha', version: '1.0.0', action: 'publish' }]);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('published versions are immutable and must increase', () => {
  const repository = createRepository();
  try {
    repository.mustGit('tag', 'community.alpha-v1.0.0');
    write(repository.root, 'plugins/community.alpha/extension.json', extension('1.0.0', 'Changed'));
    const head = commit(repository, 'change');
    const result = validate(repository, ['--base', repository.initial, '--head', head]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already published/);
    const bypass = validate(repository, ['--base', repository.initial, '--head', head, '--no-tags']);
    assert.equal(bypass.status, 0, bypass.stderr);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }

  const older = createRepository();
  try {
    older.mustGit('tag', 'community.alpha-v2.0.0');
    write(older.root, 'plugins/community.alpha/extension.json', extension('1.0.0', 'Changed'));
    const head = commit(older, 'change');
    const result = validate(older, ['--base', older.initial, '--head', head]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /greater than published/);
  } finally {
    fs.rmSync(older.root, { recursive: true, force: true });
  }
});

test('manual retry mode keeps already-published versions as publish actions', () => {
  const repository = createRepository();
  try {
    repository.mustGit('tag', 'community.alpha-v1.0.0');
    const result = validate(repository, ['--all', '--allow-published', '--plan', path.join(repository.root, 'plan.json')]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(fs.readFileSync(path.join(repository.root, 'plan.json'), 'utf8'));
    assert.deepEqual(value.changed, [{ id: 'community.alpha', version: '1.0.0', action: 'publish' }]);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('metadata-only change on an untagged current version is a publish action', () => {
  const repository = createRepository();
  try {
    repository.mustGit('tag', 'community.alpha-v0.9.0');
    write(repository.root, 'plugins/community.alpha/metadata.json', metadata('Updated summary'));
    const head = commit(repository, 'metadata');
    const value = plan(repository, ['--base', repository.initial, '--head', head]);
    assert.deepEqual(value.changed, [{ id: 'community.alpha', version: '1.0.0', action: 'publish' }]);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('plugin deletion is rejected', () => {
  const repository = createRepository();
  try {
    fs.rmSync(path.join(repository.root, 'plugins/community.alpha'), { recursive: true });
    const head = commit(repository, 'delete');
    const result = validate(repository, ['--base', repository.initial, '--head', head]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deletion/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('non-maintainers cannot change ownership or maintainers', () => {
  const repository = createRepository();
  try {
    const changed = structuredClone(owners);
    changed.publishers.nextprob.github.push('alice');
    write(repository.root, 'owners.json', changed);
    const head = commit(repository, 'owners');
    const denied = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'alice']);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /not a maintainer in the base branch and cannot change ownership or maintainers/);
    const allowed = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'maintainer']);
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('a non-maintainer cannot add themselves as a maintainer', () => {
  const repository = createRepository();
  try {
    const changed = structuredClone(owners);
    changed.maintainers.push('alice');
    write(repository.root, 'owners.json', changed);
    const head = commit(repository, 'owners');
    const denied = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'alice']);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /not a maintainer in the base branch and cannot change ownership or maintainers/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('a non-maintainer cannot register a new publisher or namespace', () => {
  const repository = createRepository();
  try {
    const changed = structuredClone(owners);
    changed.publishers.alice = { displayName: 'Alice', official: false, github: ['alice'], url: 'https://example.com/alice' };
    changed.namespaces.alice = 'alice';
    write(repository.root, 'owners.json', changed);
    const head = commit(repository, 'owners');
    const denied = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'alice']);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /not a maintainer in the base branch and cannot change ownership or maintainers/);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test('native plugins cannot depend on subprocess plugins through the PR validator', () => {
  function createDependencyRepository({ targetSubprocess }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-deps-'));
    write(root, 'owners.json', owners);
    write(root, 'schemas/plugin.schema.json', { $schema: 'https://json-schema.org/draft/2020-12/schema' });
    const target = {
      id: 'community.beta',
      name: 'Beta',
      description: 'Beta',
      version: '1.0.0',
      apiVersion: 1,
      nextprob: '>=0.4.0 <1.0.0',
      platforms: ['linux-x64'],
    };
    if (targetSubprocess) target.hooks = [{ event: 'workspace.opened', command: 'node', args: ['hook.js'] }];
    else target.main = 'main.cjs';
    write(root, 'plugins/community.beta/extension.json', target);
    write(root, 'plugins/community.beta/metadata.json', metadata('Beta plugin'));
    write(root, 'plugins/community.beta/README.md', '# Beta\n');
    write(root, 'plugins/community.beta/LICENSE', 'MIT\n');
    if (!targetSubprocess) write(root, 'plugins/community.beta/main.cjs', 'module.exports = {};\n');

    write(root, 'plugins/community.alpha/extension.json', {
      id: 'community.alpha',
      name: 'Alpha',
      description: 'Alpha',
      version: '1.0.0',
      apiVersion: 1,
      nextprob: '>=0.4.0 <1.0.0',
      platforms: ['linux-x64'],
      main: 'main.cjs',
      dependencies: ['community.beta'],
      dependencyVersions: { 'community.beta': '^1.0.0' },
    });
    write(root, 'plugins/community.alpha/metadata.json', metadata());
    write(root, 'plugins/community.alpha/README.md', '# Alpha\n');
    write(root, 'plugins/community.alpha/LICENSE', 'MIT\n');
    write(root, 'plugins/community.alpha/main.cjs', 'module.exports = {};\n');

    const mustGit = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    mustGit('init', '-b', 'main');
    mustGit('config', 'user.name', 'Test');
    mustGit('config', 'user.email', 'test@example.com');
    mustGit('config', 'commit.gpgsign', 'false');
    mustGit('add', '-A');
    mustGit('commit', '-m', 'dependencies');
    return { root, validate: () => spawnSync(process.execPath, [SCRIPT, '--all', '--no-tags'], { cwd: root, encoding: 'utf8' }) };
  }

  const rejected = createDependencyRepository({ targetSubprocess: true });
  try {
    const result = rejected.validate();
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /community\.alpha \(native\) cannot depend on subprocess plugin community\.beta; native activation supports native dependencies only/);
  } finally {
    fs.rmSync(rejected.root, { recursive: true, force: true });
  }

  const accepted = createDependencyRepository({ targetSubprocess: false });
  try {
    const result = accepted.validate();
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(accepted.root, { recursive: true, force: true });
  }
});

test('authorization rejects unknown and unauthorized authors', () => {
  const repository = createRepository();
  try {
    write(repository.root, 'plugins/community.alpha/metadata.json', metadata('Updated summary'));
    const head = commit(repository, 'metadata');
    const unknown = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'nobody']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown PR author/);
    const unauthorized = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'bob']);
    assert.equal(unauthorized.status, 1);
    assert.match(unauthorized.stderr, /does not own/);
    const authorized = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'alice']);
    assert.equal(authorized.status, 0, authorized.stderr);
    const maintainer = validate(repository, ['--base', repository.initial, '--head', head, '--author', 'maintainer']);
    assert.equal(maintainer.status, 0, maintainer.stderr);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});
