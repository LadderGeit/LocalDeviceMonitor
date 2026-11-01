const { app, BrowserWindow, ipcMain, shell, Menu, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// In a checkout, the watcher's scripts live in the folder above this one and it writes its
// files there too. Installed, the scripts come with the app (its resources folder) and the data
// lives in %LOCALAPPDATA%, where upgrades and uninstalls leave it alone.
// LOCAL_DEVICE_MONITOR_DATA points the dashboard at other data, e.g. a sample.
const scriptsDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const dataDir = process.env.LOCAL_DEVICE_MONITOR_DATA
  || (app.isPackaged ? path.join(process.env.LOCALAPPDATA, 'Local Device Monitor', 'Data') : scriptsDir);
const watcherScript = path.join(scriptsDir, 'Watch-Device.ps1');
const scanScript = path.join(scriptsDir, 'Scan-Network.ps1');
const files = {
  config: path.join(dataDir, 'device-config.json'),
  status: path.join(dataDir, 'watcher-status.json'),
  vendors: path.join(dataDir, 'vendor-cache.json'),
  logs: path.join(dataDir, 'logs'),
};
const MAC_PATTERN = /^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/;
const IP_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

let win = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// Writes to a temp file first, so the watcher never reads a half-written file.
function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// Every device's events from logs\<MAC>.jsonl, oldest first.
function readEvents() {
  let names;
  try {
    names = fs.readdirSync(files.logs).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const events = [];
  for (const name of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(files.logs, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line.replace(/^﻿/, '')));
      } catch {
        // A line the watcher is still writing; it'll be complete on the next read.
      }
    }
  }
  return events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function watcherRunning(status = readJson(files.status)) {
  return Boolean(status && !status.stopped && isRunning(status.watcherPid));
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

// Sets one of the Windows events the watcher listens for: 'Stop' or 'Reload'.
function signalWatcher(name) {
  return runPowerShell(['-Command', `try { [void][Threading.EventWaitHandle]::OpenExisting('Local\\LocalDeviceMonitor-${name}').Set() } catch { }`]).catch(() => {});
}

function logPath(mac, extension) {
  return path.join(files.logs, `${mac}.${extension}`);
}

// ---------- Internet ----------

// Watching devices only needs the local network. The internet is for two lookups: manufacturer
// names and the public IP. This is whether it answered the last time either was tried; null
// until the first try. Requests go through Electron's net, so they follow the system's proxy.
let internet = null;
const LOOKUP_TIMEOUT = 8000;

function setInternet(ok) {
  if (internet === ok) return;
  const cameBack = ok && internet === false;
  internet = ok;
  // Manufacturers that couldn't be looked up while offline get another go.
  if (cameBack && failedPrefixes.size) {
    for (const prefix of failedPrefixes) if (!vendorQueue.includes(prefix)) vendorQueue.push(prefix);
    failedPrefixes.clear();
    lookUpVendors();
  }
  win?.webContents.send('data:changed');
}

// Public addresses: the network's IPv4 address, which every device behind the modem shares, and
// each device's own IPv6 addresses by MAC, as far as Windows has seen them. The IPv4 address
// comes from Cloudflare, which sees it on any request anyway; 1.1.1.1 makes it the IPv4 one.
const addresses = { publicIPv4: null, ipv6: {} };

async function checkInternet() {
  try {
    const response = await net.fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
    addresses.publicIPv4 = (await response.text()).match(/^ip=(.+)$/m)?.[1].trim() ?? addresses.publicIPv4;
    setInternet(true);
  } catch {
    setInternet(false);
  }
}

async function refreshAddresses() {
  await checkInternet();
  try {
    addresses.ipv6 = JSON.parse((await runPowerShell(['-File', scanScript, '-AddressesOnly'])).trim() || '{}');
  } catch {
    // Keep the last ones.
  }
  win?.webContents.send('data:changed');
}

ipcMain.handle('data:get', () => {
  const status = readJson(files.status);
  return {
    status,
    config: readJson(files.config),
    events: readEvents(),
    watcherRunning: watcherRunning(status),
    addresses,
    internet,
  };
});

ipcMain.handle('open:log', (_, mac) => shell.openPath(MAC_PATTERN.test(mac ?? '') ? logPath(mac, 'txt') : files.logs));
ipcMain.handle('open:folder', () => shell.openPath(dataDir));

// Deletes one device's log, or every device's when no MAC is given. The watcher starts a new
// file with its next event.
ipcMain.handle('log:clear', (_, mac) => {
  const macs = MAC_PATTERN.test(mac ?? '')
    ? [mac]
    : fs.readdirSync(files.logs).filter((name) => /\.(txt|jsonl)$/.test(name)).map((name) => name.replace(/\.(txt|jsonl)$/, ''));
  for (const each of new Set(macs)) {
    fs.rmSync(logPath(each, 'txt'), { force: true });
    fs.rmSync(logPath(each, 'jsonl'), { force: true });
  }
});

// ---------- Watcher ----------

// Starts the watcher the way the Startup shortcut does, hidden, by opening a shortcut. Windows
// then launches it on its own: a process the dashboard spawned itself would be closed along
// with the dashboard, and a detached one gets no console, which PowerShell needs.
function startWatcher() {
  const link = path.join(app.getPath('userData'), 'Start watcher.lnk');
  shell.writeShortcutLink(link, {
    target: path.join(process.env.SystemRoot, 'System32', 'conhost.exe'),
    args: `--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${watcherScript}" -DataFolder "${dataDir}"`,
    cwd: scriptsDir,
  });
  return shell.openPath(link);
}

// Asks the watcher to stop, so it logs a STOP for each device and exits cleanly. Resolves once
// it has exited, or after 15 seconds.
async function stopWatcher() {
  const status = readJson(files.status);
  if (!watcherRunning(status)) return;
  await signalWatcher('Stop');
  for (let waited = 0; waited < 15000 && isRunning(status.watcherPid); waited += 250) await sleep(250);
}

ipcMain.handle('watcher:start', () => startWatcher());
ipcMain.handle('watcher:stop', () => stopWatcher());

// Adds a device to device-config.json or changes it: its name, or whether it's watched. Then
// tells the running watcher to reload, or starts the watcher when there's something to watch.
ipcMain.handle('devices:update', async (_, change) => {
  if (!MAC_PATTERN.test(change?.mac ?? '')) throw new Error('Not a valid MAC address');
  const config = readJson(files.config) ?? {};
  const devices = Array.isArray(config.devices) ? config.devices : [];
  let device = devices.find((d) => d.mac === change.mac);
  if (!device) {
    if (!IP_PATTERN.test(change.ip ?? '')) throw new Error('Not a valid IP address');
    device = { mac: change.mac, ip: change.ip, name: '', watch: false };
    devices.push(device);
  }
  if (IP_PATTERN.test(change.ip ?? '')) device.ip = change.ip;
  if (typeof change.name === 'string') device.name = change.name.trim().slice(0, 40);
  if (typeof change.watch === 'boolean') device.watch = change.watch;
  writeJson(files.config, { ...config, devices });

  if (watcherRunning()) await signalWatcher('Reload');
  else if (devices.some((d) => d.watch)) await startWatcher();
});

// ---------- Network scan ----------

// Manufacturer names by MAC prefix, saved so each prefix is looked up only once.
let vendorCache = null;
const vendorQueue = [];
// Prefixes that couldn't be looked up because the internet was gone; retried when it's back.
const failedPrefixes = new Set();
let lookingUp = false;

// Phones and tablets often use a made-up "private" address, marked by this bit. Those have no
// manufacturer to look up.
function isRandomized(mac) {
  return (parseInt(mac.slice(0, 2), 16) & 2) !== 0;
}

ipcMain.handle('network:scan', async () => {
  const answers = JSON.parse((await runPowerShell(['-File', scanScript])).trim() || '[]');
  // A device can answer on more than one address (an access point, say); list it once.
  const byMac = new Map();
  for (const answer of answers) {
    const device = byMac.get(answer.mac);
    if (device) {
      device.ips.push(answer.ip);
      device.hostname ||= answer.hostname;
      device.isSelf ||= answer.isSelf;
      device.isGateway ||= answer.isGateway;
    } else {
      byMac.set(answer.mac, { ...answer, ips: [answer.ip], ipv6: answer.ipv6 ?? [] });
    }
  }
  vendorCache ??= readJson(files.vendors) ?? {};
  const devices = [...byMac.values()];
  for (const device of devices) {
    const prefix = device.mac.slice(0, 8);
    device.ip = device.ips[0];
    if (device.ipv6?.length) addresses.ipv6[device.mac] = device.ipv6;
    device.randomized = isRandomized(device.mac);
    // undefined: not looked up yet. '': looked up, but the manufacturer isn't known.
    device.vendor = device.randomized ? null : vendorCache[prefix];
    if (!device.randomized && !(prefix in vendorCache) && !vendorQueue.includes(prefix)) vendorQueue.push(prefix);
  }
  lookUpVendors();
  return devices;
});

// Looks up manufacturers one at a time, as macvendors.com allows one request per second. Only
// the first half of each MAC address, the part that identifies the manufacturer, is sent.
async function lookUpVendors() {
  if (lookingUp) return;
  lookingUp = true;
  while (vendorQueue.length) {
    const prefix = vendorQueue.shift();
    let response;
    try {
      response = await net.fetch(`https://api.macvendors.com/${prefix}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
    } catch {
      // No internet: keep this one and the rest for when it's back, instead of failing each.
      failedPrefixes.add(prefix);
      for (const rest of vendorQueue.splice(0)) failedPrefixes.add(rest);
      setInternet(false);
      break;
    }
    setInternet(true);
    if (response.ok || response.status === 404) {
      vendorCache[prefix] = response.ok ? (await response.text()).trim() : '';
      writeJson(files.vendors, vendorCache);
      win?.webContents.send('network:vendor', { prefix, vendor: vendorCache[prefix] });
    } else if (response.status === 429) {
      // Asked too fast: try it again after the others.
      vendorQueue.push(prefix);
      await sleep(2000);
    }
    await sleep(1100);
  }
  lookingUp = false;
}

// ---------- Window ----------

function watchDataFiles() {
  let timer = null;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => win?.webContents.send('data:changed'), 300);
  };
  const watched = new Set([files.config, files.status].map((file) => path.basename(file)));
  fs.watch(dataDir, (_, name) => {
    if (!name || watched.has(name)) changed();
  });
  fs.watch(files.logs, changed);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 580,
    title: 'Local Device Monitor',
    icon: path.join(__dirname, 'build', 'icon.png'),
    // Dark, like the dashboard's default theme. The window stays hidden until the page is drawn,
    // so someone who picked light mode doesn't see a dark flash first.
    backgroundColor: '#0d0d0d',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // Groups the window with the installed app's shortcuts in the taskbar and Start menu.
  app.setAppUserModelId('dev.laddergoat.localdevicemonitor');
  app.whenReady().then(() => {
    fs.mkdirSync(files.logs, { recursive: true });
    Menu.setApplicationMenu(null);
    createWindow();
    watchDataFiles();
    refreshAddresses();
    setInterval(refreshAddresses, 10 * 60 * 1000);
    // While offline, check every 30 seconds, so the warning goes soon after the internet is back.
    setInterval(() => {
      if (internet === false) checkInternet();
    }, 30 * 1000);
  });
  app.on('window-all-closed', () => app.quit());
}
