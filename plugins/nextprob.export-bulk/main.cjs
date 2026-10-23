'use strict';
const fs = require('fs');
const path = require('path');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const exportModule = api.require('nextprob.export-engine');
  const bulk = require('./bulk-export');
  bulk.configure(exportModule);
  const { bulkExport } = bulk;
  registerHandlers({ ...api.services, ipcMain, exportModule: exportModule, api, bulkExport });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api, bulkExport }) {
  // --- Bulk export to ZIP (feature 106) ---

  let _activeBulkExporter = null;

  ipcMain.handle('export:bulk', async (_e, folderPath, format) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof folderPath !== 'string' || !folderPath) return { error: 'folderPath is required' };
    if (typeof format !== 'string' || !format) return { error: 'format is required' };

    const resolved = path.resolve(folderPath);
    if (!isInsideWorkspace(resolved)) return { error: 'Path is outside the workspace' };

    if (_activeBulkExporter) {
      return { error: 'A bulk export is already in progress. Cancel it first.' };
    }

    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const { canceled, filePath: outputPath } = await dialog.showSaveDialog({
      defaultPath: path.join(getWorkspacePath(), `notes-export-${dateStr}.zip`),
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });

    if (canceled || !outputPath) return { cancelled: true };

    try { _e.sender.send('export:bulk-progress', { processed: 0, total: 0, currentFile: 'Preparing\u2026' }); } catch {}

    return new Promise((resolve) => {
      const exporter = bulkExport(resolved, format, getWorkspacePath(), { outputPath });
      _activeBulkExporter = exporter;

      exporter.on('progress', (data) => {
        try { _e.sender.send('export:bulk-progress', data); } catch {}
      });

      exporter.on('done', ({ zipPath }) => {
        _activeBulkExporter = null;
        resolve({ success: true, filePath: zipPath });
      });

      exporter.on('cancelled', () => {
        _activeBulkExporter = null;
        resolve({ cancelled: true });
      });

      exporter.on('error', (err) => {
        _activeBulkExporter = null;
        try { fs.unlinkSync(outputPath); } catch {}
        resolve({ error: err.message });
      });
    });
  });

  ipcMain.on('export:bulk-cancel', () => {
    if (_activeBulkExporter) {
      _activeBulkExporter.cancel();
    }
  });


}
module.exports = { activate, registerHandlers };
