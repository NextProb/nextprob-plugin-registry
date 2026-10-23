window.ExtensionPackages.register('nextprob.export-html', (api) => {
const { showToast, TabState, ICONS } = api;
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
const format = 'html';
api.onDispose(api.getService('nextprob.export-formats').registerFormat(format, filePath => api.transport.invoke('export:save-html', filePath)));
api.contributeMenu('resource.actions', target => (target.type === 'note' || (target.type === 'file' && target.path.toLowerCase().endsWith('.html'))) ? [{label:'Export as HTML (copy)',action:'sidebar-export-html'}] : [], 30);
api.contributeMenu('tab.actions', target => [{label:'Export as HTML (copy)',action:'tab-export-html', disabled: !target.path }], 30);
api.registerCommand('sidebar-export-html', target => api.getService("nextprob.export-formats").exportNoteAs(target.path, format));
api.registerCommand('tab-export-html', target => { if (target.path) return api.getService("nextprob.export-formats").exportNoteAs(target.path, format); });
api.contributeMenu('resource.actions', target => target.type === 'note' ? [{label:'Export as Single HTML File',action:'sidebar-export-single-html'}] : [], 40);
api.registerCommand('sidebar-export-single-html', target => handleAction('sidebar-export-single-html', target));
async function handleAction(action,target) { switch(action) {
    case 'sidebar-export-single-html': {
      showToast('Exporting as single HTML file\u2026');
      try {
        const result = await api.transport.invoke('export:single-html', target.path);
        if (result.error) {
          showToast(`Export failed: ${result.error}`);
        } else if (result.cancelled) {
          // user cancelled save dialog
        } else {
          const warning = result.usesBackendAPIs ? ' (note: backend APIs won\u2019t work in browser)' : '';
          showToast(`Exported "${result.title}" as HTML file${warning}`);
        }
      } catch (err) {
        showToast(`Export failed: ${err.message}`);
      }
      break;
    }

} }
});
