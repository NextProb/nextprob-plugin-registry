'use strict';
const fs = require('fs');
const path = require('path');
const { inlineNoteAsHtml } = require('./inline');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const exportModule = api.require('nextprob.export-engine');
  api.provide('nextprob.html-inliner', { inlineNoteAsHtml });
  registerHandlers({ ...api.services, ipcMain, exportModule: exportModule, api });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api }) {
  ipcMain.handle('export:save-html', async (_e, notePath) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };
    const resolved = path.resolve(notePath);
    if (!isInsideWorkspace(resolved)) return { error: 'Path is outside the workspace' };

    let htmlContent;
    try {
      const result = await exportModule.exportNote(resolved, 'html');
      htmlContent = result.content;
    } catch (err) {
      return { error: `Conversion failed: ${err.message}` };
    }

    const baseName = path.basename(resolved, '.html');
    const newFilename = baseName + '.html';

    let filePath;
    try {
      const { canceled, filePath: chosenPath } = await dialog.showSaveDialog(getMainWindow(), {
        defaultPath: path.join(app.getPath('documents'), newFilename),
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (canceled) return { cancelled: true };
      filePath = chosenPath;
      fs.writeFileSync(filePath, htmlContent, 'utf-8');
    } catch (err) {
      return { error: `Failed to write HTML: ${err.message}` };
    }

    return { success: true, filePath };
  });

  // --- Export as Single HTML File ---

  ipcMain.handle('export:single-html', async (_e, notePath) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };

    const noteFolderPath = path.resolve(notePath);
    if (!isInsideWorkspace(noteFolderPath)) return { error: 'Path is outside the workspace' };

    const indexPath = path.join(noteFolderPath, 'index.html');
    if (!fs.existsSync(indexPath)) return { error: 'Not a valid note (no index.html found)' };

    const { html, noteTitle, usesBackendAPIs } = inlineNoteAsHtml(noteFolderPath, noteCss);
    const safeTitle = noteTitle.replace(/[/\\:*?"<>|]/g, '-').slice(0, 100) || 'ExportedNote';

    const { canceled, filePath: destPath } = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: path.join(app.getPath('desktop'), `${safeTitle}.html`),
      filters: [{ name: 'HTML File', extensions: ['html'] }],
      message: usesBackendAPIs
        ? `"${noteTitle}" uses backend APIs (noteDB/noteSQL/etc.) that won't work in a browser.`
        : `Export "${noteTitle}" as a single HTML file`,
    });
    if (canceled || !destPath) return { cancelled: true };

    try {
      fs.writeFileSync(destPath, html, 'utf8');
      return { success: true, filePath: destPath, title: noteTitle, usesBackendAPIs };
    } catch (err) {
      return { error: `Export failed: ${err.message}` };
    }
  });


}
module.exports = { activate, registerHandlers };
