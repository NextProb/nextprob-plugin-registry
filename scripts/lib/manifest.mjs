import fs from 'node:fs';
import path from 'node:path';
import { readJson, resolvePath, resolveResource } from './fs-safe.mjs';
import { parse as parseVersion, satisfies, validRange } from './semver.mjs';

export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
export const CATEGORIES = new Set(['export', 'publishing', 'automation', 'integration', 'productivity', 'developer', 'theme']);
export const EVENTS = new Set(['workspace.opened', 'workspace.closing', 'workspace.filesChanged', 'note.opened']);

const ZONES = new Set(['rightPanel', 'sidebarFooter', 'bottomBar', 'sidebar', 'noteMenu', 'mainTab']);
const VIEW_ZONES = new Set(['rightPanel', 'sidebar', 'mainTab']);
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const EXTENSION_KEYS = new Set([
  'id', 'name', 'description', 'version', 'apiVersion', 'nextprob', 'platforms',
  'main', 'renderer', 'styles', 'dependencies', 'dependencyVersions', 'ipc',
  'packaging', 'hooks', 'commands', 'service', 'settings', 'contributes',
]);
const METADATA_KEYS = new Set([
  'publisher', 'license', 'categories', 'summary', 'releaseNotes', 'displayName',
  'icon', 'documentation', 'source', 'homepage', 'deprecated', 'withdrawn', 'replacement',
]);

export function validateId(value, label = 'Plugin id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`${label} is invalid: ${value}`);
  if (RESERVED_WINDOWS.test(value) || value.endsWith('.')) throw new Error(`${label} is not a portable folder name: ${value}`);
  return value;
}

function validateStringArray(value, label, { max = Infinity } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label} has too many entries`);
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.includes('\0')) throw new Error(`${label} must contain non-empty strings`);
  }
  return value;
}

function executable(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (typeof value.command !== 'string' || !value.command.trim() || value.command.includes('\0')) throw new Error(`${label} requires a command`);
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 128) throw new Error(`${label} args must be an array`);
    for (const arg of value.args) {
      if (typeof arg !== 'string' || arg.includes('\0') || arg.length > 16384) throw new Error(`${label} args must be strings`);
    }
  }
  return { command: value.command, args: value.args || [] };
}

function validateContributes(value, directory, commandIds) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('contributes must be an array of at most 100 entries');
  const ids = new Set();
  const result = [];
  for (const contribution of value) {
    if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) throw new Error('Invalid UI contribution');
    validateId(contribution.id, 'UI contribution id');
    if (ids.has(contribution.id)) throw new Error(`Duplicate UI contribution: ${contribution.id}`);
    ids.add(contribution.id);
    if (!ZONES.has(contribution.zone)) throw new Error(`Invalid UI zone: ${contribution.zone}`);
    if (typeof contribution.title !== 'string' || !contribution.title.trim() || contribution.title.length > 200) throw new Error('UI contribution requires a title');
    if (contribution.icon !== undefined && (typeof contribution.icon !== 'string' || contribution.icon.length > 100)) throw new Error('Invalid UI icon');
    if (contribution.command !== undefined && !commandIds.has(contribution.command)) throw new Error('UI contribution references an unknown command');
    if (contribution.view !== undefined) {
      if (!VIEW_ZONES.has(contribution.zone)) throw new Error('UI views require a view-capable zone');
      if (typeof contribution.view !== 'string' || !contribution.view || contribution.view.length > 1024) throw new Error('UI view must be a relative HTML file');
      if (!/\.html?$/i.test(contribution.view)) throw new Error('UI view must be an HTML file');
      if (directory) resolveResource(directory, contribution.view, 'UI view');
      else {
        if (contribution.view.includes('\\') || contribution.view.includes('\0') || path.posix.isAbsolute(contribution.view) || path.win32.isAbsolute(contribution.view)) throw new Error('UI view must be package-relative');
        if (contribution.view.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('UI view must stay inside the package');
      }
    }
    if (!contribution.command && !contribution.view) throw new Error('UI contribution requires a command or view');
    if (contribution.zone === 'noteMenu' && !contribution.command) throw new Error('Note menu contributions require a command');
    if (contribution.when !== undefined && !['note', 'workspace'].includes(contribution.when)) throw new Error('Invalid UI visibility condition');
    if (contribution.order !== undefined && (!Number.isFinite(contribution.order) || Math.abs(contribution.order) > 100000)) throw new Error('Invalid UI order');
    result.push(contribution);
  }
  return result;
}

function validateIpc(ipc) {
  if (ipc === undefined) return undefined;
  if (!ipc || typeof ipc !== 'object' || Array.isArray(ipc)) throw new Error('ipc must be an object');
  for (const key of Object.keys(ipc)) {
    if (!['handle', 'on', 'send'].includes(key)) throw new Error(`Unknown ipc field: ${key}`);
  }
  const result = {};
  for (const kind of ['handle', 'on', 'send']) {
    if (ipc[kind] === undefined) continue;
    if (!Array.isArray(ipc[kind])) throw new Error(`ipc.${kind} must be an array`);
    for (const channel of ipc[kind]) {
      if (typeof channel !== 'string' || !channel || channel.includes('\0') || channel.startsWith('extensions:')) throw new Error('Invalid IPC channel');
    }
    if (new Set(ipc[kind]).size !== ipc[kind].length) throw new Error(`ipc.${kind} channels must be unique`);
    result[kind] = ipc[kind];
  }
  return result;
}

export function validateExtension(raw, { directory = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('extension.json must be an object');
  for (const key of Object.keys(raw)) {
    if (!EXTENSION_KEYS.has(key)) throw new Error(`Unknown extension field: ${key}`);
  }
  validateId(raw.id);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200) throw new Error('Extension requires a name of at most 200 characters');
  if (raw.description !== undefined && typeof raw.description !== 'string') throw new Error('description must be a string');
  if (raw.apiVersion !== 1) throw new Error('apiVersion must be 1');
  parseVersion(raw.version);
  if (typeof raw.nextprob !== 'string' || !validRange(raw.nextprob)) throw new Error('nextprob must be a valid semver range');
  if (!satisfies('0.4.0', raw.nextprob)) throw new Error('nextprob must include 0.4.0');
  if (!Array.isArray(raw.platforms) || !raw.platforms.length) throw new Error('platforms must be a non-empty array');
  const platforms = new Set();
  for (const platform of raw.platforms) {
    if (!PLATFORMS.has(platform)) throw new Error(`Unsupported platform: ${platform}`);
    if (platforms.has(platform)) throw new Error(`Duplicate platform: ${platform}`);
    platforms.add(platform);
  }

  const nativeEntries = ['main', 'renderer'].filter(key => raw[key] !== undefined);
  const subprocessEntries = ['hooks', 'commands', 'service'].filter(key => {
    if (raw[key] === undefined) return false;
    if (key === 'service') return true;
    return Array.isArray(raw[key]) && raw[key].length > 0;
  });
  if (!nativeEntries.length && !subprocessEntries.length) throw new Error('Extension requires a native or subprocess entry point');
  if (nativeEntries.length && subprocessEntries.length) throw new Error('Extension cannot mix native and subprocess entry points');

  const result = {
    ...raw,
    execution: nativeEntries.length ? 'native' : 'subprocess',
    platforms: [...raw.platforms],
    dependencies: [],
    dependencyVersions: {},
    ipc: {},
    packaging: raw.packaging || {},
    styles: raw.styles || [],
    hooks: raw.hooks || [],
    commands: raw.commands || [],
  };

  for (const key of ['main', 'renderer']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !raw[key]) throw new Error(`${key} must be a non-empty path`);
    if (directory) resolveResource(directory, raw[key], key);
  }
  if (raw.styles !== undefined) {
    validateStringArray(raw.styles, 'styles');
    if (new Set(raw.styles).size !== raw.styles.length) throw new Error('styles must be unique');
    if (directory) for (const style of raw.styles) resolveResource(directory, style, 'Style');
  }
  if (raw.dependencies !== undefined) {
    validateStringArray(raw.dependencies, 'dependencies');
    const seen = new Set();
    for (const dependency of raw.dependencies) {
      validateId(dependency, 'Dependency id');
      if (seen.has(dependency)) throw new Error(`Duplicate dependency: ${dependency}`);
      seen.add(dependency);
    }
    result.dependencies = [...raw.dependencies];
  }
  if (raw.dependencyVersions !== undefined) {
    if (!raw.dependencyVersions || typeof raw.dependencyVersions !== 'object' || Array.isArray(raw.dependencyVersions)) throw new Error('dependencyVersions must be an object');
    for (const [id, range] of Object.entries(raw.dependencyVersions)) {
      validateId(id, 'Dependency version id');
      if (typeof range !== 'string' || !validRange(range)) throw new Error(`Invalid dependency range for ${id}`);
    }
    result.dependencyVersions = { ...raw.dependencyVersions };
  }
  if (raw.ipc !== undefined) result.ipc = validateIpc(raw.ipc);
  if (raw.packaging !== undefined) {
    if (!raw.packaging || typeof raw.packaging !== 'object' || Array.isArray(raw.packaging)) throw new Error('packaging must be an object');
    for (const key of Object.keys(raw.packaging)) {
      if (key !== 'unpackedResources') throw new Error(`Unknown packaging field: ${key}`);
    }
    if (raw.packaging.unpackedResources !== undefined) {
      validateStringArray(raw.packaging.unpackedResources, 'packaging.unpackedResources');
      if (new Set(raw.packaging.unpackedResources).size !== raw.packaging.unpackedResources.length) throw new Error('packaging.unpackedResources must be unique');
      if (directory) for (const resource of raw.packaging.unpackedResources) resolvePath(directory, resource, 'Unpacked resource', { allowDirectory: true });
    }
  }

  if (raw.hooks !== undefined) {
    if (!Array.isArray(raw.hooks) || raw.hooks.length === 0 || raw.hooks.length > 100) throw new Error('hooks must contain 1 to 100 entries');
    result.hooks = raw.hooks.map(hook => {
      if (!hook || typeof hook !== 'object' || !EVENTS.has(hook.event)) throw new Error(`Unsupported event: ${hook?.event}`);
      return { event: hook.event, ...executable(hook, 'Hook') };
    });
  }
  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands) || raw.commands.length === 0 || raw.commands.length > 100) throw new Error('commands must contain 1 to 100 entries');
    const ids = new Set();
    result.commands = raw.commands.map(command => {
      if (!command || typeof command !== 'object') throw new Error('Invalid command');
      validateId(command.id, 'Command id');
      if (typeof command.title !== 'string' || !command.title.trim() || command.title.length > 200) throw new Error('Command requires a title of at most 200 characters');
      if (ids.has(command.id)) throw new Error(`Duplicate command: ${command.id}`);
      ids.add(command.id);
      return { id: command.id, title: command.title, ...executable(command, 'Command') };
    });
  }
  if (raw.settings !== undefined) {
    if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) throw new Error('settings must be an object');
  }
  if (raw.service !== undefined) result.service = executable(raw.service, 'Service');
  if (raw.contributes !== undefined) {
    const commandIds = new Set(result.commands.map(command => command.id));
    result.contributes = validateContributes(raw.contributes, directory, commandIds);
  }
  return result;
}

export function readExtension(directory) {
  return readJson(path.join(directory, 'extension.json'));
}

function validSpdx(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (!/^[A-Za-z0-9.+()\- ]+$/.test(value)) return false;
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !/\b(AND|OR|WITH)\s*$/i.test(value.trim());
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use https`);
  return value;
}

export function validateMetadata(raw, { directory = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('metadata.json must be an object');
  for (const key of Object.keys(raw)) {
    if (!METADATA_KEYS.has(key)) throw new Error(`Unknown metadata field: ${key}`);
  }
  if (typeof raw.publisher !== 'string' || !raw.publisher) throw new Error('metadata.publisher is required');
  if (!validSpdx(raw.license)) throw new Error('metadata.license must be an SPDX expression');
  if (!Array.isArray(raw.categories) || raw.categories.length < 1 || raw.categories.length > 3) throw new Error('metadata.categories must contain 1 to 3 entries');
  const categories = new Set();
  for (const category of raw.categories) {
    if (!CATEGORIES.has(category)) throw new Error(`Unknown category: ${category}`);
    if (categories.has(category)) throw new Error(`Duplicate category: ${category}`);
    categories.add(category);
  }
  if (typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > 280) throw new Error('metadata.summary must be 1 to 280 characters');
  if (typeof raw.releaseNotes !== 'string' || !raw.releaseNotes.trim()) throw new Error('metadata.releaseNotes must be a non-empty string');
  if (raw.displayName !== undefined && (typeof raw.displayName !== 'string' || !raw.displayName.trim() || raw.displayName.length > 200)) throw new Error('metadata.displayName is invalid');
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string' || !raw.icon) throw new Error('metadata.icon must be a package-relative path');
    if (directory) resolveResource(directory, raw.icon, 'Icon');
  }
  if (raw.documentation !== undefined) {
    if (typeof raw.documentation !== 'string' || !raw.documentation) throw new Error('metadata.documentation must be a package-relative path');
    if (directory) resolveResource(directory, raw.documentation, 'Documentation');
  }
  if (raw.source !== undefined) validateHttpsUrl(raw.source, 'metadata.source');
  if (raw.homepage !== undefined) validateHttpsUrl(raw.homepage, 'metadata.homepage');
  if (raw.deprecated !== undefined && typeof raw.deprecated !== 'boolean') throw new Error('metadata.deprecated must be a boolean');
  if (raw.withdrawn !== undefined && typeof raw.withdrawn !== 'boolean') throw new Error('metadata.withdrawn must be a boolean');
  if (raw.replacement !== undefined) validateId(raw.replacement, 'Replacement plugin id');
  return raw;
}

export function validateDependencyGraph(plugins) {
  for (const [id, plugin] of plugins) {
    const manifest = plugin.manifest;
    for (const dependency of manifest.dependencies) {
      if (!plugins.has(dependency)) throw new Error(`${id} depends on an unknown plugin: ${dependency}`);
    }
    for (const dependency of Object.keys(manifest.dependencyVersions)) {
      if (!manifest.dependencies.includes(dependency)) throw new Error(`${id} has a dependency version for an unknown dependency: ${dependency}`);
    }
    for (const dependency of manifest.dependencies) {
      const range = manifest.dependencyVersions[dependency] || '*';
      const target = plugins.get(dependency);
      if (manifest.execution === 'native' && target.manifest.execution === 'subprocess') {
        throw new Error(`${id} (native) cannot depend on subprocess plugin ${dependency}; native activation supports native dependencies only`);
      }
      if (!satisfies(target.manifest.version, range)) throw new Error(`${id} requires ${dependency} ${range}, but the registry has ${target.manifest.version}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      throw new Error(`Dependency cycle: ${[...stack.slice(start), id].join(' -> ')}`);
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of plugins.get(id).manifest.dependencies) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of plugins.keys()) visit(id);
}

function exactVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export function validatePackageJson(directory, manifest) {
  const file = path.join(directory, 'package.json');
  const exists = fs.existsSync(file);
  const lockfile = path.join(directory, 'package-lock.json');
  if (!exists) return null;
  const packageJson = readJson(file);
  if (typeof packageJson.name !== 'string' || !packageJson.name.trim()) throw new Error('package.json requires a name');
  if (packageJson.version !== manifest.version) throw new Error('package.json version must equal extension.json version');
  const dependencies = packageJson.dependencies || {};
  if (dependencies && (typeof dependencies !== 'object' || Array.isArray(dependencies))) throw new Error('package.json dependencies must be an object');
  if (Object.keys(dependencies).length) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (!exactVersion(version)) throw new Error(`package.json dependency ${name} must use an exact version`);
    }
    if (!fs.existsSync(lockfile)) throw new Error('package-lock.json is required when runtime dependencies are present');
    const lock = readJson(lockfile, { max: 16 * 1024 * 1024 });
    if (!lock || typeof lock !== 'object' || typeof lock.lockfileVersion !== 'number') throw new Error('package-lock.json is invalid');
  }
  return packageJson;
}

export function validatePlugin(directory, id) {
  validateId(id);
  const manifest = validateExtension(readExtension(directory), { directory });
  if (manifest.id !== id) throw new Error(`Plugin directory ${id} contains manifest id ${manifest.id}`);
  const metadata = validateMetadata(readJson(path.join(directory, 'metadata.json')), { directory });
  const packageJson = validatePackageJson(directory, manifest);
  return { manifest, metadata, packageJson };
}
