window.ExtensionPackages.register('nextprob.export-engine', (api) => {
const { showToast, TabState, ICONS } = api;
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
const formatProviders = new Map();
const EXPORT_FORMAT_ORDER = ['pdf', 'markdown', 'plaintext', 'html'];
const EXPORT_FORMAT_LABELS = new Map([
  ['pdf', 'PDF'],
  ['markdown', 'Markdown (.md)'],
  ['plaintext', 'Plain Text (.txt)'],
  ['html', 'HTML (copy)'],
]);
async function exportNoteAs(filePath, format) {
  try {
    const provider = formatProviders.get(format);
    if (!provider) { showToast(`Unknown export format: ${format}`); return; }
    const result = await provider(filePath);
    if (!result) return;
    if (result.cancelled) return;
    if (result.error) {
      showToast(`Export failed: ${result.error}`);
      return;
    }
    if (result.success && result.filePath) {
      showToast(`Exported to ${result.filePath}`);
    }
  } catch (err) {
    showToast(`Export failed: ${err.message}`);
  }
}

let closeActivePicker = null;
api.onDispose(() => {
  if (closeActivePicker) closeActivePicker();
  document.getElementById("export-format-picker")?.remove();
});
function showExportFormatPicker() {
  const panel = TabState.getFocusedPanel();
  const targetPanel = panel || TabState.getState().panels.find(p => p.activeTabId);
  if (!targetPanel) {
    showToast('No note open to export');
    return;
  }
  const activeTab = TabState.getActiveTab(targetPanel.id);
  if (!activeTab || !activeTab.filePath || activeTab.type === 'extension') {
    showToast('No note open to export');
    return;
  }
  const filePath = activeTab.filePath;

  if (closeActivePicker) closeActivePicker();

  const picker = document.createElement('div');
  picker.id = 'export-format-picker';
  picker.className = 'export-format-picker';

  const title = document.createElement('div');
  title.className = 'export-format-picker-title';
  title.textContent = 'Export Note as\u2026';
  picker.appendChild(title);

  const registeredFormats = [...formatProviders.keys()];
  const orderedFormats = [
    ...EXPORT_FORMAT_ORDER.filter(format => formatProviders.has(format)),
    ...registeredFormats.filter(format => !EXPORT_FORMAT_ORDER.includes(format)),
  ];

  if (orderedFormats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'export-format-picker-empty';
    empty.textContent = 'No export formats are installed. Install or enable an export format plugin in Settings \u2192 Plugins.';
    picker.appendChild(empty);
  } else {
    for (const format of orderedFormats) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.fmt = format;
      button.textContent = EXPORT_FORMAT_LABELS.has(format) ? EXPORT_FORMAT_LABELS.get(format) : format;
      button.addEventListener('click', () => {
        close();
        exportNoteAs(filePath, format);
      });
      picker.appendChild(button);
    }
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'export-format-picker-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  picker.appendChild(cancel);

  let closed = false;
  let dismissTimer = null;

  function onPickerKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function onDocumentMousedown(e) {
    if (!picker.contains(e.target)) close();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    document.removeEventListener('keydown', onPickerKeydown);
    document.removeEventListener('mousedown', onDocumentMousedown);
    picker.remove();
    if (closeActivePicker === close) closeActivePicker = null;
  }

  closeActivePicker = close;

  document.addEventListener('keydown', onPickerKeydown);
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    if (!closed) document.addEventListener('mousedown', onDocumentMousedown);
  }, 0);

  document.body.appendChild(picker);
}


api.registerKeybinding(e => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key === 'E') { e.preventDefault(); showExportFormatPicker(); return true; } return false; });
api.registerService("nextprob.export-formats", { exportNoteAs, registerFormat(format, provider) {
  if (formatProviders.has(format)) throw new Error(`Duplicate export format: ${format}`);
  formatProviders.set(format, provider);
  return () => formatProviders.delete(format);
} });

});
