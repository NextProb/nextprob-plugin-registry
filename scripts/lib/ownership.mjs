import path from 'node:path';
import { readJson } from './fs-safe.mjs';
import { validateId } from './manifest.mjs';
import { canonicalJson } from './sign.mjs';

const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const OWNER_KEYS = new Set(['schemaVersion', 'maintainers', 'officialNamespaces', 'publishers', 'namespaces', 'plugins']);
const PUBLISHER_KEYS = new Set(['displayName', 'official', 'github', 'url']);

export function loadOwners(root) {
  return readJson(path.join(root, 'owners.json'));
}

function login(value, label) {
  if (typeof value !== 'string' || !LOGIN_RE.test(value)) throw new Error(`${label} must be a lowercase GitHub login`);
  return value;
}

export function validateOwners(owners) {
  if (!owners || typeof owners !== 'object' || Array.isArray(owners)) throw new Error('owners.json must be an object');
  for (const key of Object.keys(owners)) {
    if (!OWNER_KEYS.has(key)) throw new Error(`Unknown owners.json field: ${key}`);
  }
  if (owners.schemaVersion !== 1) throw new Error('owners.schemaVersion must be 1');
  if (!Array.isArray(owners.maintainers) || owners.maintainers.length === 0) throw new Error('owners.maintainers must be a non-empty array');
  if (new Set(owners.maintainers).size !== owners.maintainers.length) throw new Error('owners.maintainers must be unique');
  for (const maintainer of owners.maintainers) login(maintainer, 'Maintainer');
  if (!Array.isArray(owners.officialNamespaces)) throw new Error('owners.officialNamespaces must be an array');
  if (new Set(owners.officialNamespaces).size !== owners.officialNamespaces.length) throw new Error('owners.officialNamespaces must be unique');
  for (const namespace of owners.officialNamespaces) validateId(namespace, 'Official namespace');

  if (!owners.publishers || typeof owners.publishers !== 'object' || Array.isArray(owners.publishers)) throw new Error('owners.publishers must be an object');
  if (Object.keys(owners.publishers).length === 0) throw new Error('owners.publishers must not be empty');
  for (const [id, publisher] of Object.entries(owners.publishers)) {
    validateId(id, 'Publisher id');
    if (!publisher || typeof publisher !== 'object' || Array.isArray(publisher)) throw new Error(`Publisher ${id} must be an object`);
    for (const key of Object.keys(publisher)) {
      if (!PUBLISHER_KEYS.has(key)) throw new Error(`Unknown publisher field for ${id}: ${key}`);
    }
    if (typeof publisher.displayName !== 'string' || !publisher.displayName.trim() || publisher.displayName.length > 200) throw new Error(`Publisher ${id} requires a displayName`);
    if (typeof publisher.official !== 'boolean') throw new Error(`Publisher ${id} requires an official boolean`);
    if (!Array.isArray(publisher.github) || publisher.github.length === 0) throw new Error(`Publisher ${id} requires a non-empty github array`);
    if (new Set(publisher.github).size !== publisher.github.length) throw new Error(`Publisher ${id} github accounts must be unique`);
    for (const account of publisher.github) login(account, `Publisher ${id} GitHub account`);
    if (typeof publisher.url !== 'string') throw new Error(`Publisher ${id} requires a url`);
    let url;
    try {
      url = new URL(publisher.url);
    } catch {
      throw new Error(`Publisher ${id} url is invalid`);
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`Publisher ${id} url must be an HTTP(S) URL`);
  }

  if (!owners.namespaces || typeof owners.namespaces !== 'object' || Array.isArray(owners.namespaces)) throw new Error('owners.namespaces must be an object');
  if (Object.keys(owners.namespaces).length === 0) throw new Error('owners.namespaces must not be empty');
  for (const [namespace, publisherId] of Object.entries(owners.namespaces)) {
    validateId(namespace, 'Namespace');
    if (!Object.hasOwn(owners.publishers, publisherId)) throw new Error(`Namespace ${namespace} references an unknown publisher: ${publisherId}`);
  }
  if (owners.plugins !== undefined) {
    if (!owners.plugins || typeof owners.plugins !== 'object' || Array.isArray(owners.plugins)) throw new Error('owners.plugins must be an object');
    for (const [id, publisherId] of Object.entries(owners.plugins)) {
      validateId(id, 'Plugin ownership override');
      if (!Object.hasOwn(owners.publishers, publisherId)) throw new Error(`Plugin ${id} references an unknown publisher: ${publisherId}`);
    }
  }

  for (const namespace of owners.officialNamespaces) {
    if (!Object.hasOwn(owners.namespaces, namespace)) throw new Error(`Official namespace ${namespace} has no publisher mapping`);
    const publisher = owners.publishers[owners.namespaces[namespace]];
    if (!publisher.official) throw new Error(`Official namespace ${namespace} must map to an official publisher`);
  }

  for (const [id, publisher] of Object.entries(owners.publishers)) {
    if (!publisher.official) {
      const ownsOfficial = owners.officialNamespaces.some(namespace => owners.namespaces[namespace] === id);
      if (ownsOfficial) throw new Error(`Non-official publisher ${id} owns an official namespace`);
      continue;
    }
    const ownsOfficial = owners.officialNamespaces.some(namespace => owners.namespaces[namespace] === id);
    if (!ownsOfficial) throw new Error(`Official publisher ${id} must own an official namespace`);
  }
  return owners;
}

export function ownerPublisherId(pluginId, owners) {
  if (owners.plugins && Object.hasOwn(owners.plugins, pluginId)) return owners.plugins[pluginId];
  let best = null;
  for (const namespace of Object.keys(owners.namespaces)) {
    if (pluginId === namespace || pluginId.startsWith(`${namespace}.`)) {
      if (!best || namespace.length > best.length) best = namespace;
    }
  }
  return best ? owners.namespaces[best] : null;
}

export function publisherSummary(publisherId, owners) {
  const publisher = owners.publishers[publisherId];
  if (!publisher) throw new Error(`Unknown publisher: ${publisherId}`);
  return {
    id: publisherId,
    displayName: publisher.displayName,
    official: publisher.official,
    github: [...publisher.github],
    url: publisher.url,
  };
}

export function isOfficialPluginId(pluginId, owners) {
  return (owners.officialNamespaces || []).some(namespace => pluginId === namespace || pluginId.startsWith(`${namespace}.`));
}

export function validatePluginOwnership(pluginId, metadataPublisher, owners) {
  const owner = ownerPublisherId(pluginId, owners);
  if (!owner) throw new Error(`Plugin ${pluginId} has no owning publisher namespace`);
  const publisher = owners.publishers[owner];
  if (!publisher) throw new Error(`Plugin ${pluginId} maps to an unknown publisher: ${owner}`);
  if (metadataPublisher !== owner) throw new Error(`Plugin ${pluginId} metadata publisher ${metadataPublisher} does not match owner ${owner}`);
  if (isOfficialPluginId(pluginId, owners) && !publisher.official) throw new Error(`Official plugin ${pluginId} must map to an official publisher`);
  return { owner, publisher };
}

export function isMaintainer(account, owners) {
  return owners.maintainers.includes(String(account).toLowerCase());
}

export function authorKnown(account, owners) {
  const normalized = String(account).toLowerCase();
  if (owners.maintainers.includes(normalized)) return true;
  return Object.values(owners.publishers).some(publisher => publisher.github.includes(normalized));
}

export function authorCanManagePlugin(account, pluginId, owners) {
  const normalized = String(account).toLowerCase();
  if (owners.maintainers.includes(normalized)) return true;
  const owner = ownerPublisherId(pluginId, owners);
  if (!owner) return false;
  return owners.publishers[owner].github.includes(normalized);
}

export function ownershipSnapshot(owners) {
  return canonicalJson({
    maintainers: [...owners.maintainers].sort(),
    officialNamespaces: [...owners.officialNamespaces].sort(),
    publishers: owners.publishers,
    namespaces: owners.namespaces,
    plugins: owners.plugins || {},
  });
}

export function assertOwnershipAuthorization(account, baseOwners, headOwners, pluginIds) {
  if (!account) return;
  if (!baseOwners) {
    if (!authorKnown(account, headOwners)) throw new Error(`Unknown PR author: ${account}`);
    for (const pluginId of pluginIds) {
      if (!authorCanManagePlugin(account, pluginId, headOwners)) throw new Error(`Author ${account} does not own ${pluginId}`);
    }
    return;
  }
  const maintainer = isMaintainer(account, baseOwners);
  if (ownershipSnapshot(baseOwners) !== ownershipSnapshot(headOwners) && !maintainer) {
    throw new Error(`Author ${account} is not a maintainer in the base branch and cannot change ownership or maintainers`);
  }
  if (!authorKnown(account, baseOwners)) throw new Error(`Unknown PR author: ${account}`);
  for (const pluginId of pluginIds) {
    if (!maintainer && !authorCanManagePlugin(account, pluginId, baseOwners)) {
      throw new Error(`Author ${account} does not own ${pluginId}`);
    }
  }
}
