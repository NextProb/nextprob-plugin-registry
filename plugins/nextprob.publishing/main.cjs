'use strict';
const fs = require('fs');
const path = require('path');
const { inlineNoteAsHtml } = require('./inline');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const github = require('./github-auth');
  github.configure(api.services);
  const githubApi = require('./github-api');
  const shareRenderer = require('./share-renderer');
  shareRenderer.configure(api.services);
  api.onDispose(github.onStateChanged(state => api.ipc.send('github:stateChanged', state)));
  api.onDispose(api.services.metadata.register('publishing', require('./metadata.cjs')));
  github.init();
  shareRenderer.init();
  api.onDispose(() => github.cancelConnect());
  registerHandlers({ ...api.services, ipcMain, exportModule: undefined, api, github, githubApi, shareRenderer });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api, github, githubApi, shareRenderer }) {
  // --- Publish / Unpublish Note via GitHub Gist + Pages ---

  // Gist visibility cannot be changed in place — the gist must be recreated to
  // switch between secret and public. ~10 MB is GitHub's hard cap on a gist;
  // 1 MB is the practical limit before the web UI degrades.
  const SHARE_GIST_BYTES_WARN = 1024 * 1024;
  const SHARE_GIST_BYTES_HARD_CAP = 10 * 1024 * 1024;

  ipcMain.handle('export:publish', async (_e, notePath, options = {}) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };

    if (!github.isConnected()) {
      return { error: 'github-not-connected', message: 'Connect GitHub to share notes.' };
    }

    // Phase 5 UI passes options.repoName on the user's first publish.
    if (options && options.repoName && !github.getRepoName()) {
      try { github.setRepoName(options.repoName); }
      catch (err) { return { error: err.message || String(err) }; }
    }
    const repoName = github.getRepoName();
    if (!repoName) {
      return { error: 'github-no-repo-name', message: 'Pick a repo name to host your shares.' };
    }

    const noteFolderPath = path.resolve(notePath);
    if (!isInsideWorkspace(noteFolderPath)) return { error: 'Path is outside the workspace' };

    const indexPath = path.join(noteFolderPath, 'index.html');
    if (!fs.existsSync(indexPath)) return { error: 'Not a valid note (no index.html found)' };

    const { html, noteTitle, usesBackendAPIs } = inlineNoteAsHtml(noteFolderPath, noteCss);
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    if (htmlBytes > SHARE_GIST_BYTES_HARD_CAP) {
      return { error: `Note is too large to share via GitHub (${(htmlBytes / 1024 / 1024).toFixed(1)} MB > 10 MB).` };
    }

    const noteId = path.relative(getWorkspacePath(), noteFolderPath);
    const kvData = noteDb.noteDbLoad(getWorkspacePath(), noteId);

    const api = githubApi;
    const visibility = options && options.visibility === 'public' ? 'public' : 'secret';
    const isPublic = visibility === 'public';

    try {
      const provision = await api.ensureRepoProvisioned(repoName, shareRenderer.getRenderer());

      const looksLikeGistId = (s) => typeof s === 'string' && /^[a-f0-9]{20,40}$/i.test(s);
      const oldId = kvData.__shareId || null;
      const oldVisibility = kvData.__shareVisibility || null;
      let gistId = null;

      if (looksLikeGistId(oldId) && oldVisibility === visibility) {
        try {
          await api.updateGist(oldId, html);
          gistId = oldId;
        } catch {
          gistId = null; // gist gone or inaccessible — fall through to create
        }
      } else if (looksLikeGistId(oldId) && oldVisibility && oldVisibility !== visibility) {
        // Visibility changed → can't mutate; replace.
        try { await api.deleteGist(oldId); } catch {}
      }

      if (!gistId) {
        const created = await api.createGist({ html, isPublic });
        gistId = created.id;
      }

      // First-publish path: Pages 404s for ~30–60 s during the initial build.
      // Wait for it before returning the URL so the user never gets a dead link.
      if (provision.firstProvision) {
        try { await api.waitForPagesBuilt(repoName); } catch {}
      }

      const shareUrl = api.pagesUrl(repoName, gistId);
      kvData.__shareId = gistId;
      kvData.__shareUrl = shareUrl;
      kvData.__shareVisibility = visibility;
      noteDb.noteDbFlush(getWorkspacePath(), noteId, kvData);

      const sizeWarning = htmlBytes > SHARE_GIST_BYTES_WARN
        ? ` (${(htmlBytes / 1024 / 1024).toFixed(1)} MB — close to GitHub's 10 MB limit)`
        : '';

      return {
        success: true,
        shareUrl,
        shareId: gistId,
        title: noteTitle,
        usesBackendAPIs,
        visibility,
        sizeWarning,
        firstProvision: !!provision.firstProvision,
      };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });

  ipcMain.handle('export:unpublish', async (_e, notePath) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };

    if (!github.isConnected()) return { error: 'Not connected to GitHub.' };

    const noteFolderPath = path.resolve(notePath);
    if (!isInsideWorkspace(noteFolderPath)) return { error: 'Path is outside the workspace' };

    const noteId = path.relative(getWorkspacePath(), noteFolderPath);
    const kvData = noteDb.noteDbLoad(getWorkspacePath(), noteId);
    const shareId = kvData.__shareId;
    if (!shareId) return { error: 'This note is not published.' };

    try {
      const api = githubApi;
      await api.deleteGist(shareId);
    } catch (err) {
      return { error: err.message || String(err) };
    }

    delete kvData.__shareId;
    delete kvData.__shareUrl;
    delete kvData.__shareVisibility;
    noteDb.noteDbFlush(getWorkspacePath(), noteId, kvData);

    return { success: true };
  });

  // Use the collection catalog's discovery and local publication truth. This does
  // not verify that the gist still exists on GitHub.
  ipcMain.handle('notes:listPublished', () => {
    if (!getWorkspacePath()) return {};
    return api ? api.services.metadata.collection('publishing') : {};
  });


ipcMain.handle('github:connect', async () => {
  try {
    const info = await github.startConnect();
    return { ok: true, data: info };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('github:cancelConnect', () => {
  github.cancelConnect();
  return { ok: true };
});

ipcMain.handle('github:disconnect', () => {
  github.disconnect();
  return { ok: true };
});

ipcMain.handle('github:getState', () => {
  return github.getState();
});

ipcMain.handle('github:setRepoName', (_e, name) => {
  try {
    github.setRepoName(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('github:checkRepoName', async (_e, name) => {
  if (!github.isConnected()) return { ok: false, message: 'Not connected to GitHub.' };

  return await githubApi.checkRepoName(name);
});

// Provision the user's *-shares repo right now (without publishing a note).
// Used by the "Create now" choice in Settings → Sharing → Change… so users
// can front-load the ~30 s first-time setup before they actually share.
ipcMain.handle('github:provisionRepo', async () => {
  if (!github.isConnected()) return { ok: false, error: 'Not connected to GitHub.' };
  const repoName = github.getRepoName();
  if (!repoName) return { ok: false, error: 'No repo name set.' };
  try {

    const provision = await githubApi.ensureRepoProvisioned(repoName, shareRenderer.getRenderer());
    if (provision.firstProvision) {
      try { await githubApi.waitForPagesBuilt(repoName); } catch {}
    }
    const u = github.getUser();
    return {
      ok: true,
      firstProvision: !!provision.firstProvision,
      repoUrl: `https://github.com/${u.login}/${repoName}`,
      pagesUrl: `https://${u.login}.github.io/${repoName}/`,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

}
module.exports = { activate, registerHandlers };
