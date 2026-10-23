window.ExtensionPackages.register('nextprob.export-markdown', (api) => {
const { showToast, TabState, ICONS } = api;
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
const format = 'markdown';
api.onDispose(api.getService('nextprob.export-formats').registerFormat(format, filePath => api.transport.invoke('export:save-markdown', filePath)));
api.contributeMenu('resource.actions', target => (target.type === 'note' || (target.type === 'file' && target.path.toLowerCase().endsWith('.html'))) ? [{label:'Export as Markdown',action:'sidebar-export-markdown'}] : [], 10);
api.contributeMenu('tab.actions', target => [{label:'Export as Markdown',action:'tab-export-markdown', disabled: !target.path }], 10);
api.registerCommand('sidebar-export-markdown', target => api.getService("nextprob.export-formats").exportNoteAs(target.path, format));
api.registerCommand('tab-export-markdown', target => { if (target.path) return api.getService("nextprob.export-formats").exportNoteAs(target.path, format); });

});
