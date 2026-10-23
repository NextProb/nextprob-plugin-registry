'use strict';
const fs = require('fs');
const path = require('path');

function activate(api) {
  const ipcMain = api.ipc;
  const { app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb } = api.services;
  const exportModule = require('./engine');
  api.provide('nextprob.export-engine', exportModule);
  registerHandlers({ ...api.services, ipcMain, exportModule: exportModule, api });
}

function registerHandlers({ ipcMain, app, dialog, getWorkspacePath, getMainWindow, isInsideWorkspace, noteCss, noteDb, exportModule, api }) {
  // --- Export engine (feature 102) ---

  ipcMain.handle('export:note', async (_e, notePath, format, options) => {
    if (!getWorkspacePath()) return { error: 'No workspace open' };
    if (typeof notePath !== 'string' || !notePath) return { error: 'notePath is required' };
    const resolved = path.resolve(notePath);
    if (!isInsideWorkspace(resolved)) return { error: 'Path is outside the workspace' };
    try {
      return await exportModule.exportNote(resolved, format, options);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('export:formats', () => {
    return exportModule.getSupportedFormats();
  });


}
module.exports = { activate, registerHandlers };
