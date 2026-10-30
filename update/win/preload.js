const { contextBridge, ipcRenderer } = require('electron');
const ver = (process.argv.find(a => a.startsWith('--exodus-ver=')) || '').split('=')[1] || '';
const send = (c, ...a) => ipcRenderer.send(c, ...a);
const call = (c, ...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('exodus', {
  version: ver,
  win: a => send('win', a),
  fullscreen: b => send('fullscreen', !!b),
  display: o => send('display', o || {}),
  mini: b => send('mini', !!b),
  presence: o => send('presence', o || null),
  discordId: id => send('discordId', String(id || '')),
  openApp: p => call('openApp', String(p || '')),
  pickApp: () => call('pickApp'),
  open: t => call('open', String(t || '')),
  openExternal: u => call('openExternal', String(u || '')),
  tray: b => send('tray', !!b),
  trayMenu: items => send('trayMenu', Array.isArray(items) ? items.map(x => ({ id: String(x.id), label: String(x.label) })) : []),
  autostart: b => send('autostart', !!b),
  quickNoteHotkey: k => send('qhot', String(k || '')),
  autoUpdate: () => {},
  installUpdate: () => call('installUpdate'),
  installUpdateData: h => call('installUpdateData', String(h || '')),
  openData: () => call('openData'),
  wfStart: () => call('wfStart'),
  wfStatus: () => call('wfStatus'),
  wfPairing: b => call('wfPairing', !!b),
  wfUnpair: id => call('wfUnpair', String(id || '')),
  wfQueue: (id, name, kind, data) => call('wfQueue', String(id || ''), String(name || ''), String(kind || ''), data),
  wfRead: f => call('wfRead', String(f || '')),
  wfOpenDir: f => call('wfOpenDir', f ? String(f) : ''),
  shellFiles: f => call('shellFiles', f && typeof f === 'object' ? { main: String(f.main || ''), preload: String(f.preload || ''), package: String(f.package || '') } : {}),
  shellUpdate: u => call('shellUpdate', String(u || '')),
  onShellProg: cb => ipcRenderer.on('shellprog', (_e, m) => { try { cb(m) } catch (e) {} }),
  syncPut: (state, rev, media) => call('syncPut', String(state || ''), +rev || 0, media && typeof media === 'object' ? media : {}),
  onWf: cb => ipcRenderer.on('wf', (_e, m) => { try { cb(m) } catch (e) {} }),
  onQuickNote: cb => ipcRenderer.on('quicknote', (_e, t) => { try { cb(t) } catch (e) {} }),
  onTrayAction: cb => ipcRenderer.on('trayaction', (_e, a) => { try { cb(a) } catch (e) {} })
});
