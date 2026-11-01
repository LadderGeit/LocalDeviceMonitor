<#
.SYNOPSIS
    Lists the devices on the local network that are online right now, as JSON.

.DESCRIPTION
    Sends an ARP request to every address in this PC's /24 subnet at once (the same check the
    watcher uses) and lists the ones that answered, with any hostname Windows can find for
    them and their public IPv6 addresses. Takes about 10 seconds. The dashboard's Devices tab
    runs this.

.PARAMETER AddressesOnly
    Skips the scan and only lists the public IPv6 addresses Windows knows, by MAC address.
    Takes about a second.
#>
param([switch]$AddressesOnly)

[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not ('NetworkScan' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;

public static class NetworkScan
{
    [DllImport("iphlpapi.dll", ExactSpelling = true)]
    private static extern int SendARP(uint destIp, uint srcIp, byte[] macAddr, ref uint macLen);

    // Sends an ARP request to every address at once. Returns the MAC that answered for each, or null.
    public static string[] Arp(string[] ips)
    {
        string[] macs = new string[ips.Length];
        RunAll(ips.Length, Timeout.Infinite, delegate (int i)
        {
            byte[] mac = new byte[6];
            uint len = 6;
            uint dest = BitConverter.ToUInt32(IPAddress.Parse(ips[i]).GetAddressBytes(), 0);
            if (SendARP(dest, 0, mac, ref len) == 0 && len == 6) macs[i] = BitConverter.ToString(mac);
        });
        return macs;
    }

    // Reverse-looks-up every address at once. Lookups still running after timeoutMs stay null.
    public static string[] Names(string[] ips, int timeoutMs)
    {
        string[] names = new string[ips.Length];
        RunAll(ips.Length, timeoutMs, delegate (int i)
        {
            try
            {
                string name = Dns.GetHostEntry(ips[i]).HostName;
                if (name != ips[i]) names[i] = name.Split('.')[0];
            }
            catch (Exception) { }
        });
        return names;
    }

    private static void RunAll(int count, int timeoutMs, Action<int> work)
    {
        Thread[] threads = new Thread[count];
        for (int i = 0; i < count; i++)
        {
            int n = i;
            threads[n] = new Thread(delegate () { work(n); });
            threads[n].IsBackground = true;
            threads[n].Start();
        }
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(timeoutMs, 0));
        foreach (Thread thread in threads)
        {
            if (timeoutMs == Timeout.Infinite) { thread.Join(); continue; }
            TimeSpan left = deadline - DateTime.UtcNow;
            if (left > TimeSpan.Zero) thread.Join(left);
        }
    }
}
'@
}

# The adapter that connects this PC to the network: the one with a default gateway.
$net = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
if (-not $net) {
    '[]'
    exit
}

# Public IPv6 addresses (2000::/3) by MAC: this PC's own, stable one first, and its neighbours'
# as far as Windows has seen them. Unlike IPv4, where the whole network shares the modem's one
# public address, each device has its own.
function Get-PublicIPv6 {
    $byMac = @{}
    $own = Get-NetIPAddress -AddressFamily IPv6 -InterfaceIndex $net.InterfaceIndex -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^[23]' } | Sort-Object { $_.SuffixOrigin -eq 'Random' }
    $byMac[$net.NetAdapter.MacAddress] = @($own | ForEach-Object { $_.IPAddress })
    foreach ($neighbor in Get-NetNeighbor -AddressFamily IPv6 -InterfaceIndex $net.InterfaceIndex -ErrorAction SilentlyContinue) {
        $mac = $neighbor.LinkLayerAddress
        if ($neighbor.IPAddress -notmatch '^[23]' -or -not $mac -or $mac -eq '00-00-00-00-00-00') { continue }
        $byMac[$mac] = @(@($byMac[$mac]) + $neighbor.IPAddress | Where-Object { $_ } | Select-Object -Unique)
    }
    $byMac
}

if ($AddressesOnly) {
    ConvertTo-Json -InputObject (Get-PublicIPv6) -Compress
    exit
}

$selfIp = @($net.IPv4Address)[0].IPAddress
$gatewayIp = @($net.IPv4DefaultGateway)[0].NextHop
$prefix = $selfIp -replace '\d+$', ''

$ips = [string[]](1..254 | ForEach-Object { "$prefix$_" })
$macs = [NetworkScan]::Arp($ips)
$found = @(for ($i = 0; $i -lt $ips.Length; $i++) {
    if ($macs[$i] -and $macs[$i] -ne '00-00-00-00-00-00') { [pscustomobject]@{ ip = $ips[$i]; mac = $macs[$i] } }
})
if ($found.ip -notcontains $selfIp) { $found += [pscustomobject]@{ ip = $selfIp; mac = $net.NetAdapter.MacAddress } }

$names = [NetworkScan]::Names([string[]]$found.ip, 6000)
# Windows' NetBIOS name cache often knows names that reverse lookups don't find.
$cached = @{}
foreach ($line in nbtstat -c | Select-String '^\s*(\S+)\s+<20>\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\s') {
    $cached[$line.Matches[0].Groups[2].Value] = $line.Matches[0].Groups[1].Value
}

$ipv6 = Get-PublicIPv6
$devices = for ($i = 0; $i -lt $found.Count; $i++) {
    $ip = $found[$i].ip
    $mac = $found[$i].mac
    # Assigned first so a single address stays a list in the JSON.
    $public = @()
    if ($ipv6.ContainsKey($mac)) { $public = @($ipv6[$mac]) }
    [ordered]@{
        ip = $ip
        mac = $mac
        hostname = if ($ip -eq $selfIp) { $env:COMPUTERNAME } elseif ($cached[$ip]) { $cached[$ip] } else { $names[$i] }
        isSelf = $ip -eq $selfIp
        isGateway = $ip -eq $gatewayIp
        ipv6 = $public
    }
}
ConvertTo-Json -InputObject @($devices) -Compress
