# Generate PNG app icons at several sizes.
#
# Usage (the file is BOM-less, so run it with -ExecutionPolicy Bypass):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1 -Dir <output dir>
#
# Why PNG: a .lnk IconLocation accepts .ico/.png/.exe/.dll. When an .ico renders blank in
# Explorer, PNG is an independent display path that separates "bad icon data" from
# "stale Windows icon cache".
#
# This file MUST stay pure ASCII: Windows PowerShell 5.1 decodes a UTF-8 file without a BOM
# as ANSI, which corrupts non-ASCII text and breaks parsing of the param block.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$BaseName = 'dsh-flat'
)

Add-Type -AssemblyName System.Drawing

$sizes = @(256, 128, 64, 48, 32, 16)
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $blue = [System.Drawing.Color]::FromArgb(255, 77, 107, 254)
  $white = [System.Drawing.Color]::White
  $s = $size / 64.0

  # Rounded square base plate.
  $radius = [Math]::Max(2, 14 * $s)
  $d = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush($blue)), $path)

  # White whale silhouette.
  $pts = @(
    (New-Object System.Drawing.PointF((13 * $s), (30 * $s))),
    (New-Object System.Drawing.PointF((20 * $s), (22 * $s))),
    (New-Object System.Drawing.PointF((28 * $s), (19 * $s))),
    (New-Object System.Drawing.PointF((38 * $s), (20 * $s))),
    (New-Object System.Drawing.PointF((45 * $s), (25 * $s))),
    (New-Object System.Drawing.PointF((50 * $s), (20 * $s))),
    (New-Object System.Drawing.PointF((49 * $s), (29 * $s))),
    (New-Object System.Drawing.PointF((46 * $s), (36 * $s))),
    (New-Object System.Drawing.PointF((38 * $s), (42 * $s))),
    (New-Object System.Drawing.PointF((28 * $s), (43 * $s))),
    (New-Object System.Drawing.PointF((19 * $s), (38 * $s))),
    (New-Object System.Drawing.PointF((13 * $s), (30 * $s)))
  )
  $g.FillPolygon((New-Object System.Drawing.SolidBrush($white)), $pts)

  # Eye.
  $eye = [Math]::Max(1, 4 * $s)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush($blue)), (31 * $s), (26 * $s), $eye, $eye)

  # Spout.
  $g.FillRectangle((New-Object System.Drawing.SolidBrush($white)),
    (24 * $s), (8 * $s), [Math]::Max(1, 3 * $s), (9 * $s))
  $drop = [Math]::Max(1, 7 * $s)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush($white)), (22 * $s), (4 * $s), $drop, $drop)

  $out = Join-Path $Dir ($BaseName + '-' + $size + '.png')
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host ("  wrote " + $out + "  (" + (Get-Item $out).Length + " bytes)")
}
Write-Host "done"
