import { compare, parse as parseVersion } from './semver.mjs';
import { canonicalJson } from './sign.mjs';
import { publisherSummary, validatePluginOwnership } from './ownership.mjs';

export function pluginRecord(id, metadata, owners) {
  const { owner, publisher } = validatePluginOwnership(id, metadata.publisher, owners);
  return {
    id,
    publisher: publisherSummary(owner, owners),
    official: publisher.official,
    metadata: structuredClone(metadata),
  };
}

export function releaseTag(id, version) {
  return `${id}-v${version}`;
}

export function assetFilename(id, version) {
  return `${id}-${version}.zip`;
}

export function makeVersionEntry({ descriptor, metadata, repo, existing, now = new Date().toISOString() }) {
  const id = descriptor.id;
  const version = descriptor.version;
  parseVersion(version);
  const tag = releaseTag(id, version);
  const filename = assetFilename(id, version);
  if (descriptor.filename !== filename) throw new Error(`Artifact filename must be ${filename}`);
  if (existing) {
    const asset = existing.assets?.[0];
    if (!asset || asset.filename !== filename || asset.sha256 !== descriptor.sha256 || asset.size !== descriptor.size) {
      throw new Error(`Refusing to replace published version ${id} ${version}`);
    }
    return existing;
  }
  return {
    version,
    apiVersion: descriptor.manifest.apiVersion,
    execution: descriptor.manifest.execution,
    nextprob: descriptor.manifest.nextprob,
    platforms: [...descriptor.platforms],
    dependencies: (descriptor.manifest.dependencies || []).map(dependency => ({ id: dependency.id, range: dependency.range })),
    sourceCommit: descriptor.sourceCommit,
    releaseTag: tag,
    publishedAt: now,
    releaseNotes: metadata.releaseNotes,
    deprecated: Boolean(metadata.deprecated),
    withdrawn: Boolean(metadata.withdrawn),
    assets: [
      {
        filename,
        url: `https://github.com/${repo}/releases/download/${tag}/${filename}`,
        sha256: descriptor.sha256,
        size: descriptor.size,
        platforms: [...descriptor.platforms],
      },
    ],
  };
}

export function sortVersions(versions) {
  return [...versions].sort((a, b) => compare(b.version, a.version));
}

export function mergeCatalog(existing, updates, { sourceCommit, keyId, now = new Date().toISOString() } = {}) {
  const base = existing ? structuredClone(existing) : {
    schemaVersion: 1,
    catalogVersion: 0,
    generatedAt: now,
    sourceCommit,
    keyId,
    plugins: [],
  };
  if (!Array.isArray(base.plugins)) throw new Error('Existing catalog has no plugins array');
  const plugins = new Map(base.plugins.map(plugin => [plugin.id, plugin]));
  let changed = false;

  for (const update of updates) {
    let record = plugins.get(update.id);
    if (!record) {
      record = { ...structuredClone(update.record), versions: [] };
      plugins.set(update.id, record);
      changed = true;
    } else {
      if (canonicalJson(record.metadata) !== canonicalJson(update.record.metadata)) {
        record.metadata = structuredClone(update.record.metadata);
        const deprecated = Boolean(update.record.metadata.deprecated);
        const withdrawn = Boolean(update.record.metadata.withdrawn);
        for (const version of record.versions) {
          if (version.deprecated !== deprecated || version.withdrawn !== withdrawn) {
            version.deprecated = deprecated;
            version.withdrawn = withdrawn;
            changed = true;
          }
        }
        changed = true;
      }
      if (canonicalJson(record.publisher) !== canonicalJson(update.record.publisher)) {
        record.publisher = structuredClone(update.record.publisher);
        changed = true;
      }
      if (record.official !== update.record.official) {
        record.official = update.record.official;
        changed = true;
      }
    }
    for (const version of update.versions || []) {
      const index = record.versions.findIndex(item => item.version === version.version);
      if (index === -1) {
        record.versions.push(structuredClone(version));
        changed = true;
        continue;
      }
      const current = record.versions[index];
      const comparable = entry => ({ ...entry, publishedAt: undefined });
      if (canonicalJson(comparable(current)) !== canonicalJson(comparable(version))) {
        throw new Error(`Refusing to replace published version ${update.id} ${version.version}`);
      }
    }
    record.versions = sortVersions(record.versions);
  }

  if (base.keyId && keyId && base.keyId !== keyId) changed = true;
  if (!changed) return { catalog: existing || base, changed: false };

  return {
    catalog: {
      schemaVersion: 1,
      catalogVersion: (base.catalogVersion || 0) + 1,
      generatedAt: now,
      sourceCommit,
      keyId,
      plugins: [...plugins.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
    changed: true,
  };
}
