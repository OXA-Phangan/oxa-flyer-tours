# Run from inside the oxa-poster-tour folder. Only APPENDS the expireFlyerVolunteers function; aborts on anything unexpected.
$ErrorActionPreference = "Stop"
$flyer = Join-Path (Split-Path -Parent (Get-Location).Path) "oxa-flyer-tours"
if (-not (Test-Path "$flyer\cloud-functions.flyer-volunteer-expiry.js.txt")) { throw "oxa-flyer-tours nicht neben diesem Ordner gefunden" }
if (-not (Test-Path ".\functions\index.js")) { throw "Bitte im Ordner oxa-poster-tour ausfuehren" }
$enc = New-Object System.Text.UTF8Encoding($false)

$fp = (Resolve-Path ".\functions\index.js").Path
$f = [System.IO.File]::ReadAllText($fp)
$snip = [System.IO.File]::ReadAllText("$flyer\cloud-functions.flyer-volunteer-expiry.js.txt")

if ($f -match "expireFlyerVolunteers") { Write-Host "FUNCTIONS: schon drin - nichts geaendert"; return }
$missing = @("onSchedule","getFirestore","FieldValue") | Where-Object { $f -notmatch $_ }
if ($missing) { throw "Fehlende Imports: $missing - ABBRUCH, nichts geaendert" }

Copy-Item $fp "$fp.bak"
[System.IO.File]::WriteAllText($fp, $f.TrimEnd() + "`n" + $snip, $enc)
Write-Host "FUNCTIONS: expireFlyerVolunteers angehaengt"
Write-Host ""
git diff --stat
$removed = git diff -U0 | Select-String '^-[^-]'
if ($removed) { Write-Host "ACHTUNG: Zeilen wurden entfernt - NICHT deployen:" -ForegroundColor Red; $removed } else { Write-Host "OK: nur hinzugefuegte Zeilen" -ForegroundColor Green }
