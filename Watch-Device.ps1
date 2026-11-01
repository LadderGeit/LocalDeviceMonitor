<#
.SYNOPSIS
    The background half of Local Device Monitor: watches devices on your network, logs when they
    come and go, and shows a Windows notification whenever one comes online.

.DESCRIPTION
    Every few minutes the script sends each device an ARP request: the "who has this IP?"
    question that every device on the local network has to answer, even ones that block ping.
    If a device's IP address changes (DHCP), the script scans the subnet to find it again by
    its MAC address.

    The devices to watch, and any names you gave them, come from device-config.json, which the
    dashboard's Devices tab writes. When no device is left to watch, the watcher stops; the
    dashboard starts it again when you watch one.

    A device without a name is named after its hostname when it reports one, otherwise after its
    manufacturer. The manufacturer is looked up from the first half of the MAC address (only
    that part is sent, to api.macvendors.com).

    Next to the config it writes:
      logs\<MAC>.txt        each device's log, one line per event
      logs\<MAC>.jsonl      the same events as JSON, for the dashboard
      watcher-status.json   the current state, updated after every check

    Right-click the tray icon to open the dashboard or the logs folder, or to stop watching.

.EXAMPLE
    .\Watch-Device.ps1

.EXAMPLE
    .\Watch-Device.ps1 -NotifyOffline
#>
param(
    [int]$IntervalSeconds = 300,
    # Failed checks in a row before a device counts as offline, so a single missed answer
    # (from a device in power-saving mode, say) doesn't log a false offline/online pair.
    [int]$MissesBeforeOffline = 2,
    # Where the config, logs and status go. Defaults to this script's folder; the installed app
    # passes its own data folder, as the program's folder is no place for them.
    [string]$DataFolder,
    [switch]$NotifyOffline
)

if (-not $DataFolder) { $DataFolder = $PSScriptRoot }
New-Item -ItemType Directory -Force -Path $DataFolder | Out-Null
$DataFolder = (Resolve-Path -LiteralPath $DataFolder).Path
$configPath = Join-Path $DataFolder 'device-config.json'
$statusPath = Join-Path $DataFolder 'watcher-status.json'
$vendorCachePath = Join-Path $DataFolder 'vendor-cache.json'
$logFolder = Join-Path $DataFolder 'logs'
New-Item -ItemType Directory -Force -Path $logFolder | Out-Null

# Installed, this script sits in the app's resources folder, next to the icon and one folder
# below the app itself. In a checkout, the dashboard runs on Electron from its node_modules.
$installedApp = Join-Path (Split-Path $PSScriptRoot) 'Local Device Monitor.exe'
$dashboardDir = Join-Path $PSScriptRoot 'dashboard'
$dashboardExe = Join-Path $dashboardDir 'node_modules\electron\dist\electron.exe'
$iconPath = @((Join-Path $PSScriptRoot 'icon.ico'), (Join-Path $dashboardDir 'build\icon.ico')) |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('LocalDeviceMonitor.Arp' -as [type])) {
    Add-Type -Namespace LocalDeviceMonitor -Name Arp -MemberDefinition @'
[DllImport("iphlpapi.dll", ExactSpelling = true)]
public static extern int SendARP(uint destIp, uint srcIp, byte[] macAddr, ref uint macLen);
'@
}

$script:devices = [ordered]@{}   # MAC -> state of each watched device
$script:known = @{}              # MAC -> state from the previous run, to pick up where it left off
$script:lastScan = [datetime]::MinValue
$script:quit = $false
$startedAt = Get-Date
$connected = $true

# Only one watcher at a time, so starting it twice doesn't write every event twice.
$mutex = New-Object System.Threading.Mutex($false, 'Local\LocalDeviceMonitor')
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Write-Host 'Local Device Monitor is already running.'
    exit
}
# The dashboard sets these to ask the watcher to stop, or to reload device-config.json.
$stopSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Local\LocalDeviceMonitor-Stop')
$reloadSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Local\LocalDeviceMonitor-Reload')

function ConvertTo-IsoTime([datetime]$Time) {
    $Time.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [cultureinfo]::InvariantCulture)
}

# Reads a time back from a JSON file. PowerShell 7 has already turned it into a date; 5.1 hasn't.
function ConvertFrom-IsoTime($Value) {
    if (-not $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToLocalTime() }
    [DateTimeOffset]::Parse($Value, [cultureinfo]::InvariantCulture).LocalDateTime
}

# Accepts any MAC notation (d8:bb:c1..., d8-bb-c1..., d8bbc1...) and returns Windows' format.
function ConvertTo-Mac([string]$Value) {
    (($Value -replace '[^0-9A-Fa-f]', '').ToUpper() -split '(..)' -ne '') -join '-'
}

function New-DeviceState([string]$Mac, [string]$Ip, [string]$Name) {
    @{
        mac = $Mac; ip = $Ip; customName = $Name; vendor = $null; hostname = $null
        displayName = 'Unknown device'; logName = 'Unknown device'
        online = $false; since = (Get-Date); exact = $false; lastSeen = $null; misses = 0
        lastNameLookup = [datetime]::MinValue; nameTask = $null
    }
}

# Writes an event to the device's log, to its event file for the dashboard and to the console.
function Write-Log([hashtable]$Device, [string]$Tag, [string]$Message, [hashtable]$Data = @{}, [datetime]$Time = (Get-Date)) {
    $line = '{0}  {1,-8} {2}  {3}  {4}' -f $Time.ToString('yyyy-MM-dd HH:mm', [cultureinfo]::InvariantCulture), $Tag, $Device.mac, $Device.logName, $Message
    Write-Host $line
    $entry = [ordered]@{
        time = ConvertTo-IsoTime $Time; type = $Tag; mac = $Device.mac; name = $Device.displayName
        vendor = $Device.vendor; hostname = $Device.hostname; ip = $Device.ip; message = $Message
    }
    foreach ($key in $Data.Keys) { $entry[$key] = $Data[$key] }
    $base = Join-Path $logFolder $Device.mac
    try {
        [IO.File]::AppendAllText("$base.txt", "$line`r`n")
        [IO.File]::AppendAllText("$base.jsonl", (ConvertTo-Json $entry -Compress) + "`n")
    } catch {
        Write-Host "Couldn't write to the log: $($_.Exception.Message)"
    }
}

# The dashboard reads this for the current state. It's written to a temp file first, so the
# dashboard never reads it half-written.
function Save-Status([switch]$Stopped) {
    $status = [ordered]@{
        watcherPid = $PID; watcherStarted = ConvertTo-IsoTime $startedAt; stopped = [bool]$Stopped
        lastCheck = ConvertTo-IsoTime (Get-Date); connected = $connected; intervalSeconds = $IntervalSeconds
        devices = @(foreach ($device in $script:devices.Values) {
            [ordered]@{
                mac = $device.mac; name = $device.displayName; hostname = $device.hostname; vendor = $device.vendor
                ip = $device.ip; online = $device.online; since = ConvertTo-IsoTime $device.since; exact = $device.exact
                lastSeen = if ($device.lastSeen) { ConvertTo-IsoTime $device.lastSeen } else { $null }
            }
        })
    }
    try {
        [IO.File]::WriteAllText("$statusPath.tmp", (ConvertTo-Json $status -Depth 5))
        Move-Item -LiteralPath "$statusPath.tmp" -Destination $statusPath -Force
    } catch {
        Write-Host "Couldn't save the status: $($_.Exception.Message)"
    }
}

function Format-Duration([timespan]$Span) {
    if ($Span.TotalMinutes -lt 1) { return 'less than a minute' }
    $parts = @()
    if ($Span.Days) { $parts += "$($Span.Days)d" }
    if ($Span.Hours) { $parts += "$($Span.Hours)h" }
    if ($Span.Minutes) { $parts += "$($Span.Minutes)m" }
    $parts -join ' '
}

# Describes how long an online/offline stretch lasted. When it began before the watcher
# started, the real start is unknown, so it's reported as "at least".
function Format-Stretch([timespan]$Span, [bool]$Exact) {
    if ($Exact) { Format-Duration $Span }
    elseif ($Span.TotalMinutes -ge 1) { "at least $(Format-Duration $Span)" }
    else { 'an unknown time' }
}

function Get-Stretch([hashtable]$Device, [datetime]$Until) { Format-Stretch ($Until - $Device.since) $Device.exact }

function Write-Stop([hashtable]$Device, [string]$Reason, [datetime]$Time) {
    $span = if ($Device.online) { $Device.lastSeen - $Device.since } else { $Time - $Device.since }
    $state = if ($Device.online) { 'online' } else { 'offline' }
    $data = @{ online = [bool]$Device.online; seconds = [int]$span.TotalSeconds; exact = [bool]$Device.exact }
    if ($Device.online) { $data.lastSeen = ConvertTo-IsoTime $Device.lastSeen }
    Write-Log $Device 'STOP' "$Reason, had been $state for $(Format-Stretch $span $Device.exact)" $data -Time $Time
}

# Sends an ARP request to $Ip and returns the MAC address that answered, or $null.
function Get-ArpMac([string]$Ip) {
    $dest = [BitConverter]::ToUInt32([Net.IPAddress]::Parse($Ip).GetAddressBytes(), 0)
    $buf = New-Object byte[] 6
    $len = [uint32]6
    if ([LocalDeviceMonitor.Arp]::SendARP($dest, 0, $buf, [ref]$len) -ne 0) { return $null }
    ($buf | ForEach-Object { $_.ToString('X2') }) -join '-'
}

# True when this PC is connected to a network. Checks are skipped otherwise, so a network
# hiccup or a slow login isn't logged as every device leaving.
function Test-OnNetwork {
    [bool](Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' })
}

# Pings every address in the /24 subnet so Windows' ARP table learns who is where.
function Invoke-SubnetScan([string]$Ip) {
    $prefix = $Ip -replace '\.\d+$', ''
    $tasks = foreach ($i in 1..254) { (New-Object Net.NetworkInformation.Ping).SendPingAsync("$prefix.$i", 1000) }
    try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$tasks) } catch { }
}

function Test-Device([hashtable]$Device) {
    if ((Get-ArpMac $Device.ip) -eq $Device.mac) { return $true }

    # Not at its usual address. Maybe DHCP gave it a new one, so look for the MAC elsewhere,
    # scanning at most every 5 minutes (for all devices together) to keep network traffic low.
    if ((Get-Date) - $script:lastScan -gt [timespan]::FromMinutes(5)) {
        $script:lastScan = Get-Date
        Invoke-SubnetScan $Device.ip
    }
    foreach ($entry in Get-NetNeighbor -AddressFamily IPv4 -LinkLayerAddress $Device.mac -ErrorAction SilentlyContinue) {
        if ($entry.IPAddress -ne $Device.ip -and (Get-ArpMac $entry.IPAddress) -eq $Device.mac) {
            $Device.ip = $entry.IPAddress
            return $true
        }
    }
    $false
}

# The manufacturer, from vendor-cache.json (which the dashboard fills) or else looked up from
# the first half of the MAC address. Returns $null when it's unknown or the lookup fails (no
# internet, say), so it's tried again later. Phones' private (made-up) addresses have none.
function Get-Vendor([string]$Mac) {
    if ([Convert]::ToInt32($Mac.Substring(0, 2), 16) -band 2) { return $null }
    $prefix = $Mac.Substring(0, 8)
    try {
        $cached = (Get-Content -LiteralPath $vendorCachePath -Raw -ErrorAction Stop | ConvertFrom-Json).$prefix
        if ($cached -is [string]) {
            if ($cached) { return $cached }
            return $null
        }
    } catch { }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        [string](Invoke-RestMethod "https://api.macvendors.com/$prefix" -TimeoutSec 10)
    } catch { $null }
}

# The device's own name, if Windows' NetBIOS name cache has it (filled whenever the name is
# used on the network).
function Get-CachedHostname([string]$Ip) {
    $cached = nbtstat -c | Select-String "^\s*(\S+)\s+<20>\s+\S+\s+$([regex]::Escape($Ip))\s" | Select-Object -First 1
    if ($cached) { return $cached.Matches[0].Groups[1].Value }
    # A real $null: returning nothing would be saved to the status file as {} by Windows PowerShell.
    $null
}

function Update-Identity([hashtable]$Device) {
    if (-not $Device.vendor) { $Device.vendor = Get-Vendor $Device.mac }
    # "Micro-Star INTL CO., LTD." reads better as "Micro-Star INTL".
    $maker = if ($Device.vendor) { $Device.vendor -replace '(?i)[\s,]+(co\.?,?\s*)?(ltd|inc|corp|corporation|gmbh|llc|limited|plc)\.?\s*$', '' } else { $null }
    $Device.displayName = if ($Device.customName) { $Device.customName } elseif ($Device.hostname) { $Device.hostname } elseif ($maker) { $maker } else { 'Unknown device' }
    # The log shows the manufacturer as well, unless it's already the name.
    $Device.logName = if ($maker -and $maker -ne $Device.displayName) { "$($Device.displayName) ($maker)" } else { $Device.displayName }
}

# The devices to watch from device-config.json, as MAC -> @{ ip; name }, or $null when the file
# can't be read, so a bad read never stops every device.
function Read-Config {
    try { $config = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
    $watched = [ordered]@{}
    foreach ($entry in @($config.devices)) {
        if (-not $entry.watch -or -not $entry.mac -or -not $entry.ip) { continue }
        $watched[(ConvertTo-Mac $entry.mac)] = @{ ip = [string]$entry.ip; name = [string]$entry.name }
    }
    $watched
}

function Start-Watching([hashtable]$Device) {
    Update-Identity $Device
    $Device.online = Test-Device $Device
    $Device.since = Get-Date
    $Device.exact = $false
    $Device.misses = 0
    if ($Device.online) {
        $Device.lastSeen = $Device.since
        Write-Log $Device 'START' "device is online at $($Device.ip)" @{ online = $true }
    } else {
        Write-Log $Device 'START' 'device is offline' @{ online = $false }
    }
}

# Brings the watched devices in line with device-config.json: starts watching new ones, stops
# watching removed ones and picks up new names.
function Sync-Devices {
    $wanted = Read-Config
    if ($null -eq $wanted) { return }
    foreach ($mac in @($script:devices.Keys)) {
        if (-not $wanted.Contains($mac)) {
            Write-Stop $script:devices[$mac] 'stopped watching' (Get-Date)
            $script:devices.Remove($mac)
        }
    }
    foreach ($mac in @($wanted.Keys)) {
        $device = $script:devices[$mac]
        if ($device) {
            if ($device.customName -ne $wanted[$mac].name) {
                $device.customName = $wanted[$mac].name
                Update-Identity $device
            }
            continue
        }
        $device = New-DeviceState $mac $wanted[$mac].ip $wanted[$mac].name
        $previous = $script:known[$mac]
        if ($previous) {
            if ($previous.ip) { $device.ip = $previous.ip }
            $device.vendor = $previous.vendor
            $device.hostname = $previous.hostname
            $device.lastSeen = $previous.lastSeen
        }
        $script:devices[$mac] = $device
        Start-Watching $device
    }
}

function Update-Device([hashtable]$Device) {
    $oldIp = $Device.ip
    if (Test-Device $Device) {
        $now = Get-Date
        $Device.misses = 0
        if (-not $Device.online) {
            Update-Identity $Device
            $Device.lastNameLookup = [datetime]::MinValue
            Write-Log $Device 'ONLINE' "came online at $($Device.ip) after $(Get-Stretch $Device $now) offline" @{
                seconds = [int]($now - $Device.since).TotalSeconds; exact = $Device.exact
            }
            Show-Notification "$($Device.displayName) is online" "Came online at $(Get-Date -Format t) ($($Device.ip))"
            $Device.online = $true
            $Device.since = $now
            $Device.exact = $true
        } elseif ($Device.ip -ne $oldIp) {
            Write-Log $Device 'MOVED' "moved from $oldIp to $($Device.ip)" @{ previousIp = $oldIp }
        }
        $Device.lastSeen = $now
    } elseif ($Device.online) {
        $Device.misses++
        if ($Device.misses -ge $MissesBeforeOffline) {
            Write-Log $Device 'OFFLINE' "last seen at $($Device.lastSeen.ToString('HH:mm')), after $(Get-Stretch $Device $Device.lastSeen) online" @{
                lastSeen = ConvertTo-IsoTime $Device.lastSeen; seconds = [int]($Device.lastSeen - $Device.since).TotalSeconds; exact = $Device.exact
            }
            if ($NotifyOffline) {
                Show-Notification "$($Device.displayName) is offline" "Last seen at $($Device.lastSeen.ToString('t'))"
            }
            $Device.online = $false
            $Device.since = $Device.lastSeen
            $Device.exact = $true
        }
    }
}

# Finds the hostname of online devices that haven't given one yet: first in the NetBIOS cache,
# then by a reverse lookup over DNS, NetBIOS or LLMNR. That lookup runs in the background, as it
# can take 10 seconds or more to fail, and Wait-Until returns 'names' when one finishes. Each
# device is tried at most every 30 minutes until it gives its name once; it's remembered after
# that. Some devices answer only now and then; many never do. Returns $true when it found a name.
function Update-Hostnames {
    $found = $false
    foreach ($device in @($script:devices.Values)) {
        $task = $device.nameTask
        if ($task -and $task.IsCompleted) {
            $device.nameTask = $null
            $name = if ($task.Status -eq 'RanToCompletion') { $task.Result.HostName } else { $null }
            if ($name -and $name -ne $device.ip -and -not $device.hostname) {
                $device.hostname = $name.Split('.')[0]
                Update-Identity $device
                $found = $true
            }
        }
        if ($device.hostname -or $device.nameTask -or -not $device.online) { continue }
        if ((Get-Date) - $device.lastNameLookup -lt [timespan]::FromMinutes(30)) { continue }
        $device.lastNameLookup = Get-Date
        $cached = Get-CachedHostname $device.ip
        if ($cached) {
            $device.hostname = $cached
            Update-Identity $device
            $found = $true
        } else {
            $device.nameTask = [Net.Dns]::GetHostEntryAsync($device.ip)
        }
    }
    $found
}

# Waits until $Time while keeping the tray icon's menu responsive. Returns early with 'stop' or
# 'reload' when the dashboard or the tray menu asks for that, or 'names' when a hostname lookup
# finishes; otherwise 'time'.
function Wait-Until([datetime]$Time) {
    $signals = [System.Threading.WaitHandle[]]@($stopSignal, $reloadSignal)
    while ((Get-Date) -lt $Time) {
        if ($script:quit) { return 'stop' }
        [System.Windows.Forms.Application]::DoEvents()
        foreach ($device in $script:devices.Values) {
            if ($device.nameTask -and $device.nameTask.IsCompleted) { return 'names' }
        }
        switch ([System.Threading.WaitHandle]::WaitAny($signals, 200)) {
            0 { return 'stop' }
            1 { return 'reload' }
        }
    }
    if ($script:quit) { 'stop' } else { 'time' }
}

function Open-Dashboard {
    if (Test-Path -LiteralPath $installedApp) { Start-Process $installedApp }
    elseif (Test-Path -LiteralPath $dashboardExe) { Start-Process $dashboardExe -ArgumentList "`"$dashboardDir`"" }
    else { Start-Process $logFolder }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = if ($iconPath) { New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize) }
    else { [System.Drawing.SystemIcons]::Information }
$tray.Text = 'Local Device Monitor: starting'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Open dashboard', $null, { Open-Dashboard })
[void]$menu.Items.Add('Open logs folder', $null, { Start-Process $logFolder })
[void]$menu.Items.Add('Stop watching', $null, { $script:quit = $true })
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Open-Dashboard })
$tray.Visible = $true

function Update-Tray {
    $all = @($script:devices.Values)
    $text = if (-not $all.Count) { 'Local Device Monitor: no devices to watch' }
        elseif ($all.Count -eq 1) { "$($all[0].displayName): $(if ($all[0].online) { 'online' } else { 'offline' })" }
        else { "Local Device Monitor: $(@($all | Where-Object { $_.online }).Count) of $($all.Count) online" }
    $tray.Text = $text.Substring(0, [Math]::Min($text.Length, 63))
}

function Show-Notification([string]$Title, [string]$Message) {
    $tray.ShowBalloonTip(10000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)
}

# Pick up where the previous run left off: each device's last address, names and state.
$previous = $null
try { $previous = Get-Content -LiteralPath $statusPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
foreach ($entry in @($previous.devices)) {
    if (-not $entry.mac) { continue }
    $state = New-DeviceState $entry.mac $entry.ip $null
    # An earlier version could save names as {} instead of null, so take only real ones.
    if ($entry.vendor -is [string]) { $state.vendor = $entry.vendor }
    if ($entry.hostname -is [string]) { $state.hostname = $entry.hostname }
    $state.online = [bool]$entry.online
    $state.since = ConvertFrom-IsoTime $entry.since
    $state.exact = [bool]$entry.exact
    $state.lastSeen = ConvertFrom-IsoTime $entry.lastSeen
    $script:known[$entry.mac] = $state
}

$watching = $false
try {
    while (-not (Test-OnNetwork)) {
        if ((Wait-Until (Get-Date).AddSeconds(10)) -eq 'stop') { return }
    }

    # The previous run ended without logging a STOP (the PC was shut down, say), so log one for
    # each of its devices now, dated to its last check.
    if ($previous -and -not $previous.stopped -and $previous.lastCheck) {
        $names = Read-Config
        foreach ($state in $script:known.Values) {
            if ($names -and $names.Contains($state.mac)) { $state.customName = $names[$state.mac].name }
            Update-Identity $state
            Write-Stop $state 'watcher ended unexpectedly (shutdown, logoff or crash)' (ConvertFrom-IsoTime $previous.lastCheck)
        }
    }

    $watching = $true
    Sync-Devices
    if (-not $script:devices.Count) {
        Write-Host 'No devices to watch, so the watcher stops. Watch one in the dashboard to start it again.'
        return
    }
    Update-Tray
    Save-Status
    if (Update-Hostnames) { Update-Tray; Save-Status }

    $nextCheck = (Get-Date).AddSeconds($IntervalSeconds)
    while ($true) {
        $signal = Wait-Until $nextCheck
        if ($signal -eq 'stop') { break }
        if ($signal -eq 'names') {
            if (Update-Hostnames) { Update-Tray; Save-Status }
            continue
        }
        if ($signal -eq 'reload') {
            Sync-Devices
        } else {
            $nextCheck = (Get-Date).AddSeconds($IntervalSeconds)
            $connected = Test-OnNetwork
            if ($connected) {
                Sync-Devices
                foreach ($device in @($script:devices.Values)) { Update-Device $device }
            }
        }
        # The last device was switched off, so there's nothing left to do.
        if (-not $script:devices.Count) {
            Write-Host 'No devices left to watch, so the watcher stops.'
            break
        }
        Update-Tray
        Save-Status
        if (Update-Hostnames) { Update-Tray; Save-Status }
    }
} finally {
    if ($watching) {
        foreach ($device in @($script:devices.Values)) { Write-Stop $device 'stopped watching' (Get-Date) }
        Save-Status -Stopped
    }
    $tray.Dispose()
    $stopSignal.Dispose()
    $reloadSignal.Dispose()
    $mutex.ReleaseMutex()
}
