'use strict';
const fs = require('fs');
const path = require('path');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const exportModule = api.require('nextprob.export-engine');
  exportModule.registerConverter('plaintext', require('./converter').toPlainTextConverter);
  // --- Plain text export with Save dialog (feature 105) ---

  registerHandlers({ ...api.services, ipcMain, exportModule: exportModule, api });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api }) {
  ipcMain.handle('export:save-plaintext', async (_e, notePath) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };
    const resolved = path.resolve(notePath);
    if (!isInsideWorkspace(resolved)) return { error: 'Path is outside the workspace' };

    let textContent;
    try {
      const result = await exportModule.exportNote(resolved, 'plaintext');
      textContent = result.content;
    } catch (err) {
      return { error: err.message };
    }

    const baseName = path.basename(resolved, path.extname(resolved));
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(path.dirname(resolved), `${baseName}.txt`),
      filters: [{ name: 'Plain Text', extensions: ['txt'] }],
    });

    if (canceled || !filePath) return { cancelled: true };

    try {
      fs.writeFileSync(filePath, textContent, 'utf-8');
    } catch (err) {
      return { error: `Failed to write plain text: ${err.message}` };
    }

    return { success: true, filePath };
  });


}
module.exports = { activate, registerHandlers };
