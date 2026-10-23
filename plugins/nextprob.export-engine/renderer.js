window.ExtensionPackages.register('nextprob.export-engine', (api) => {
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
const formatProviders = new Map();
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

api.onDispose(() => document.getElementById("export-format-picker")?.remove());
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

  document.getElementById('export-format-picker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'export-format-picker';
  picker.className = 'export-format-picker';
  picker.innerHTML =
    '<div class="export-format-picker-title">Export Note as\u2026</div>' +
    '<button data-fmt="pdf">PDF</button>' +
    '<button data-fmt="markdown">Markdown (.md)</button>' +
    '<button data-fmt="plaintext">Plain Text (.txt)</button>' +
    '<button data-fmt="html">HTML (copy)</button>' +
    '<button class="export-format-picker-cancel">Cancel</button>';

  picker.querySelectorAll('button[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      picker.remove();
      document.removeEventListener('keydown', onPickerKeydown);
      exportNoteAs(filePath, btn.dataset.fmt);
    });
  });

  picker.querySelector('.export-format-picker-cancel').addEventListener('click', () => {
    picker.remove();
    document.removeEventListener('keydown', onPickerKeydown);
  });

  function onPickerKeydown(e) {
    if (e.key === 'Escape') {
      picker.remove();
      document.removeEventListener('keydown', onPickerKeydown);
    }
  }
  listen(document, 'keydown', onPickerKeydown);

  setTimeout(() => {
    listen(document, 'mousedown', function dismiss(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('keydown', onPickerKeydown);
        document.removeEventListener('mousedown', dismiss);
      }
    });
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
