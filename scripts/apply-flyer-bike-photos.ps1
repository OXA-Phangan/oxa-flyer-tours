# Run from inside the oxa-poster-tour folder. Only ADDS the flyerBike storage rule + cleanup function; aborts on anything unexpected.
$ErrorActionPreference = "Stop"
$flyer = Join-Path (Split-Path -Parent (Get-Location).Path) "oxa-flyer-tours"
if (-not (Test-Path "$flyer\storage.flyer-block.rules.txt")) { throw "oxa-flyer-tours nicht neben diesem Ordner gefunden" }
if (-not (Test-Path ".\storage.rules") -or -not (Test-Path ".\functions\index.js")) { throw "Bitte im Ordner oxa-poster-tour ausfuehren" }
$enc = New-Object System.Text.UTF8Encoding($false)

# --- storage.rules: nur den flyerBike-Teil anhaengen ---
$sp = (Resolve-Path ".\storage.rules").Path
$s = [System.IO.File]::ReadAllText($sp)
$blk = [System.IO.File]::ReadAllText("$flyer\storage.flyer-block.rules.txt")
$i = $blk.IndexOf("    // Bike rental condition photos")
if ($i -lt 0) { throw "STORAGE: Bike-Block in der Vorlage nicht gefunden - ABBRUCH" }
$bike = $blk.Substring($i).TrimEnd()
if ($s -notmatch "isFlyerAdmin") { throw "STORAGE: Flyer-Block fehlt in storage.rules - ABBRUCH, nichts geaendert" }
if ($s -match "flyerBike") {
  Write-Host "STORAGE: flyerBike ist schon drin - nichts geaendert"
} else {
  $m = [regex]::Match($s, '(\r?\n)  \}\s*\}\s*$')
  if (-not $m.Success) { throw "STORAGE: Dateiende unerwartet - ABBRUCH, nichts geaendert" }
  Copy-Item $sp "$sp.bak"
  $nl = $m.Groups[1].Value
  $new = $s.Substring(0, $m.Index) + $nl + $nl + ($bike -replace "`r?`n", $nl) + $s.Substring($m.Index)
  [System.IO.File]::WriteAllText($sp, $new, $enc)
  Write-Host "STORAGE: flyerBike-Regel eingefuegt"
}

# --- functions/index.js: Funktion anhaengen ---
$fp = (Resolve-Path ".\functions\index.js").Path
$f = [System.IO.File]::ReadAllText($fp)
$snip = [System.IO.File]::ReadAllText("$flyer\cloud-functions.flyer-bike-photo-cleanup.js.txt")
if ($f -match "cleanupExpiredFlyerBikePhotos") {
  Write-Host "FUNCTIONS: schon drin - nichts geaendert"
} else {
  $missing = @("onSchedule","getFirestore","getStorage","flyerDeleteFile","FLYER_HOUR_MS","FLYER_PASSPORT_GRACE_DAYS") | Where-Object { $f -notmatch $_ }
  if ($missing) { throw "FUNCTIONS: fehlende Teile: $missing - ABBRUCH, nichts geaendert" }
  Copy-Item $fp "$fp.bak"
  [System.IO.File]::WriteAllText($fp, $f.TrimEnd() + "`n" + $snip, $enc)
  Write-Host "FUNCTIONS: cleanupExpiredFlyerBikePhotos angehaengt"
}

Write-Host ""
git diff --stat
$removed = git diff -U0 | Select-String '^-[^-]'
if ($removed) { Write-Host "ACHTUNG: Zeilen wurden entfernt - NICHT deployen:" -ForegroundColor Red; $removed } else { Write-Host "OK: nur hinzugefuegte Zeilen" -ForegroundColor Green }
