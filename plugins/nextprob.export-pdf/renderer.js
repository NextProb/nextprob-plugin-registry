window.ExtensionPackages.register('nextprob.export-pdf', (api) => {
const { showToast, TabState, ICONS } = api;
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
const format = 'pdf';
api.onDispose(api.getService('nextprob.export-formats').registerFormat(format, filePath => api.transport.invoke('export:save-pdf', filePath)));
api.contributeMenu('resource.actions', target => (target.type === 'note' || (target.type === 'file' && target.path.toLowerCase().endsWith('.html'))) ? [{label:'Export as PDF',action:'sidebar-export-pdf'}] : [], 0);
api.contributeMenu('tab.actions', target => [{ separator: true },{label:'Export as PDF',action:'tab-export-pdf', disabled: !target.path , shortcut: navigator.platform.includes('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E'}], 0);
api.registerCommand('sidebar-export-pdf', target => api.getService("nextprob.export-formats").exportNoteAs(target.path, format));
api.registerCommand('tab-export-pdf', target => { if (target.path) return api.getService("nextprob.export-formats").exportNoteAs(target.path, format); });

});
