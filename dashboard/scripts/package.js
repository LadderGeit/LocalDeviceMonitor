// Builds the app people install: the Electron dashboard with the watcher's scripts inside it
// and, asked for, the Windows installer.
//
//   node scripts/package.js                 dist/win-unpacked - runs as it is
//   node scripts/package.js msi             and dist/LocalDeviceMonitor-<version>_setup.msi
//   node scripts/package.js msi --out <f>   the installer written to <f> instead
//
// The version is package.json's, so the app and its installer always carry the same number.
// Raise it for every build you hand out: an installer only replaces an older version.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildMsi, NAME, EXE } = require('./msi');

const dashboard = path.resolve(__dirname, '..');
const dist = path.join(dashboard, 'dist');
const unpacked = path.join(dist, 'win-unpacked');
const { version } = require('../package.json');

const args = process.argv.slice(2);
const wantMsi = args.includes('msi');
const outAt = args.indexOf('--out');
const out = outAt >= 0 && args[outAt + 1] ? path.resolve(args[outAt + 1]) : path.join(dist, `LocalDeviceMonitor-${version}_setup.msi`);

// From clean: files left from an older build would otherwise end up inside the installer too.
fs.rmSync(dist, { recursive: true, force: true });
console.log(`Packing ${NAME} ${version}…`);
execFileSync(process.execPath, ['--experimental-require-module',
  path.join(dashboard, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'dir'], { cwd: dashboard, stdio: 'inherit' });
if (!fs.existsSync(path.join(unpacked, EXE))) throw new Error(`electron-builder did not produce ${path.join(unpacked, EXE)}`);
console.log(`${NAME} is in ${unpacked}`);

if (wantMsi) {
  console.log('Building the installer…');
  const r = buildMsi({
    source: unpacked,
    version,
    icon: path.join(dashboard, 'build', 'icon.ico'),
    out,
    work: path.join(dist, 'msi'),
  });
  const mb = (fs.statSync(r.out).size / 1048576).toFixed(0);
  console.log(`Installer ready: ${r.out} (${mb} MB, ${r.files} files)`);
}
