param(
  [Parameter(Mandatory = $true)]
  [string] $SourceIcon,

  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $SourceIcon -PathType Leaf)) {
  throw "Store app source icon was not found: $SourceIcon"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$source = [System.Drawing.Image]::FromFile($SourceIcon)
try {
  $assets = @(
    @{ Name = "StoreLogo.png"; Width = 50; Height = 50 },
    @{ Name = "Square44x44Logo.png"; Width = 44; Height = 44 },
    @{ Name = "Square150x150Logo.png"; Width = 150; Height = 150 },
    @{ Name = "Wide310x150Logo.png"; Width = 310; Height = 150 }
  )

  foreach ($asset in $assets) {
    $bitmap = [System.Drawing.Bitmap]::new($asset.Width, $asset.Height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $scale = [Math]::Min($asset.Width / $source.Width, $asset.Height / $source.Height)
        $width = [int][Math]::Round($source.Width * $scale)
        $height = [int][Math]::Round($source.Height * $scale)
        $x = [int][Math]::Floor(($asset.Width - $width) / 2)
        $y = [int][Math]::Floor(($asset.Height - $height) / 2)
        $graphics.DrawImage($source, $x, $y, $width, $height)
      }
      finally {
        $graphics.Dispose()
      }

      $destination = Join-Path $OutputDirectory $asset.Name
      $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host "Generated $destination ($($asset.Width)x$($asset.Height))"
    }
    finally {
      $bitmap.Dispose()
    }
  }
}
finally {
  $source.Dispose()
}
