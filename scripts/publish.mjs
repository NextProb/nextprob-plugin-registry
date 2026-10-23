import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRepository } from './validate.mjs';
import { checkRelativePath, readJson } from './lib/fs-safe.mjs';
import { validateExtension, validateId, validateMetadata } from './lib/manifest.mjs';
import { assetFilename, makeVersionEntry, mergeCatalog, pluginRecord, releaseTag } from './lib/catalog.mjs';
import { canonicalJson, keyId, sign, verify, signatureFile } from './lib/sign.mjs';
import { GitHubClient } from './lib/github.mjs';
import { addWorktree, branchRevision, commitAll, removeWorktree, runGit, showFile } from './lib/git.mjs';
import { parse as parseVersion } from './lib/semver.mjs';
import { readZip } from './lib/zip.mjs';

const OPTIONS = new Set(['artifacts', 'source-commit', 'repo', 'catalog-branch', 'dry-run', 'catalog-out', 'root', 'plan']);
const IDENTITY = { name: 'nextprob-registry-bot', email: 'registry-bot@users.noreply.github.com' };
const MAX_ARTIFACT_SIZE = 100 * 1024 * 1024;
const MAX_ENTRY_SIZE = 25 * 1024 * 1024;
const MAX_ENTRIES = 10000;

function parseArguments(argv) {
  const options = { 'catalog-branch': 'catalog', 'dry-run': false };
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
    if (name === 'dry-run') {
      if (value !== undefined) throw new Error('--dry-run does not take a value');
      options['dry-run'] = true;
      continue;
    }
    if (value === undefined) {
      index += 1;
      if (index >= argv.length) throw new Error(`--${name} requires a value`);
      value = argv[index];
    }
    options[name] = value;
  }
  if (!options.artifacts) throw new Error('--artifacts is required');
  if (!options['source-commit']) throw new Error('--source-commit is required');
  if (!/^[0-9a-f]{7,64}$/i.test(options['source-commit'])) throw new Error('--source-commit must be a hexadecimal commit SHA');
  options.repo = options.repo || process.env.GITHUB_REPOSITORY;
  if (!options.repo) throw new Error('--repo or GITHUB_REPOSITORY is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) throw new Error('Repository must be owner/repo');
  if (!/^[A-Za-z0-9._-]+$/.test(options['catalog-branch'])) throw new Error('Invalid catalog branch name');
  options['source-commit'] = options['source-commit'].toLowerCase();
  options.root = path.resolve(options.root || process.cwd());
  options.artifacts = path.resolve(options.artifacts);
  if (options.plan) options.plan = path.resolve(options.plan);
  return options;
}

export function verifyArtifactArchive(descriptor, zip, expectedMetadata = null) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('Artifact descriptor is required');
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw new Error('Artifact descriptor has an invalid size');
  if (descriptor.size > MAX_ARTIFACT_SIZE) throw new Error(`Artifact ${descriptor.filename || descriptor.id} exceeds the 100 MiB limit`);
  if (!Buffer.isBuffer(zip)) throw new Error('Artifact archive must be a buffer');
  if (zip.length > MAX_ARTIFACT_SIZE) throw new Error('Artifact archive exceeds the 100 MiB limit');

  const entries = readZip(zip, {
    maxEntries: MAX_ENTRIES,
    maxEntrySize: MAX_ENTRY_SIZE,
    maxTotalSize: MAX_ARTIFACT_SIZE,
  });
  const byName = new Map();
  for (const entry of entries) {
    const name = entry.path;
    const type = entry.mode & 0o170000;
    if (name.endsWith('/') || type === 0o040000) throw new Error(`ZIP archive must not contain directory entries: ${name}`);
    if (type === 0o120000) throw new Error(`ZIP archive must not contain symbolic links: ${name}`);
    if (type !== 0 && type !== 0o100000) throw new Error(`ZIP archive contains an unsupported special entry: ${name}`);
    const safe = checkRelativePath(name, 'ZIP entry path');
    byName.set(safe, entry);
  }

  for (const name of ['extension.json', 'metadata.json', 'README.md', 'LICENSE']) {
    if (!byName.has(name)) throw new Error(`ZIP archive is missing ${name}`);
  }

  const extensionEntry = byName.get('extension.json');
  let manifestRaw;
  try {
    manifestRaw = JSON.parse(extensionEntry.data.toString('utf8'));
  } catch (error) {
    throw new Error(`extension.json in the ZIP archive is not valid JSON: ${error.message}`);
  }
  let manifest;
  try {
    manifest = validateExtension(manifestRaw);
  } catch (error) {
    throw new Error(`extension.json in the ZIP archive is invalid: ${error.message}`);
  }

  const metadataEntry = byName.get('metadata.json');
  let metadataRaw;
  try {
    metadataRaw = JSON.parse(metadataEntry.data.toString('utf8'));
  } catch (error) {
    throw new Error(`metadata.json in the ZIP archive is not valid JSON: ${error.message}`);
  }
  let metadata;
  try {
    metadata = validateMetadata(metadataRaw);
  } catch (error) {
    throw new Error(`metadata.json in the ZIP archive is invalid: ${error.message}`);
  }
  if (expectedMetadata && canonicalJson(metadata) !== canonicalJson(expectedMetadata)) {
    throw new Error('Archived metadata.json does not match the repository metadata');
  }

  const expected = descriptor.manifest || {};
  if (manifest.id !== descriptor.id) throw new Error(`Archived extension id ${manifest.id} does not match descriptor id ${descriptor.id}`);
  if (manifest.version !== descriptor.version) throw new Error(`Archived extension version ${manifest.version} does not match descriptor version ${descriptor.version}`);
  if (manifest.apiVersion !== expected.apiVersion) throw new Error('Archived extension apiVersion does not match the descriptor');
  if (manifest.execution !== expected.execution) throw new Error('Archived extension execution does not match the descriptor');
  if (manifest.nextprob !== expected.nextprob) throw new Error('Archived extension nextprob range does not match the descriptor');
  const descriptorPlatforms = Array.isArray(descriptor.platforms) ? descriptor.platforms : null;
  if (!descriptorPlatforms || canonicalJson(manifest.platforms) !== canonicalJson(descriptorPlatforms)) {
    throw new Error('Archived extension platforms do not match the descriptor');
  }
  const dependencies = manifest.dependencies.map(id => ({
    id,
    range: manifest.dependencyVersions[id] || '*',
  }));
  if (canonicalJson(dependencies) !== canonicalJson(expected.dependencies || [])) {
    throw new Error('Archived extension dependencies do not match the descriptor');
  }

  const requireFile = (reference, label) => {
    const safe = checkRelativePath(reference, label);
    if (!byName.has(safe)) throw new Error(`ZIP archive is missing ${label}: ${safe}`);
  };
  for (const key of ['main', 'renderer']) {
    if (manifest[key] !== undefined) requireFile(manifest[key], key);
  }
  for (const style of manifest.styles || []) requireFile(style, 'Style');
  if (metadata.icon !== undefined) requireFile(metadata.icon, 'Icon');
  requireFile(metadata.documentation || 'README.md', 'Documentation');
  for (const resource of manifest.packaging?.unpackedResources || []) {
    const safe = checkRelativePath(resource, 'Unpacked resource');
    const hasFile = byName.has(safe);
    const hasChild = [...byName.keys()].some(name => name.startsWith(`${safe}/`));
    if (!hasFile && !hasChild) throw new Error(`ZIP archive is missing unpacked resource: ${safe}`);
  }
  return entries;
}

export function assertPlanMatchesArtifacts(plan, artifacts) {
  const entries = plan?.changed;
  if (!Array.isArray(entries)) throw new Error('Publication plan must contain a changed array');
  const expected = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.action !== 'publish') continue;
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.version !== 'string' || !entry.version) {
      throw new Error('Publication plan contains an invalid publish entry');
    }
    expected.set(`${entry.id}@${entry.version}`, entry);
  }
  const actual = new Map();
  for (const artifact of artifacts) {
    const descriptor = artifact.descriptor || artifact;
    if (typeof descriptor.id !== 'string' || typeof descriptor.version !== 'string') {
      throw new Error('Artifact descriptor is missing an id or version');
    }
    const key = `${descriptor.id}@${descriptor.version}`;
    if (actual.has(key)) throw new Error(`Duplicate artifact for ${key}`);
    actual.set(key, descriptor);
  }
  for (const key of expected.keys()) {
    if (!actual.has(key)) throw new Error(`Publication plan requires ${key} but no matching artifact was provided`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) throw new Error(`Artifact ${key} has no matching publish action in the publication plan`);
  }
}

export function loadPlanFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { changed: [] };
    throw error;
  }
  if (!stat.isFile()) throw new Error('--plan must point to a file');
  if (stat.size === 0) return { changed: [] };
  const plan = readJson(file, { max: 5 * 1024 * 1024 });
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.changed)) throw new Error('Publication plan must contain a changed array');
  return plan;
}

export function loadCatalogPublicKeys(root) {
  const directory = path.join(root, 'keys');
  if (!fs.existsSync(directory)) return [];
  const keys = [];
  for (const name of fs.readdirSync(directory).filter(file => file.endsWith('.pem')).sort()) {
    let key;
    try {
      key = crypto.createPublicKey(fs.readFileSync(path.join(directory, name), 'utf8'));
    } catch (error) {
      throw new Error(`Invalid public key keys/${name}: ${error.message}`);
    }
    keys.push({ name, key, keyId: keyId(key) });
  }
  return keys;
}

export function verifyExistingCatalogSignature(catalog, signature, keys) {
  if (!catalog || typeof catalog !== 'object') throw new Error('Existing catalog is invalid');
  if (typeof catalog.keyId !== 'string' || !catalog.keyId) throw new Error('Existing catalog has no keyId');
  if (typeof signature !== 'string' || !signature.trim()) throw new Error('Existing catalog signature catalog.json.sig is missing');
  const key = keys.find(candidate => candidate.keyId === catalog.keyId);
  if (!key) throw new Error(`No committed public key matches existing catalog keyId ${catalog.keyId}`);
  const bytes = Buffer.from(canonicalJson(catalog));
  if (!verify(bytes, signature, key.key)) throw new Error('Existing catalog signature is invalid');
}

function loadArtifacts(options, plugins) {
  let stat;
  try {
    stat = fs.lstatSync(options.artifacts);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Artifacts directory is missing: ${options.artifacts}`);
    throw error;
  }
  if (!stat.isDirectory()) throw new Error('--artifacts must be a directory');
  const names = fs.readdirSync(options.artifacts).filter(name => name.endsWith('.json')).sort();
  const artifacts = [];
  const seen = new Set();
  for (const name of names) {
    const descriptor = readJson(path.join(options.artifacts, name), { max: 1024 * 1024 });
    validateId(descriptor.id);
    parseVersion(descriptor.version);
    if (descriptor.sourceCommit !== options['source-commit']) throw new Error(`${name} was built from a different source commit`);
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw new Error(`${name} has an invalid size`);
    if (descriptor.size > MAX_ARTIFACT_SIZE) throw new Error(`${name} exceeds the 100 MiB artifact limit`);
    if (typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) throw new Error(`${name} has an invalid sha256`);
    const expectedFilename = assetFilename(descriptor.id, descriptor.version);
    if (descriptor.filename !== expectedFilename || name !== `${descriptor.id}-${descriptor.version}.json`) throw new Error(`Artifact name does not match ${expectedFilename}`);
    if (!Array.isArray(descriptor.platforms) || !descriptor.platforms.length) throw new Error(`${name} has no platforms`);
    if (!descriptor.manifest || descriptor.manifest.apiVersion !== 1 || !['native', 'subprocess'].includes(descriptor.manifest.execution)) throw new Error(`${name} has an invalid manifest descriptor`);
    const key = `${descriptor.id}@${descriptor.version}`;
    if (seen.has(key)) throw new Error(`Duplicate artifact for ${key}`);
    seen.add(key);
    const zipFile = path.join(options.artifacts, expectedFilename);
    let zipStat;
    try {
      zipStat = fs.statSync(zipFile);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing artifact zip: ${expectedFilename}`);
      throw error;
    }
    if (!zipStat.isFile()) throw new Error(`Artifact zip is not a regular file: ${expectedFilename}`);
    if (zipStat.size > MAX_ARTIFACT_SIZE) throw new Error(`${expectedFilename} exceeds the 100 MiB artifact limit`);
    const zip = fs.readFileSync(zipFile);
    const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
    if (zip.length !== descriptor.size || sha256 !== descriptor.sha256) throw new Error(`Artifact digest mismatch: ${expectedFilename}`);
    const plugin = plugins.get(descriptor.id);
    if (!plugin) throw new Error(`Artifact plugin is not present in the repository: ${descriptor.id}`);
    if (plugin.manifest.version !== descriptor.version) throw new Error(`Artifact version for ${descriptor.id} does not match the repository`);
    verifyArtifactArchive(descriptor, zip, plugin.metadata);
    const actualManifest = {
      apiVersion: plugin.manifest.apiVersion,
      execution: plugin.manifest.execution,
      nextprob: plugin.manifest.nextprob,
      dependencies: plugin.manifest.dependencies.map(id => ({ id, range: plugin.manifest.dependencyVersions[id] || '*' })),
    };
    if (canonicalJson(actualManifest) !== canonicalJson(descriptor.manifest)) throw new Error(`Artifact manifest for ${descriptor.id} no longer matches the repository`);
    if (canonicalJson([...plugin.manifest.platforms].sort()) !== canonicalJson([...descriptor.platforms].sort())) throw new Error(`Artifact platforms for ${descriptor.id} no longer match the repository`);
    artifacts.push({ descriptor, zip, metadata: plugin.metadata });
  }
  return artifacts;
}

function readCatalogAt(root, revision) {
  if (!revision) return null;
  const text = showFile(root, revision, 'catalog.json');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid catalog.json on the catalog branch: ${error.message}`);
  }
}

function setupWorktree(root, branch) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-catalog-'));
  const directory = path.join(temporary, 'worktree');
  try {
    let revision = branchRevision(root, branch);
    if (!revision) {
      runGit(root, ['fetch', 'origin', branch], { allowFailure: true });
      revision = branchRevision(root, branch);
    }
    if (revision) {
      addWorktree(root, directory, revision);
      return { temporary, directory, orphan: false };
    }
    addWorktree(root, directory, 'HEAD');
    runGit(directory, ['checkout', '--orphan', branch]);
    runGit(directory, ['rm', '-rf', '.'], { allowFailure: true });
    return { temporary, directory, orphan: true };
  } catch (error) {
    removeWorktree(root, directory);
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function buildUpdates(existing, plugins, owners, artifacts, repo, now) {
  const existingPlugins = new Map((existing?.plugins || []).map(plugin => [plugin.id, plugin]));
  const artifactIds = new Set(artifacts.map(artifact => artifact.descriptor.id));
  const updates = new Map();
  for (const [id, plugin] of plugins) {
    if (!artifactIds.has(id) && !existingPlugins.has(id)) continue;
    updates.set(id, { id, record: pluginRecord(id, plugin.metadata, owners), versions: [] });
  }
  for (const artifact of artifacts) {
    const update = updates.get(artifact.descriptor.id);
    const previous = existingPlugins.get(artifact.descriptor.id)?.versions?.find(version => version.version === artifact.descriptor.version);
    const entry = makeVersionEntry({
      descriptor: artifact.descriptor,
      metadata: artifact.metadata,
      repo,
      existing: previous,
      now,
    });
    update.versions.push(entry);
  }
  return [...updates.values()];
}

async function verifyAsset(client, repo, asset, descriptor, zip) {
  if (!asset) throw new Error(`Release is missing ${descriptor.filename}`);
  if (asset.name !== descriptor.filename) throw new Error(`Unexpected release asset: ${asset.name}`);
  if (asset.size !== descriptor.size) throw new Error(`Release asset size mismatch for ${descriptor.filename}`);
  if (typeof asset.digest === 'string') {
    const [algorithm, digest] = asset.digest.split(':', 2);
    if (algorithm === 'sha256') {
      if (digest.toLowerCase() !== descriptor.sha256) throw new Error(`Release asset digest mismatch for ${descriptor.filename}`);
      return;
    }
  }
  const downloaded = await client.downloadAsset(asset.url);
  const sha256 = crypto.createHash('sha256').update(downloaded).digest('hex');
  if (downloaded.length !== descriptor.size || sha256 !== descriptor.sha256) throw new Error(`Release asset digest mismatch for ${descriptor.filename}`);
  if (downloaded.length !== zip.length || !downloaded.equals(zip)) throw new Error(`Release asset bytes differ for ${descriptor.filename}`);
}

async function ensureRelease(client, repo, artifact, sourceCommit) {
  const { descriptor, zip } = artifact;
  const tag = releaseTag(descriptor.id, descriptor.version);
  let release = await client.getReleaseByTag(repo, tag);
  if (!release) {
    const releases = await client.listReleases(repo);
    release = (releases || []).find(item => item.tag_name === tag) || null;
  }
  if (!release) {
    try {
      release = await client.createRelease(repo, {
        tag_name: tag,
        target_commitish: sourceCommit,
        name: `${descriptor.id} v${descriptor.version}`,
        body: artifact.metadata.releaseNotes,
        draft: true,
        prerelease: false,
      });
      process.stdout.write(`Created draft release ${tag}\n`);
    } catch (error) {
      const releases = await client.listReleases(repo);
      release = (releases || []).find(item => item.tag_name === tag) || null;
      if (!release) throw error;
    }
  }
  const assets = release.assets?.length ? release.assets : await client.listReleaseAssets(repo, release.id);
  let asset = assets.find(item => item.name === descriptor.filename);
  if (asset) {
    await verifyAsset(client, repo, asset, descriptor, zip);
    process.stdout.write(`Verified existing asset ${descriptor.filename}\n`);
  } else {
    if (release.draft === false) throw new Error(`Published release ${tag} is missing ${descriptor.filename}; refusing to modify it`);
    try {
      const uploaded = await client.uploadReleaseAsset(repo, release.id, descriptor.filename, zip);
      asset = uploaded?.url && uploaded.size !== undefined ? uploaded : await client.getReleaseAsset(repo, uploaded.id);
    } catch (error) {
      const refreshed = await client.listReleaseAssets(repo, release.id);
      asset = refreshed.find(item => item.name === descriptor.filename);
      if (!asset) throw error;
    }
    await verifyAsset(client, repo, asset, descriptor, zip);
    process.stdout.write(`Uploaded ${descriptor.filename}\n`);
  }
  if (release.draft) {
    const updated = await client.updateRelease(repo, release.id, { draft: false, make_latest: 'false' });
    if (!updated || updated.draft) throw new Error(`Release ${tag} is still a draft`);
    process.stdout.write(`Published release ${tag}\n`);
  } else {
    process.stdout.write(`Release ${tag} is already published\n`);
  }
}

function writeCatalog(file, catalog, signature) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canonicalJson(catalog));
  if (signature) fs.writeFileSync(`${file}.sig`, signatureFile(signature));
  else fs.rmSync(`${file}.sig`, { force: true });
}

export async function publish(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const { owners, plugins } = validateRepository(options.root);
  const artifacts = loadArtifacts(options, plugins);
  if (options.plan) assertPlanMatchesArtifacts(loadPlanFile(options.plan), artifacts);
  const publicKeys = loadCatalogPublicKeys(options.root);
  const privatePem = process.env.CATALOG_SIGNING_KEY;
  const dryRun = options['dry-run'];
  if (!dryRun && !process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required unless --dry-run is used');
  if (!dryRun && !privatePem) throw new Error('CATALOG_SIGNING_KEY is required unless --dry-run is used');

  let signingKey = null;
  let signingKeyId = null;
  if (privatePem) {
    try {
      signingKey = crypto.createPrivateKey(privatePem);
    } catch (error) {
      throw new Error(`Invalid CATALOG_SIGNING_KEY: ${error.message}`);
    }
    signingKeyId = keyId(signingKey);
    const publicFile = path.join(options.root, 'keys', 'catalog-signing-public.pem');
    if (fs.existsSync(publicFile)) {
      const publicKey = crypto.createPublicKey(fs.readFileSync(publicFile, 'utf8'));
      if (keyId(publicKey) !== signingKeyId) throw new Error('CATALOG_SIGNING_KEY does not match keys/catalog-signing-public.pem');
    }
  }

  let existing = null;
  let worktree = null;
  try {
    if (dryRun) {
      const revision = branchRevision(options.root, options['catalog-branch']);
      existing = readCatalogAt(options.root, revision);
      if (existing) {
        const signature = revision ? showFile(options.root, revision, 'catalog.json.sig') : null;
        if (signature) verifyExistingCatalogSignature(existing, signature, publicKeys);
      }
    } else {
      worktree = setupWorktree(options.root, options['catalog-branch']);
      const catalogFile = path.join(worktree.directory, 'catalog.json');
      if (fs.existsSync(catalogFile)) {
        try {
          existing = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
        } catch (error) {
          throw new Error(`Invalid catalog.json on the catalog branch: ${error.message}`);
        }
        const signaturePath = path.join(worktree.directory, 'catalog.json.sig');
        if (!fs.existsSync(signaturePath)) throw new Error('Existing catalog signature catalog.json.sig is missing');
        verifyExistingCatalogSignature(existing, fs.readFileSync(signaturePath, 'utf8'), publicKeys);
      }
    }

    if (!dryRun) {
      const client = new GitHubClient({ token: process.env.GITHUB_TOKEN });
      for (const artifact of artifacts) await ensureRelease(client, options.repo, artifact, options['source-commit']);
    } else {
      for (const artifact of artifacts) process.stdout.write(`Would publish ${releaseTag(artifact.descriptor.id, artifact.descriptor.version)}\n`);
    }

    const now = new Date().toISOString();
    const effectiveKeyId = signingKeyId || existing?.keyId || '0'.repeat(64);
    const updates = buildUpdates(existing, plugins, owners, artifacts, options.repo, now);
    const { catalog, changed } = mergeCatalog(existing, updates, {
      sourceCommit: options['source-commit'],
      keyId: effectiveKeyId,
      now,
    });

    if (options['catalog-out']) {
      let signature = null;
      if (signingKey) {
        const bytes = Buffer.from(canonicalJson(catalog));
        signature = sign(bytes, signingKey);
        if (!verify(bytes, signature, crypto.createPublicKey(signingKey))) throw new Error('Catalog signature failed verification');
      } else {
        process.stderr.write('warning: CATALOG_SIGNING_KEY is not set; catalog output is unsigned\n');
      }
      writeCatalog(path.resolve(options['catalog-out']), catalog, signature);
      process.stdout.write(`Wrote catalog to ${path.resolve(options['catalog-out'])}\n`);
    }

    if (!dryRun && changed && worktree) {
      const bytes = Buffer.from(canonicalJson(catalog));
      if (!signingKey) throw new Error('CATALOG_SIGNING_KEY is required to publish the catalog');
      const signature = sign(bytes, signingKey);
      if (!verify(bytes, signature, crypto.createPublicKey(signingKey))) throw new Error('Catalog signature failed verification');
      writeCatalog(path.join(worktree.directory, 'catalog.json'), catalog, signature);
      commitAll(worktree.directory, `catalog: ${options['source-commit']}`, IDENTITY);
      runGit(worktree.directory, ['push', 'origin', `HEAD:refs/heads/${options['catalog-branch']}`]);
      process.stdout.write(`Updated ${options['catalog-branch']} branch\n`);
    } else if (!dryRun) {
      process.stdout.write('Catalog is unchanged\n');
    }

    process.stdout.write(`catalogVersion=${catalog.catalogVersion} plugins=${catalog.plugins.length}\n`);
    return catalog;
  } finally {
    if (worktree) {
      removeWorktree(options.root, worktree.directory);
      fs.rmSync(worktree.temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  publish().catch(error => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
