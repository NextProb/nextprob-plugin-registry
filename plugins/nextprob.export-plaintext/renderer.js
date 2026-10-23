window.ExtensionPackages.register('nextprob.export-plaintext', (api) => {
const { showToast, TabState, ICONS } = api;
api = { ...api };
for (const name of ['contributeMenu', 'registerCommand', 'registerKeybinding', 'contributeIndicator', 'contributeSettings', 'registerService', 'onProjectSurfaceChanged']) {
  const register = api[name];
  if (register) api[name] = (...args) => { const dispose = register(...args); api.onDispose(dispose); return dispose; };
}
const format = 'plaintext';
api.onDispose(api.getService('nextprob.export-formats').registerFormat(format, filePath => api.transport.invoke('export:save-plaintext', filePath)));
api.contributeMenu('resource.actions', target => (target.type === 'note' || (target.type === 'file' && target.path.toLowerCase().endsWith('.html'))) ? [{label:'Export as Plain Text',action:'sidebar-export-plaintext'}] : [], 20);
api.contributeMenu('tab.actions', target => [{label:'Export as Plain Text',action:'tab-export-plaintext', disabled: !target.path }], 20);
api.registerCommand('sidebar-export-plaintext', target => api.getService("nextprob.export-formats").exportNoteAs(target.path, format));
api.registerCommand('tab-export-plaintext', target => { if (target.path) return api.getService("nextprob.export-formats").exportNoteAs(target.path, format); });

});
