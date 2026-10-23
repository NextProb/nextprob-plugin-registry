import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'nextprob.publishing');
const MAIN = path.join(PLUGIN, 'main.cjs');

const EXPORT_PLUGIN_REFERENCES = [
  'nextprob.export-html',
  'nextprob.html-inliner',
  'nextprob.export-engine',
  'export:save-html',
  'export:single-html',
];

function stubModule(file, exports) {
  const resolved = require.resolve(file);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return resolved;
}

function clearPluginCache() {
  const prefix = `${PLUGIN}${path.sep}`;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}

function makeWorkspace() {
  const base = path.join(ROOT, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'publishing-plugin-'));
}

test('publishing activates and publishes self-contained HTML without export plugins', async () => {
  clearPluginCache();
  const workspace = makeWorkspace();
  const userData = path.join(workspace, '.userdata');
  fs.mkdirSync(userData, { recursive: true });
  const noteDir = path.join(workspace, 'notes', 'demo');
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(noteDir, 'index.html'), [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<title>Demo Note</title>',
    '<link rel="stylesheet" href="style.css">',
    '</head>',
    '<body>',
    '<article>Publishing fixture</article>',
    '<img src="pic.png" alt="pixel">',
    '</body>',
    '</html>',
  ].join('\n'));
  fs.writeFileSync(path.join(noteDir, 'style.css'), [
    'body { background: url(\'pic.png\'); color: rgb(12, 34, 56); }',
    '.cover { background-image: url("pic.png"); }',
  ].join('\n'));
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  fs.writeFileSync(path.join(noteDir, 'pic.png'), png);
  const pngBase64 = png.toString('base64');

  const noteCss = '.note-css-marker { color: rgb(1, 2, 3); }';
  const handlers = new Map();
  const requireCalls = [];
  const networkCalls = [];
  const sentEvents = [];
  const disposers = [];
  const store = new Map();
  const captured = {};

  const github = {
    configure() {},
    init() {},
    isConnected: () => true,
    getRepoName: () => 'demo-shares',
    getUser: () => ({ login: 'demo' }),
    setRepoName() {},
    getState: () => ({ status: 'connected', user: { login: 'demo' }, repoName: 'demo-shares' }),
    onStateChanged: () => () => {},
    startConnect: async () => ({}),
    cancelConnect() {},
    disconnect() {},
  };

  const shareRenderer = {
    configure() {},
    init() {},
    refresh: async () => {},
    getRenderer: () => ({
      indexHtml: '<!doctype html><!-- notes-app-share-renderer -->',
      robotsTxt: 'User-agent: *\nDisallow: /\n',
      indexSha: 'renderer-sha',
    }),
  };

  const githubApi = {
    ensureRepoProvisioned: async (repoName, renderer) => {
      captured.repoName = repoName;
      captured.renderer = renderer;
      return { firstProvision: true };
    },
    createGist: async ({ html, isPublic }) => {
      captured.html = html;
      captured.isPublic = isPublic;
      return { id: 'a'.repeat(24) };
    },
    updateGist: async () => {
      throw new Error('unexpected gist update');
    },
    deleteGist: async () => {},
    waitForPagesBuilt: async (repoName) => {
      captured.waitedForRepo = repoName;
      return true;
    },
    pagesUrl: (repoName, gistId) => `https://demo.github.io/${repoName}/?id=${gistId}`,
    checkRepoName: async () => ({ ok: true, status: 'available' }),
  };

  const services = {
    app: {
      getPath: (name) => (name === 'userData' ? userData : workspace),
    },
    dialog: {},
    getWorkspacePath: () => workspace,
    getMainWindow: () => null,
    isInsideWorkspace: (target) => {
      const relative = path.relative(workspace, target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    },
    noteCss,
    noteDb: {
      noteDbLoad: (_workspace, noteId) => ({ ...(store.get(noteId) || {}) }),
      noteDbFlush: (_workspace, noteId, data) => {
        store.set(noteId, { ...data });
      },
    },
    metadata: {
      register: () => () => {},
      collection: () => ({}),
    },
    config: {
      get: (key) => (key === 'contentBranch' ? 'main' : 'NextProb/nextprob-notes'),
    },
    credentials: {
      open: () => ({
        isEncryptionAvailable: () => false,
        load: () => null,
        save: () => {},
        clear: () => {},
      }),
    },
    openExternal: async () => {},
    network: {
      fetchText: async (url) => {
        networkCalls.push(url);
        throw new Error('network disabled in test');
      },
    },
  };

  const ipc = {
    handle: (channel, handler) => {
      assert.ok(!handlers.has(channel), `duplicate IPC handler: ${channel}`);
      handlers.set(channel, handler);
    },
    on: (channel) => {
      throw new Error(`unexpected ipc.on registration: ${channel}`);
    },
    send: (channel, ...args) => {
      sentEvents.push({ channel, args });
    },
  };

  const api = {
    services,
    ipc,
    onDispose: (dispose) => {
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    require: (name) => {
      requireCalls.push(name);
      throw new Error(`unexpected plugin require: ${name}`);
    },
  };

  try {
    stubModule(path.join(PLUGIN, 'github-auth.js'), github);
    stubModule(path.join(PLUGIN, 'github-api.js'), githubApi);
    stubModule(path.join(PLUGIN, 'share-renderer.js'), shareRenderer);

    const publishing = require(MAIN);
    assert.equal(typeof publishing.activate, 'function');

    publishing.activate(api);
    assert.deepEqual(requireCalls, []);
    assert.deepEqual([...handlers.keys()], [
      'export:publish',
      'export:unpublish',
      'notes:listPublished',
      'github:connect',
      'github:cancelConnect',
      'github:disconnect',
      'github:getState',
      'github:setRepoName',
      'github:checkRepoName',
      'github:provisionRepo',
    ]);

    const result = await handlers.get('export:publish')({}, noteDir, { visibility: 'secret' });

    assert.deepEqual(requireCalls, [], 'no plugin require occurs during publish');
    assert.equal(result.success, true);
    assert.equal(result.shareUrl, `https://demo.github.io/demo-shares/?id=${'a'.repeat(24)}`);
    assert.equal(result.title, 'Demo Note');
    assert.equal(result.usesBackendAPIs, false);
    assert.equal(result.visibility, 'secret');
    assert.equal(captured.repoName, 'demo-shares');
    assert.equal(captured.isPublic, false);
    assert.equal(captured.waitedForRepo, 'demo-shares');

    const html = captured.html;
    assert.match(html, /<style data-source="notes-app-share">/);
    assert.ok(html.includes(noteCss), 'inlined document contains the app note CSS');
    assert.match(html, /<style>\/\* inlined: style\.css \*\//);
    assert.ok(html.includes(`data:image/png;base64,${pngBase64}`), 'PNG is inlined as a data URI');
    assert.ok(html.includes(`url(data:image/png;base64,${pngBase64})`), 'CSS url() is inlined');
    assert.ok(!html.includes('href="style.css"'), 'stylesheet link is removed');
    assert.ok(!html.includes('src="pic.png"'), 'image source link is removed');
    assert.ok(!html.includes("url('pic.png')"), 'CSS asset link is removed');
    assert.equal(result.firstProvision, true);

    const noteId = path.relative(workspace, noteDir);
    const persisted = store.get(noteId);
    assert.ok(persisted, 'note metadata was flushed');
    assert.equal(persisted.__shareId, 'a'.repeat(24));
    assert.equal(persisted.__shareUrl, result.shareUrl);
    assert.equal(persisted.__shareVisibility, 'secret');
    assert.deepEqual(networkCalls, [], 'no network calls occur during activation or publish');

    assert.equal(sentEvents.length, 0, 'no state events are sent during activation');
  } finally {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch {}
    }
    clearPluginCache();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('registry publishing main.cjs has no export-plugin references', () => {
  const source = fs.readFileSync(MAIN, 'utf8');
  for (const reference of EXPORT_PLUGIN_REFERENCES) {
    assert.equal(source.includes(reference), false, `main.cjs must not reference ${reference}`);
  }
  assert.equal(source.includes('api.require('), false, 'main.cjs must not perform plugin service lookups');
  assert.match(source, /require\('\.\/inline'\)/, 'main.cjs loads the bundled inliner');

  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'extension.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, [], 'extension.json must not declare plugin dependencies');
  assert.ok(
    manifest.dependencyVersions === undefined
      || (typeof manifest.dependencyVersions === 'object'
        && manifest.dependencyVersions !== null
        && Object.keys(manifest.dependencyVersions).length === 0),
    'extension.json must not declare dependency versions',
  );
});
