# Run from inside the oxa-poster-tour folder.
# Replaces ONLY the previously added flyer photo-retention block at the end of functions/index.js
# with the current version (now also deletes selfies). Aborts on anything unexpected.
$ErrorActionPreference = "Stop"
$flyer = Join-Path (Split-Path -Parent (Get-Location).Path) "oxa-flyer-tours"
if (-not (Test-Path "$flyer\cloud-functions.flyer-photo-cleanup.js.txt")) { throw "oxa-flyer-tours nicht neben diesem Ordner gefunden" }
if (-not (Test-Path ".\functions\index.js")) { throw "Bitte im Ordner oxa-poster-tour ausfuehren" }
$enc = New-Object System.Text.UTF8Encoding($false)

$fp = (Resolve-Path ".\functions\index.js").Path
$f = [System.IO.File]::ReadAllText($fp)
$snip = [System.IO.File]::ReadAllText("$flyer\cloud-functions.flyer-photo-cleanup.js.txt")

if ($f -match "selfiePhotoPath") { Write-Host "FUNCTIONS: schon aktuell - nichts geaendert"; return }

$marker = "// OXA Flyer Tours " + [char]0x2014 + " photo retention"
$m = $f.IndexOf($marker)
if ($m -lt 0) { throw "Alter Block nicht gefunden - ABBRUCH, nichts geaendert" }
$markerLineStart = $f.LastIndexOf("`n", $m)
if ($markerLineStart -lt 1) { throw "Unerwarteter Dateiaufbau - ABBRUCH" }
$start = $f.LastIndexOf("`n", $markerLineStart - 1) + 1   # the '// ====' line above the marker line
$tail = $f.Substring($start)
if (([regex]::Matches($tail, "exports\.")).Count -ne 2) { throw "Nach dem Block steht weiterer Code - ABBRUCH, nichts geaendert" }

Copy-Item $fp "$fp.bak"
$new = $f.Substring(0, $start).TrimEnd() + "`n" + $snip
[System.IO.File]::WriteAllText($fp, $new, $enc)
Write-Host "FUNCTIONS: Block ersetzt"
Write-Host ""
git diff --stat
