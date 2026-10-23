import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, validateSourceTree } from './lib/fs-safe.mjs';
import { validateExtension, validateMetadata, validateDependencyGraph, validatePackageJson, validateId } from './lib/manifest.mjs';
import { loadOwners, validateOwners, validatePluginOwnership, assertOwnershipAuthorization } from './lib/ownership.mjs';
import { changedPluginFiles, listTags, resolveCommit, showFile, tagVersion, zeroCommit } from './lib/git.mjs';
import { compare, parse as parseVersion, format } from './lib/semver.mjs';

const REQUIRED_FILES = new Set(['extension.json', 'metadata.json', 'README.md', 'LICENSE']);
const METADATA_FILES = new Set(['metadata.json', 'README.md', 'LICENSE']);
const OPTIONS = new Set(['base', 'head', 'all', 'author', 'plan', 'root', 'no-tags', 'allow-published']);

export function parseArguments(argv) {
  const options = { all: false, noTags: false, allowPublished: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    let name = token.slice(2);
    let value;
    const equals = name.indexOf('=');
    if (equals >= 0) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (!OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (name === 'all' || name === 'no-tags' || name === 'allow-published') {
      if (value !== undefined) throw new Error(`--${name} does not take a value`);
      if (name === 'all') options.all = true;
      else if (name === 'no-tags') options.noTags = true;
      else options.allowPublished = true;
      continue;
    }
    if (value === undefined) {
      index += 1;
      if (index >= argv.length) throw new Error(`--${name} requires a value`);
      value = argv[index];
    }
    options[name] = value;
  }
  if (Boolean(options.base) !== Boolean(options.head)) throw new Error('--base and --head must be provided together');
  return options;
}

function pluginDirectories(root) {
  const directory = path.join(root, 'plugins');
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('plugins directory is missing');
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('plugins must be a real directory');
  const names = fs.readdirSync(directory).sort();
  const result = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    validateId(name, 'Plugin directory');
    const absolute = path.join(directory, name);
    const pluginStat = fs.lstatSync(absolute);
    if (pluginStat.isSymbolicLink() || !pluginStat.isDirectory()) throw new Error(`Plugin entry must be a real directory: plugins/${name}`);
    result.push({ id: name, directory: absolute });
  }
  return result;
}

function validateSchemas(root) {
  const directory = path.join(root, 'schemas');
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('schemas directory is missing');
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('schemas must be a real directory');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  for (const file of files) readJson(path.join(directory, file), { max: 5 * 1024 * 1024 });
}

export function validateRepository(root) {
  const owners = validateOwners(loadOwners(root));
  validateSchemas(root);
  const plugins = new Map();
  for (const entry of pluginDirectories(root)) {
    const files = validateSourceTree(entry.directory);
    const names = new Set(files.map(file => file.path));
    for (const required of REQUIRED_FILES) {
      if (!names.has(required)) throw new Error(`Plugin ${entry.id} is missing ${required}`);
    }
    const manifestRaw = readJson(path.join(entry.directory, 'extension.json'));
    const metadataRaw = readJson(path.join(entry.directory, 'metadata.json'));
    const manifest = validateExtension(manifestRaw, { directory: entry.directory });
    if (manifest.id !== entry.id) throw new Error(`Plugin directory ${entry.id} contains manifest id ${manifest.id}`);
    const metadata = validateMetadata(metadataRaw, { directory: entry.directory });
    validatePluginOwnership(entry.id, metadata.publisher, owners);
    validatePackageJson(entry.directory, manifest);
    plugins.set(entry.id, { id: entry.id, directory: entry.directory, manifest, metadata, files });
  }
  validateDependencyGraph(plugins);
  return { owners, plugins };
}

function baseOwners(root, base) {
  if (!base || zeroCommit(base)) return null;
  const text = showFile(root, base, 'owners.json');
  if (!text) return null;
  try {
    return validateOwners(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid owners.json at base: ${error.message}`);
  }
}

function normalizeRevision(root, revision) {
  if (!revision || zeroCommit(revision)) return null;
  return resolveCommit(root, revision);
}

export function buildPlan({ root, base = null, head = null, all = false, noTags = false, allowPublished = false, plugins }) {
  if (head && zeroCommit(head)) throw new Error('--head must not be the all-zero commit');
  let baseCommit = normalizeRevision(root, base);
  let headCommit = normalizeRevision(root, head);
  const plan = {
    base: baseCommit || (base && zeroCommit(base) ? base : null),
    head: headCommit || null,
    changed: [],
  };
  if (!all && !(base && head)) {
    return plan;
  }

  let changes;
  if (all || zeroCommit(base)) {
    changes = [...plugins.keys()].map(id => ({ status: 'M', path: `plugins/${id}` }));
  } else {
    changes = changedPluginFiles(root, baseCommit, headCommit);
  }

  const grouped = new Map();
  for (const change of changes) {
    const parts = change.path.split('/');
    if (parts.length < 2 || parts[0] !== 'plugins' || !parts[1]) throw new Error(`Unexpected plugin path: ${change.path}`);
    const id = parts[1];
    validateId(id, 'Changed plugin id');
    if (!grouped.has(id)) grouped.set(id, { files: new Set() });
    const group = grouped.get(id);
    if (change.status.startsWith('D')) {
      if (!plugins.has(id)) throw new Error(`Plugin deletions are not allowed: ${change.path}`);
      continue;
    }
    if (change.path === `plugins/${id}`) continue;
    group.files.add(change.path.slice(`plugins/${id}/`.length));
  }

  for (const id of [...grouped.keys()].sort()) {
    const group = grouped.get(id);
    const plugin = plugins.get(id);
    if (!plugin) throw new Error(`Plugin deletion is not allowed: ${id}`);
    const tags = listTags(root, id);
    const version = plugin.manifest.version;
    const expectedTag = `${id}-v${version}`;
    const metadataOnly = group.files.size > 0
      && [...group.files].every(file => METADATA_FILES.has(file))
      && tags.includes(expectedTag);
    const action = metadataOnly ? 'metadata' : 'publish';
    if (action === 'publish' && !noTags) {
      const alreadyPublished = tags.includes(expectedTag);
      if (!(allowPublished && alreadyPublished)) {
        if (alreadyPublished) throw new Error(`Version ${version} of ${id} is already published; bump the version`);
        for (const tag of tags) {
          let published;
          try {
            published = parseVersion(tagVersion(id, tag));
          } catch {
            throw new Error(`Invalid version tag: ${tag}`);
          }
          if (compare(published, version) >= 0) throw new Error(`Version ${version} of ${id} must be greater than published ${format(published)}`);
        }
      }
    }
    plan.changed.push({ id, version: plugin.manifest.version, action });
  }
  return plan;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(options.root || process.cwd());
  const { owners, plugins } = validateRepository(root);
  const author = options.author ? options.author.toLowerCase() : '';
  if (author) {
    const base = baseOwners(root, options.base);
    assertOwnershipAuthorization(author, base, owners, []);
  }
  const plan = buildPlan({
    root,
    base: options.base,
    head: options.head,
    all: options.all,
    noTags: options.noTags,
    allowPublished: options.allowPublished,
    plugins,
  });
  if (author) {
    const base = baseOwners(root, options.base);
    assertOwnershipAuthorization(author, base, owners, plan.changed.map(item => item.id));
  }
  if (options.plan) {
    const file = path.resolve(options.plan);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  }
  const publish = plan.changed.filter(item => item.action === 'publish').length;
  const metadata = plan.changed.filter(item => item.action === 'metadata').length;
  for (const item of plan.changed) process.stdout.write(`${item.id} ${item.version} ${item.action}\n`);
  process.stdout.write(`Validated ${plugins.size} plugin(s); ${publish} publish, ${metadata} metadata.\n`);
  if (options.plan) process.stdout.write(`Plan written to ${path.resolve(options.plan)}\n`);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
