'use strict';
const fs = require('fs');
const path = require('path');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const exportModule = api.require('nextprob.export-engine');
  exportModule.registerConverter('markdown', require('./converter').toMarkdownConverter);
  // --- Markdown export with Save dialog (feature 104) ---

  registerHandlers({ ...api.services, ipcMain, exportModule: exportModule, api });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api }) {
  ipcMain.handle('export:save-markdown', async (_e, notePath) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };
    const resolved = path.resolve(notePath);
    if (!isInsideWorkspace(resolved)) return { error: 'Path is outside the workspace' };

    let markdownContent;
    try {
      const result = await exportModule.exportNote(resolved, 'markdown');
      markdownContent = result.content;
    } catch (err) {
      return { error: err.message };
    }

    const baseName = path.basename(resolved, path.extname(resolved));
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(path.dirname(resolved), `${baseName}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (canceled || !filePath) return { cancelled: true };

    try {
      fs.writeFileSync(filePath, markdownContent, 'utf-8');
    } catch (err) {
      return { error: `Failed to write Markdown: ${err.message}` };
    }

    return { success: true, filePath };
  });


}
module.exports = { activate, registerHandlers };
