<#
.SYNOPSIS
    Draws the app icon: the wifi mark from the dashboard's header, in white on a blue tile.

.DESCRIPTION
    Writes build\icon.ico (every size Windows asks for, 16 to 256 pixels, each drawn at its own
    size so the small ones stay sharp) and build\icon.png (256 pixels, for the window). Run it
    with Windows PowerShell after changing the design; the results are committed.
#>

Add-Type -AssemblyName System.Drawing

$build = Join-Path (Split-Path $PSScriptRoot) 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

function New-IconBitmap([int]$Size) {
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)

    # The tile: a rounded square, slightly lighter at the top.
    $radius = $Size * 0.22
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $tile.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $tile.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF(0, $Size)),
        [System.Drawing.Color]::FromArgb(255, 0x45, 0x91, 0xEB), [System.Drawing.Color]::FromArgb(255, 0x24, 0x6A, 0xC4))
    $g.FillPath($fill, $tile)

    # The mark, from the header's 24-unit SVG: two arcs around (12, 17.1) with radii 10 and 5,
    # each spanning 44.4 degrees either side of straight up, and a dot at their centre. Small
    # sizes draw it larger and bolder, so it still reads at 16 pixels.
    $unit = $Size * $(if ($Size -le 24) { 0.05 } else { 0.042 })
    $cx = $Size / 2
    $cy = $Size / 2 + 5.1 * $unit
    $white = [System.Drawing.Color]::White
    $pen = New-Object System.Drawing.Pen($white, [single]([Math]::Max(1.2, $unit * $(if ($Size -le 24) { 2.8 } else { 2.4 }))))
    $pen.StartCap = 'Round'
    $pen.EndCap = 'Round'
    foreach ($r in 10, 5) {
        $rr = $r * $unit
        $g.DrawArc($pen, [single]($cx - $rr), [single]($cy - $rr), [single]($rr * 2), [single]($rr * 2), [single]225.6, [single]88.8)
    }
    $dot = [Math]::Max(1.0, 1.5 * $unit)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush($white)), [single]($cx - $dot), [single]($cy - $dot), [single]($dot * 2), [single]($dot * 2))

    $g.Dispose()
    $bitmap
}

function ConvertTo-Png([System.Drawing.Bitmap]$Bitmap) {
    $stream = New-Object System.IO.MemoryStream
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    , $stream.ToArray()
}

# An .ico is a small directory followed by the images; PNG images are fine since Windows Vista.
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = foreach ($size in $sizes) { , (ConvertTo-Png (New-IconBitmap $size)) }
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($out)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $edge = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }   # 0 means 256
    $writer.Write([byte]$edge)
    $writer.Write([byte]$edge)
    $writer.Write([byte]0)      # no palette
    $writer.Write([byte]0)
    $writer.Write([uint16]1)    # colour planes
    $writer.Write([uint16]32)   # bits per pixel
    $writer.Write([uint32]$images[$i].Length)
    $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write($image) }
$writer.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $build 'icon.ico'), $out.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path $build 'icon.png'), $images[-1])
Write-Host "Wrote build\icon.ico ($($sizes -join ', ') px) and build\icon.png"
