window.ExtensionPackages.register('nextprob.export-bulk', (api) => {
const { showToast, TabState, ICONS } = api;
function listen(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  api.onDispose(() => target.removeEventListener(event, handler, options));
}
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
// --- Bulk Export (feature 106) ---

let _bulkExportActive = false;

// Set up the IPC progress listener once at startup
const unsubscribeProgress = api.transport.subscribe('export:bulk-progress', ({ processed, total, currentFile }) => {
  _updateBulkExportBanner(processed, total, currentFile);
});
if (typeof unsubscribeProgress === "function") api.onDispose(unsubscribeProgress);
api.onDispose(() => { _hideBulkExportBanner(); document.getElementById("bulk-export-picker")?.remove(); });

/** Entry point called from the context menu action handler. */
function startBulkExport(folderPath) {
  _showBulkExportFormatPicker(folderPath);
}

/** Shows a small in-app modal to choose the export format. */
function _showBulkExportFormatPicker(folderPath) {
  document.getElementById('bulk-export-picker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'bulk-export-picker';
  picker.className = 'bulk-export-picker';
  picker.innerHTML =
    '<div class="bulk-export-picker-title">Choose Export Format</div>' +
    '<button data-fmt="html">HTML (as-is)</button>' +
    '<button data-fmt="pdf">PDF</button>' +
    '<button data-fmt="markdown">Markdown (.md)</button>' +
    '<button data-fmt="plaintext">Plain Text (.txt)</button>' +
    '<button class="bulk-export-picker-cancel">Cancel</button>';

  picker.querySelectorAll('button[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      picker.remove();
      _triggerBulkExport(folderPath, btn.dataset.fmt);
    });
  });

  picker.querySelector('.bulk-export-picker-cancel').addEventListener('click', () => {
    picker.remove();
  });

  // Click outside dismisses picker
  setTimeout(() => {
    listen(document, 'mousedown', function dismiss(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    });
  }, 0);

  document.body.appendChild(picker);
}

/** Triggers the actual export after format is selected. */
async function _triggerBulkExport(folderPath, format) {
  if (_bulkExportActive) {
    showToast('A bulk export is already in progress.');
    return;
  }
  _bulkExportActive = true;

  const result = await api.transport.invoke('export:bulk', folderPath, format);

  _bulkExportActive = false;
  _hideBulkExportBanner();

  if (result.cancelled) {
    // User cancelled — no toast needed
  } else if (result.error) {
    showToast('Export failed: ' + result.error);
  } else if (result.success) {
    const fileName = result.filePath.replace(/.*[\\/]/, '');
    showToast('Exported: ' + fileName);
  }
}

/** Creates or updates the progress banner at the bottom of the screen. */
function _updateBulkExportBanner(processed, total, currentFile) {
  let banner = document.getElementById('bulk-export-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'bulk-export-banner';
    banner.className = 'bulk-export-banner';
    banner.innerHTML =
      '<span class="bulk-export-banner-text"></span>' +
      '<button class="bulk-export-banner-cancel">Cancel</button>';
    banner.querySelector('.bulk-export-banner-cancel').addEventListener('click', () => {
      api.transport.send('export:bulk-cancel');
      _hideBulkExportBanner();
    });
    document.body.appendChild(banner);
  }

  const msg = total > 0
    ? `Exporting ${processed}/${total} \u2014 ${currentFile}`
    : currentFile;
  banner.querySelector('.bulk-export-banner-text').textContent = msg;
}

function _hideBulkExportBanner() {
  document.getElementById('bulk-export-banner')?.remove();
}


api.contributeMenu('folder.actions', () => [{label:'Bulk Export…',action:'bulk-export'}]);
api.registerCommand('bulk-export', target => startBulkExport(target.path));

});
