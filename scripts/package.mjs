import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateRepository } from './validate.mjs';
import { copyTree, readJson, walkFiles } from './lib/fs-safe.mjs';
import { validateExtension, validateMetadata } from './lib/manifest.mjs';
import { canonicalJson } from './lib/sign.mjs';
import { createZip } from './lib/zip.mjs';

const OPTIONS = new Set(['plugin', 'version', 'source-commit', 'out', 'skip-deps', 'root']);
const EXCLUDED = new Set(['.git', 'dist', 'tmp', '.DS_Store', 'node_modules', 'coverage', '.nyc_output', '.eslintcache', 'test-results', 'playwright-report']);

function parseArguments(argv) {
  const options = { skipDeps: false };
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
    if (name === 'skip-deps') {
      if (value !== undefined) throw new Error('--skip-deps does not take a value');
      options.skipDeps = true;
      continue;
    }
    if (value === undefined) {
      index += 1;
      if (index >= argv.length) throw new Error(`--${name} requires a value`);
      value = argv[index];
    }
    options[name] = value;
  }
  for (const required of ['plugin', 'version', 'source-commit', 'out']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (!/^[0-9a-f]{7,64}$/i.test(options['source-commit'])) throw new Error('--source-commit must be a hexadecimal commit SHA');
  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw new Error(`Unable to run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function writeExact(file, bytes) {
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(file);
    if (existing.equals(bytes)) return false;
    throw new Error(`Refusing to overwrite existing output with different bytes: ${file}`);
  }
}

export async function packagePlugin(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(options.root || process.cwd());
  const { plugins } = validateRepository(root);
  const plugin = plugins.get(options.plugin);
  if (!plugin) throw new Error(`Unknown plugin: ${options.plugin}`);
  if (options.version !== plugin.manifest.version) throw new Error(`--version ${options.version} does not match manifest version ${plugin.manifest.version}`);
  const out = path.resolve(options.out);
  if (out === plugin.directory || out.startsWith(`${plugin.directory}${path.sep}`)) throw new Error('Output directory must be outside the plugin directory');
  fs.mkdirSync(out, { recursive: true });

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nextprob-package-'));
  try {
    const staged = path.join(stagingRoot, plugin.id);
    copyTree(plugin.directory, staged, {
      skip: (relative, stat, name) => EXCLUDED.has(name),
    });

    const packageJsonFile = path.join(staged, 'package.json');
    const packageJson = fs.existsSync(packageJsonFile) ? JSON.parse(fs.readFileSync(packageJsonFile, 'utf8')) : null;
    const dependencies = packageJson?.dependencies || {};
    if (Object.keys(dependencies).length && !options.skipDeps) {
      run('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], staged);
    }
    if (packageJson?.scripts?.build) run('npm', ['run', 'build'], staged);

    const stagedManifest = validateExtension(readJson(path.join(staged, 'extension.json')), { directory: staged });
    if (stagedManifest.id !== plugin.id || stagedManifest.version !== plugin.manifest.version) throw new Error('Build changed the extension id or version');
    if (canonicalJson(stagedManifest) !== canonicalJson(plugin.manifest)) throw new Error('Build changed extension.json');
    const stagedMetadata = validateMetadata(readJson(path.join(staged, 'metadata.json')), { directory: staged });
    if (canonicalJson(stagedMetadata) !== canonicalJson(plugin.metadata)) throw new Error('Build changed metadata.json');

    const files = walkFiles(staged, {
      skip: (relative, stat, name) => {
        if (['.git', '.DS_Store', 'tmp', 'coverage', '.nyc_output', '.eslintcache', 'test-results', 'playwright-report'].includes(name)) return true;
        const parts = relative.split('/');
        return parts.includes('node_modules') && parts.includes('.bin');
      },
    });
    if (files.length > 10000) throw new Error('Package contains more than 10,000 files');
    let total = 0;
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`File exceeds 25 MiB: ${file.path}`);
      total += file.size;
    }
    if (total > 100 * 1024 * 1024) throw new Error('Package contents exceed 100 MiB');

    const entries = files.map(file => ({
      path: file.path,
      data: fs.readFileSync(file.absolute),
      executable: (file.mode & 0o111) !== 0,
    }));
    const zip = createZip(entries);
    const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
    const filename = `${plugin.id}-${plugin.manifest.version}.zip`;
    const descriptor = {
      id: plugin.id,
      version: plugin.manifest.version,
      sourceCommit: options['source-commit'].toLowerCase(),
      filename,
      sha256,
      size: zip.length,
      platforms: [...plugin.manifest.platforms],
      manifest: {
        apiVersion: plugin.manifest.apiVersion,
        execution: plugin.manifest.execution,
        nextprob: plugin.manifest.nextprob,
        dependencies: plugin.manifest.dependencies.map(id => ({
          id,
          range: plugin.manifest.dependencyVersions[id] || '*',
        })),
      },
    };
    const zipFile = path.join(out, filename);
    const descriptorFile = path.join(out, `${plugin.id}-${plugin.manifest.version}.json`);
    const wroteZip = writeExact(zipFile, zip);
    const wroteDescriptor = writeExact(descriptorFile, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`));
    process.stdout.write(`${wroteZip ? 'Wrote' : 'Unchanged'} ${zipFile}\n`);
    process.stdout.write(`sha256=${sha256} size=${zip.length}\n`);
    process.stdout.write(`${wroteDescriptor ? 'Wrote' : 'Unchanged'} ${descriptorFile}\n`);
    return descriptor;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packagePlugin().catch(error => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
