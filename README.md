# Local Device Monitor

See when the devices on your home network come and go. Pick a PC, phone, console or anything
else on your network, and Local Device Monitor tells you when it comes online, logs how long it
stays, and shows the history in a dashboard.

Windows 10 and 11.

## What it does

- **Watches any number of devices**, checking each one every 5 minutes. It asks the device for
  its address the way your network itself does (an ARP request), so it also sees devices that
  ignore ping, such as PCs with their firewall on.
- **Notifies you** when a watched device comes online.
- **Keeps a log per device**: when it came online, went offline, changed IP address, and how
  long each stretch lasted.
- **Dashboard** with a summary of every device, a 7-day timeline, the full log and a network
  scan that lists every device online right now, so you can pick what to watch and give it a
  name.
- **Follows devices that get a new IP address**, by their MAC address.
- **Stays out of the way**: the watcher runs hidden in the background with a tray icon, starts at
  login, and stops on its own when you're not watching anything.

## Privacy and the internet

Watching devices only uses your local network. The app makes two kinds of requests to the
internet, and needs neither to watch:

- **Manufacturer names** are looked up on [macvendors.com](https://macvendors.com), sending only
  the first half of a MAC address: the part that identifies the manufacturer, not the device.
  Each manufacturer is looked up once and remembered.
- **Your public IP address** is read from Cloudflare (`1.1.1.1/cdn-cgi/trace`), which sees it on
  any request anyway, for the Devices tab.

Without an internet connection everything keeps working; the dashboard says so, and fills in the
missing names once you're back online. Nothing else leaves your PC: your devices, names and logs
stay in the data folder below.

## Installing

Download `LocalDeviceMonitor-<version>_setup.msi` from the releases and run it. It installs for
your Windows user only, without an admin prompt, into `%LOCALAPPDATA%\Local Device Monitor`, and
adds Start menu and desktop shortcuts and a login entry for the watcher.

The app isn't code-signed, so Windows warns about it: click **More info**, then **Run anyway**.
With **Smart App Control** turned on, Windows blocks unsigned apps outright and there's no way
past that warning; you can run the app from source instead (below).

Uninstalling keeps your devices and logs; delete
`%LOCALAPPDATA%\Local Device Monitor\Data` to remove them too.

## Running from source

You need [Node.js](https://nodejs.org) 22 or newer. Windows PowerShell 5.1, which the watcher
runs on, comes with Windows.

```
cd dashboard
npm install
npm start
```

Run from source, the app keeps its data next to the scripts, in this folder (the `.gitignore`
keeps it out of the repository).

## Building the installer

You need the [WiX Toolset 3.x](https://github.com/wixtoolset/wix3/releases), with its `bin`
folder on `PATH` or `%WIX%` set. Then, in `dashboard`:

```
npm run pack    # dist\win-unpacked: the app, ready to run
npm run dist    # and dist\LocalDeviceMonitor-<version>_setup.msi
```

The version is the one in `dashboard\package.json`. Raise it for every build you hand out: an
installer only replaces an older version. `UPGRADE_CODE` in `dashboard\scripts\msi.js` must never
change, or new versions install beside old ones instead of replacing them.

## How it fits together

| Part | What it is |
|---|---|
| `Watch-Device.ps1` | The watcher: checks the watched devices, writes their logs and the current status, shows notifications and the tray icon. |
| `Scan-Network.ps1` | Lists every device online on your network, for the Devices tab. |
| `dashboard/` | The Electron app: summary, log and device scan. Plain HTML, CSS and JavaScript. |
| `dashboard/scripts/` | Building the app and installer, and drawing the icon. |

The two halves share a data folder (`%LOCALAPPDATA%\Local Device Monitor\Data` when installed):

| File | Contents |
|---|---|
| `device-config.json` | Your devices: their MAC address, last IP address, name, and whether they're watched. The dashboard writes it. |
| `logs\<MAC>.txt` | A device's log, one line per event. |
| `logs\<MAC>.jsonl` | The same events as JSON, which the dashboard reads. |
| `watcher-status.json` | The watcher's current state, updated after every check. |
| `vendor-cache.json` | Manufacturer names already looked up. |

The dashboard asks the running watcher to pick up changes or to stop through two Windows events,
`Local\LocalDeviceMonitor-Reload` and `Local\LocalDeviceMonitor-Stop`.

## License

[MIT](LICENSE). The installer also contains Electron and Chromium, under their own licenses,
which come with it in the install folder.
