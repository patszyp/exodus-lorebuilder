'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, globalShortcut, screen, protocol, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const netSock = require('net');
const { pathToFileURL } = require('url');

const APP_NAME = 'Exodus Lorebuilder';
const VERSION = require('./package.json').version;
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.mirai.exodus-lorebuilder');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

protocol.registerSchemesAsPrivileged([{ scheme: 'exodus', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const USER = () => app.getPath('userData');
const UPD_DIR = () => path.join(USER(), 'app-update');
const STATE_FILE = () => path.join(USER(), 'window.json');
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

let win = null, tray = null, trayItems = [], trayWanted = false, quitting = false, qnWin = null, qhot = '';
let miniBack = null;

/* ---------- window state ---------- */
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) } catch (e) { return {} } }
function writeState(extra) {
  try {
    const s = Object.assign(readState(), extra || {});
    if (win && !win.isDestroyed() && !miniBack && !win.isFullScreen()) { s.max = win.isMaximized(); if (!s.max) s.bounds = win.getBounds(); }
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s));
  } catch (e) {}
}
function fitBounds(b) {
  if (!b) return null;
  const d = screen.getDisplayMatching(b).workArea;
  const w = Math.min(b.width, d.width), h = Math.min(b.height, d.height);
  const x = Math.max(d.x, Math.min(b.x, d.x + d.width - w)), y = Math.max(d.y, Math.min(b.y, d.y + d.height - h));
  return { x, y, width: w, height: h };
}

/* ---------- the page ---------- */
function buildNo(f) { try { const fd = fs.openSync(f, 'r'); const st = fs.fstatSync(fd); const b = Buffer.alloc(Math.min(st.size, 8 * 1024 * 1024)); fs.readSync(fd, b, 0, b.length, Math.max(0, st.size - b.length)); fs.closeSync(fd); const m = /APPB=(\d+)/.exec(b.toString('utf8')); return m ? +m[1] : 0; } catch (e) { return -1; } }
let ROOT = null;
function pageRoot() {
  if (ROOT) return ROOT;
  const u = path.join(UPD_DIR(), 'index.html');
  ROOT = buildNo(u) > buildNo(path.join(__dirname, 'index.html')) ? UPD_DIR() : __dirname;
  return ROOT;
}
function serve() {
  protocol.handle('exodus', req => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname || '/');
    if (p === '/' || p === '') p = '/index.html';
    const root = pageRoot();
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const st = readState();
  const b = fitBounds(st.bounds) || { width: 1366, height: 820 };
  win = new BrowserWindow({
    ...b, minWidth: 960, minHeight: 600, frame: false, show: false, backgroundColor: '#010a13',
    title: APP_NAME, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, additionalArguments: ['--exodus-ver=' + VERSION] }
  });
  if (!st.bounds) win.center();
  win.once('ready-to-show', () => { if (st.max) win.maximize(); if (!process.argv.includes('--hidden')) win.show(); });
  win.loadURL('exodus://app/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('exodus://')) { e.preventDefault(); if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type === 'keyDown' && i.control && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (i.type === 'keyDown' && i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  let t = null; const keep = () => { clearTimeout(t); t = setTimeout(() => writeState(), 400); };
  win.on('resize', keep); win.on('move', keep);
  win.on('close', e => {
    if (!quitting && tray && trayWanted) { e.preventDefault(); win.hide(); return; }
    writeState();
  });
  win.on('closed', () => { win = null; });
}
function showWin() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

/* ---------- tray ---------- */
function trayBuild() {
  if (!trayWanted) { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) { tray = new Tray(nativeImage.createFromPath(ICON)); tray.setToolTip(APP_NAME); tray.on('click', showWin); }
  const items = trayItems.map(x => ({ label: x.label, click: () => { showWin(); win && win.webContents.send('trayaction', x.id); } }));
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open ' + APP_NAME, click: showWin }, ...(items.length ? [{ type: 'separator' }, ...items] : []), { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
}

/* ---------- quick note ---------- */
function quickNote() {
  if (qnWin) { qnWin.show(); qnWin.focus(); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  qnWin = new BrowserWindow({ width: 420, height: 300, x: Math.round(d.x + (d.width - 420) / 2), y: Math.round(d.y + (d.height - 300) / 3), frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#010a13', icon: ICON, show: false,
    webPreferences: { preload: path.join(__dirname, 'qnpreload.js'), contextIsolation: true, sandbox: true } });
  qnWin.loadFile(path.join(__dirname, 'quicknote.html'));
  qnWin.once('ready-to-show', () => { qnWin.show(); qnWin.focus(); });
  qnWin.on('blur', () => { if (qnWin) qnWin.close(); });
  qnWin.on('closed', () => { qnWin = null; });
}
ipcMain.on('qndone', (_e, t) => { if (t && t.trim()) { if (!win) createWindow(); const send = () => win.webContents.send('quicknote', t); if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send(); } if (qnWin) qnWin.close(); });
function setHotkey(k) {
  k = String(k || '').trim();
  if (k === qhot) return;
  try { if (qhot) globalShortcut.unregister(qhot); } catch (e) {}
  qhot = '';
  if (!k) return;
  try { if (globalShortcut.register(k.replace(/\bCtrl\b/i, 'CommandOrControl'), quickNote)) qhot = k.replace(/\bCtrl\b/i, 'CommandOrControl'); } catch (e) {}
}

/* ---------- Discord status (Discord's local IPC, no extra libraries) ---------- */
const RPC = { id: '', sock: null, ready: false, act: null, start: Date.now(), timer: null, buf: Buffer.alloc(0) };
function rpcFrame(op, obj) { const j = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(j.length, 4); return Buffer.concat([h, j]); }
function rpcClose() { try { RPC.sock && RPC.sock.destroy(); } catch (e) {} RPC.sock = null; RPC.ready = false; }
function rpcPipe(i) { return process.platform === 'win32' ? '\\\\?\\pipe\\discord-ipc-' + i : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', 'discord-ipc-' + i); }
function rpcConnect(i = 0) {
  if (!RPC.id || RPC.sock) return;
  if (i > 9) { rpcRetry(); return; }
  const s = netSock.createConnection(rpcPipe(i));
  let ok = false;
  s.once('connect', () => { ok = true; RPC.sock = s; RPC.buf = Buffer.alloc(0); s.write(rpcFrame(0, { v: 1, client_id: RPC.id })); });
  s.on('data', d => {
    RPC.buf = Buffer.concat([RPC.buf, d]);
    while (RPC.buf.length >= 8) {
      const op = RPC.buf.readInt32LE(0), len = RPC.buf.readInt32LE(4);
      if (RPC.buf.length < 8 + len) break;
      let msg = {}; try { msg = JSON.parse(RPC.buf.slice(8, 8 + len).toString()); } catch (e) {}
      RPC.buf = RPC.buf.slice(8 + len);
      if (op === 1 && msg.evt === 'READY') { RPC.ready = true; rpcSend(); }
      else if (op === 3) { try { s.write(rpcFrame(4, msg)); } catch (e) {} }
      else if (op === 2) { rpcClose(); }
    }
  });
  s.on('error', () => { if (!ok) { s.destroy(); rpcConnect(i + 1); } });
  s.on('close', () => { if (ok) { RPC.sock = null; RPC.ready = false; rpcRetry(); } });
}
function rpcRetry() { clearTimeout(RPC.timer); if (RPC.id) RPC.timer = setTimeout(() => rpcConnect(0), 20000); }
function rpcSend() {
  if (!RPC.ready || !RPC.sock) return;
  const a = RPC.act;
  let activity = null;
  if (a) {
    const t = (v, n) => (v == null ? '' : String(v)).slice(0, n || 128) || undefined;
    const assets = { large_image: t(a.large) || 'logo', large_text: t(a.largeText) || APP_NAME };
    if (t(a.small)) { assets.small_image = t(a.small); if (t(a.smallText)) assets.small_text = t(a.smallText); }
    activity = { details: t(a.details), state: t(a.state), assets };
    if (a.elapsed !== false) activity.timestamps = { start: Math.floor(RPC.start / 1000) };
    const btn = (Array.isArray(a.buttons) ? a.buttons : []).filter(b => b && b.label && /^https:\/\/\S+$/.test(String(b.url || ''))).slice(0, 2).map(b => ({ label: String(b.label).slice(0, 32), url: String(b.url).slice(0, 512) }));
    if (btn.length) activity.buttons = btn;
  }
  try { RPC.sock.write(rpcFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(Date.now()) + Math.random() })); } catch (e) {}
}
ipcMain.on('discordId', (_e, id) => { id = /^\d{15,25}$/.test(id) ? id : ''; if (id === RPC.id) return; RPC.id = id; rpcClose(); clearTimeout(RPC.timer); if (id) rpcConnect(0); });
ipcMain.on('presence', (_e, o) => { const n = o ? { details: o.details, state: o.state, large: o.large, largeText: o.largeText, small: o.small, smallText: o.smallText, elapsed: o.elapsed, buttons: o.buttons } : null; if (JSON.stringify(n) === JSON.stringify(RPC.act)) return; RPC.act = n; rpcSend(); });

/* ---------- bridge ---------- */
ipcMain.on('win', (_e, a) => {
  if (!win) return;
  if (a === 'min') win.minimize();
  else if (a === 'max') { if (win.isFullScreen()) win.setFullScreen(false); else if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (a === 'close') win.close();
});
ipcMain.on('fullscreen', (_e, b) => { if (win) win.setFullScreen(!!b); });
ipcMain.on('display', (_e, o) => {
  if (!win || miniBack) return;
  const mode = o.mode || 'window';
  const st = readState();
  if (mode === 'full') { win.setFullScreen(true); }
  else if (mode === 'borderless') { win.setFullScreen(false); const d = screen.getDisplayMatching(win.getBounds()).bounds; win.setBounds(d); }
  else {
    win.setFullScreen(false);
    const m = /^(\d+)x(\d+)$/.exec(o.res || '');
    const key = mode + ':' + (o.res || '');
    if (m && (st.lastDisplay !== key || st.lastMode === 'borderless')) {
      if (win.isMaximized()) win.unmaximize();
      const d = screen.getDisplayMatching(win.getBounds()).workArea;
      const w = Math.min(+m[1], d.width), h = Math.min(+m[2], d.height);
      win.setBounds({ x: Math.round(d.x + (d.width - w) / 2), y: Math.round(d.y + (d.height - h) / 2), width: w, height: h });
    }
    writeState({ lastDisplay: key });
  }
  writeState({ lastMode: mode });
});
ipcMain.on('mini', (_e, b) => {
  if (!win) return;
  if (b && !miniBack) { miniBack = { bounds: win.getBounds(), max: win.isMaximized(), full: win.isFullScreen() }; win.setFullScreen(false); if (win.isMaximized()) win.unmaximize(); const d = screen.getDisplayMatching(win.getBounds()).workArea; win.setMinimumSize(320, 420); win.setBounds({ x: d.x + d.width - 400, y: d.y + d.height - 640, width: 380, height: 620 }); win.setAlwaysOnTop(true, 'floating'); }
  else if (!b && miniBack) { const m = miniBack; miniBack = null; win.setAlwaysOnTop(false); win.setMinimumSize(960, 600); win.setBounds(m.bounds); if (m.max) win.maximize(); if (m.full) win.setFullScreen(true); }
});
ipcMain.handle('openApp', async (_e, p) => { if (!p) return false; try { return (await shell.openPath(p)) === ''; } catch (e) { return false; } });
ipcMain.handle('pickApp', async () => { const r = await dialog.showOpenDialog(win, { title: 'Choose an app', properties: ['openFile'], filters: [{ name: 'Apps', extensions: ['exe', 'lnk', 'bat', 'cmd', 'url'] }, { name: 'All files', extensions: ['*'] }] }); return r.canceled ? '' : r.filePaths[0]; });
ipcMain.handle('openExternal', async (_e, u) => { if (/^(https?:|mailto:)/i.test(u)) { await shell.openExternal(u); return true; } return false; });
ipcMain.handle('open', async (_e, t) => { t = String(t).trim(); if (/^(https?:|mailto:)/i.test(t)) { await shell.openExternal(t); return true; } if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) { await shell.openExternal(t); return true; } try { return (await shell.openPath(t)) === ''; } catch (e) { return false; } });
ipcMain.on('tray', (_e, b) => { trayWanted = !!b; trayBuild(); });
ipcMain.on('trayMenu', (_e, items) => { trayItems = items || []; trayBuild(); });
ipcMain.on('autostart', (_e, b) => { try { app.setLoginItemSettings({ openAtLogin: !!b, args: ['--hidden'] }); } catch (e) {} });
ipcMain.on('qhot', (_e, k) => setHotkey(k));
ipcMain.handle('openData', async () => { await shell.openPath(USER()); return true; });
function installHtml(html) {
  html = String(html || '');
  if (html.length < 100000 || !/Exodus/i.test(html) || !/<script/i.test(html)) return { ok: false, msg: 'That is not an Exodus Lorebuilder file' };
  const nb = (/APPB=(\d+)/.exec(html) || [])[1] || 0, cb = buildNo(path.join(pageRoot(), 'index.html'));
  if (+nb <= cb) return { ok: false, msg: 'You already have this version or a newer one' };
  try {
    fs.mkdirSync(UPD_DIR(), { recursive: true });
    const cur = path.join(UPD_DIR(), 'index.html');
    if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(UPD_DIR(), 'index.prev.html'));
    fs.writeFileSync(cur, html);
  } catch (e) { return { ok: false, msg: 'Could not save the update' }; }
  ROOT = null;
  setTimeout(() => { if (win) win.webContents.reloadIgnoringCache(); }, 900);
  return { ok: true };
}
ipcMain.handle('installUpdateData', async (_e, html) => installHtml(html));
ipcMain.handle('installUpdate', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the new Exodus Lorebuilder file', properties: ['openFile'], filters: [{ name: 'Exodus Lorebuilder', extensions: ['html', 'htm'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  let html = '';
  try { html = fs.readFileSync(r.filePaths[0], 'utf8'); } catch (e) { return { ok: false, msg: 'Could not read that file' }; }
  return installHtml(html);
});


/* ---------- Wi-Fi pairing: a small local server phones on the same network talk to ---------- */
const http = require('http'), os = require('os'), crypto = require('crypto');
const WF = { srv: null, port: 0, pin: '', pairing: 0, peers: {}, inbox: {}, err: '' };
const WF_FILE = () => path.join(USER(), 'wifi-pairing.json');
const WF_DIR = () => path.join(app.getPath('downloads'), 'Exodus Lorebuilder');
try { WF.peers = JSON.parse(fs.readFileSync(WF_FILE(), 'utf8')).peers || {}; } catch (e) {}
const wfSave = () => { try { fs.writeFileSync(WF_FILE(), JSON.stringify({ peers: WF.peers })); } catch (e) {} };
const wfIPs = () => { const r = []; for (const [n, L] of Object.entries(os.networkInterfaces())) for (const i of L || []) if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) r.push({ ip: i.address, n }); r.sort((a, b) => (/^192\.168\./.test(b.ip) ? 1 : 0) - (/^192\.168\./.test(a.ip) ? 1 : 0)); return r; };
const wfTell = m => { try { if (win && !win.isDestroyed()) win.webContents.send('wf', m); } catch (e) {} };
const wfStatus = () => ({ on: !!WF.srv, port: WF.port, ips: wfIPs(), pin: WF.pairing ? WF.pin : '', pairing: WF.pairing, err: WF.err, name: os.hostname(), dir: WF_DIR(), peers: Object.entries(WF.peers).map(([t, p]) => ({ id: t.slice(0, 8), name: p.name, at: p.at, last: p.last || 0, q: (WF.inbox[t] || []).length })) });
function wfStart() {
  if (WF.srv) return Promise.resolve(wfStatus());
  return new Promise(ok => {
    const srv = http.createServer(wfHandle);
    let port = 47821;
    const tryIt = () => { srv.once('error', e => { if (e.code === 'EADDRINUSE' && port < 47830) { port++; tryIt(); } else { WF.err = String(e.code || e.message); ok(wfStatus()); } }); srv.listen(port, '0.0.0.0', () => { WF.srv = srv; WF.port = port; WF.err = ''; ok(wfStatus()); }); };
    tryIt();
  });
}
function wfHandle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-token,x-name,x-kind,x-file');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'x-name,x-kind,x-file,x-from');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x'), json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = lim => new Promise((ok, no) => { const B = []; let n = 0; req.on('data', d => { n += d.length; if (n > lim) { no(new Error('big')); req.destroy(); } else B.push(d); }); req.on('end', () => ok(Buffer.concat(B))); req.on('error', no); });
  if (u.pathname === '/hello') return json(200, { app: 'exodus', name: os.hostname(), pairing: WF.pairing ? 1 : 0, v: 1 });
  if (u.pathname === '/pair' && req.method === 'POST') return body(4096).then(b => { let o = {}; try { o = JSON.parse(b.toString()); } catch (e) {} if (!WF.pairing || String(o.pin) !== WF.pin) return json(403, { err: 'pin' }); const t = crypto.randomBytes(18).toString('hex'); WF.peers[t] = { name: String(o.name || 'Phone').slice(0, 40), at: Date.now(), last: Date.now() }; wfSave(); WF.pairing = 0; WF.pin = ''; wfTell({ type: 'paired', name: WF.peers[t].name }); json(200, { token: t, name: os.hostname() }); }).catch(() => json(400, {}));
  const t = String(req.headers['x-token'] || ''), P = WF.peers[t];
  if (!P) return json(401, { err: 'token' });
  const was = P.last || 0; P.last = Date.now(); if (Date.now() - was > 20000) wfTell({ type: 'peer', name: P.name, on: 1 });
  if (u.pathname === '/ping') return json(200, { ok: 1, name: os.hostname(), q: (WF.inbox[t] || []).map(x => ({ id: x.id, name: x.name, kind: x.kind, size: x.data.length })) });
  if (u.pathname === '/unpair' && req.method === 'POST') { delete WF.peers[t]; delete WF.inbox[t]; wfSave(); wfTell({ type: 'unpaired', name: P.name }); return json(200, { ok: 1 }); }
  if (u.pathname === '/get') { const L = WF.inbox[t] || [], i = L.findIndex(x => x.id === u.searchParams.get('id')); if (i < 0) return json(404, {}); const x = L[i]; L.splice(i, 1); res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-name': encodeURIComponent(x.name), 'x-kind': x.kind, 'x-from': encodeURIComponent(os.hostname()) }); res.end(x.data); wfTell({ type: 'delivered', name: x.name, to: P.name }); return; }
  if (u.pathname === '/send' && req.method === 'POST') return body(600 * 1024 * 1024).then(b => {
    const kind = String(req.headers['x-kind'] || 'file'), name = decodeURIComponent(String(req.headers['x-file'] || 'file')).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'file';
    if (kind === 'universe') { const f = path.join(USER(), 'wifi-universe.json'); fs.writeFileSync(f, b); wfTell({ type: 'universe', from: P.name, size: b.length, path: f }); return json(200, { ok: 1 }); }
    fs.mkdirSync(WF_DIR(), { recursive: true }); let f = path.join(WF_DIR(), name), k = 1; while (fs.existsSync(f)) { const e = path.extname(name); f = path.join(WF_DIR(), path.basename(name, e) + ' (' + (k++) + ')' + e); }
    fs.writeFileSync(f, b); wfTell({ type: 'file', from: P.name, name: path.basename(f), size: b.length, path: f, mime: String(req.headers['content-type'] || '') }); json(200, { ok: 1 });
  }).catch(() => json(413, { err: 'size' }));
  json(404, {});
}
ipcMain.handle('wfStart', () => wfStart());
ipcMain.handle('wfStatus', () => wfStatus());
ipcMain.handle('wfPairing', (_e, on) => { WF.pairing = on ? Date.now() : 0; WF.pin = on ? String(1000 + crypto.randomInt(9000)) : ''; return wfStatus(); });
ipcMain.handle('wfUnpair', (_e, id) => { for (const t of Object.keys(WF.peers)) if (t.slice(0, 8) === id) { delete WF.peers[t]; delete WF.inbox[t]; } wfSave(); return wfStatus(); });
ipcMain.handle('wfQueue', (_e, id, name, kind, data) => { for (const t of Object.keys(WF.peers)) if (t.slice(0, 8) === id) { (WF.inbox[t] = WF.inbox[t] || []).push({ id: crypto.randomBytes(6).toString('hex'), name: String(name || 'file'), kind: String(kind || 'file'), data: Buffer.from(data) }); return true; } return false; });
ipcMain.handle('wfRead', (_e, f) => { try { if (!String(f).startsWith(USER()) && !String(f).startsWith(WF_DIR())) return null; return fs.readFileSync(f); } catch (e) { return null; } });
ipcMain.handle('wfOpenDir', async (_e, f) => { try { if (f) shell.showItemInFolder(f); else { fs.mkdirSync(WF_DIR(), { recursive: true }); await shell.openPath(WF_DIR()); } } catch (e) {} return true; });



/* ---------- updating the Windows app from its own files (main.js, preload.js, package.json) ---------- */
ipcMain.handle('shellFiles', async (_e, f) => {
  f = f || {};
  const ok = (k, re) => typeof f[k] === 'string' && f[k].length > 50 && re.test(f[k]);
  if (!ok('main', /require\('electron'\)/) || !ok('preload', /contextBridge/) || !ok('package', /"main"\s*:/)) return { ok: false, msg: 'The update files look wrong' };
  let v = ''; try { v = JSON.parse(f.package).version || ''; } catch (e) { return { ok: false, msg: 'The update files look wrong' }; }
  const dir = __dirname, names = { main: 'main.js', preload: 'preload.js', package: 'package.json' };
  try {
    for (const [k, n] of Object.entries(names)) { const t = path.join(dir, n); if (fs.existsSync(t)) fs.copyFileSync(t, t + '.bak'); }
    for (const [k, n] of Object.entries(names)) fs.writeFileSync(path.join(dir, n) + '.new', f[k]);
    for (const [k, n] of Object.entries(names)) fs.renameSync(path.join(dir, n) + '.new', path.join(dir, n));
  } catch (e) {
    try { for (const n of Object.values(names)) { const t = path.join(dir, n); if (fs.existsSync(t + '.bak')) fs.copyFileSync(t + '.bak', t); } } catch (x) {}
    return { ok: false, msg: 'This copy of the app can not update itself (' + (e.code || 'error') + ')' };
  }
  setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 900);
  return { ok: true, version: v };
});

/* ---------- updating the Windows app itself from a GitHub release zip ---------- */
ipcMain.handle('shellUpdate', async (_e, url) => {
  url = String(url || '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^/?#]+\/[^/?#]+\.zip$/i.test(url)) return { ok: false, msg: 'That is not a release download link' };
  if (process.platform !== 'win32') return { ok: false, msg: 'This only works on Windows' };
  const tmp = path.join(app.getPath('temp'), 'exodus-app-update');
  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); } catch (e) { return { ok: false, msg: 'Could not make a folder for the update' }; }
  const zip = path.join(tmp, 'update.zip');
  try {
    const r = await net.fetch(url);
    if (!r.ok) return { ok: false, msg: 'Download failed (' + r.status + ')' };
    const total = +r.headers.get('content-length') || 0, out = fs.createWriteStream(zip), rd = r.body.getReader();
    let n = 0, last = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (!out.write(Buffer.from(value))) await new Promise(o => out.once('drain', o)); if (Date.now() - last > 250) { last = Date.now(); try { win && win.webContents.send('shellprog', { n, total }); } catch (e) {} } }
    await new Promise(o => out.end(o));
    if (n < 1000000) return { ok: false, msg: 'The download was incomplete' };
  } catch (e) { return { ok: false, msg: 'Download failed' }; }
  const q = s => String(s).replace(/'/g, "''");
  const ps = path.join(tmp, 'run.ps1');
  fs.writeFileSync(ps, [
    "$ErrorActionPreference = 'Stop'",
    'Start-Sleep -Seconds 2',
    `$d = Join-Path '${q(tmp)}' 'x'`,
    `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath $d -Force`,
    "$i = Get-ChildItem -LiteralPath $d -Recurse -Filter 'install.ps1' | Select-Object -First 1",
    'if (-not $i) { exit 1 }',
    '& $i.FullName'
  ].join('\r\n'));
  try {
    require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { return { ok: false, msg: 'Could not start the installer' }; }
  setTimeout(() => { quitting = true; app.exit(0); }, 1200);
  return { ok: true };
});

/* ---------- start ---------- */
app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; writeState(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} rpcClose(); try { WF.srv && WF.srv.close(); } catch (e) {} });
app.on('window-all-closed', () => { if (!(tray && trayWanted)) app.quit(); });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  serve();
  createWindow();
});
