'use strict';
const fs = require('fs');
const path = require('path');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const exportModule = api.require('nextprob.export-engine');
  const converter = require('./converter');
  converter.configure(api.services.rendering);
  exportModule.registerConverter('pdf', converter.toPdfConverter);
  // --- PDF export with Save dialog (feature 103) ---

  registerHandlers({ ...api.services, ipcMain, exportModule: exportModule, api });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api }) {
  ipcMain.handle('export:save-pdf', async (_e, notePath, options) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };
    const resolved = path.resolve(notePath);
    if (!isInsideWorkspace(resolved)) return { error: 'Path is outside the workspace' };

    _e.sender.send('export:pdf-progress', 'loading');

    let pdfBuffer;
    try {
      const result = await exportModule.exportNote(resolved, 'pdf', {
        notePath: resolved,
        workspacePath: getWorkspacePath(),
        ...(options || {}),
      });
      pdfBuffer = result.content;
    } catch (err) {
      return { error: err.message };
    }

    _e.sender.send('export:pdf-progress', 'saving');

    const baseName = path.basename(resolved, path.extname(resolved));
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(path.dirname(resolved), `${baseName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (canceled || !filePath) return { cancelled: true };

    try {
      fs.writeFileSync(filePath, pdfBuffer);
    } catch (err) {
      return { error: `Failed to write PDF: ${err.message}` };
    }

    return { success: true, filePath };
  });


}
module.exports = { activate, registerHandlers };
