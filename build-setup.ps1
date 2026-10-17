# Photos for Proton
# Copyright (C) 2026 Akoos <https://akoos.eu>
#
# Source:  https://github.com/gitakoos/photos-desktop
# Website: https://www.photosforproton.eu
#
# This file is part of Photos for Proton.
#
# Photos for Proton is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 3 as
# published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

# Build the custom Photos for Proton installer (a self-contained setup.exe that
# carries the whole app as an embedded zip). Output: Photos-for-Proton-Setup.exe
$repo      = $PSScriptRoot
$app       = "$repo\app"
$appTauri  = "$app\src-tauri"
$sidecar   = "$repo\sidecar"
$setup     = "$repo\setup"
$setupTauri= "$setup\src-tauri"
$binexe    = "$appTauri\binaries\sidecar-x86_64-pc-windows-msvc.exe"
$stage     = "$setupTauri\target\payload-stage"
$payloadZip= "$setupTauri\payload\payload.zip"

function Step($m){ Write-Host "`n==== $m ====" }
function Check($w){ if ($LASTEXITCODE -ne 0){ Write-Host "FAILED: $w (exit $LASTEXITCODE)"; exit 1 } }

# 1. Build the main app (embedded prod frontend). MUST be `tauri build`, never
#    plain cargo (which ships the dev-URL blank page).
Step "1/4 build main app (tauri build --no-bundle)"
Set-Location $app
npm run tauri build '--' --no-bundle
Check "main app build"

# 2. Assemble the payload: the app + sidecar.exe + sidecar/ + the licence texts.
# The staged name is the one every install ends up carrying, so it has to match the
# APP_EXE the installer and the app agree on (app/src-tauri/src/file_assoc.rs).
Step "2/4 assemble payload"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$stage\resources\sidecar" | Out-Null
Copy-Item "$appTauri\target\release\photosforproton.exe" "$stage\photosforproton.exe" -Force
Copy-Item $binexe "$stage\resources\sidecar.exe" -Force
Copy-Item "$sidecar\build\*" "$stage\resources\sidecar\" -Recurse -Force

# Every source file promises the user received a copy of the GPL, and the MIT and
# LGPL components shipped in the payload require their notices to travel with the
# binary, so both texts go in beside it.
Copy-Item "$repo\LICENSE" "$stage\LICENSE" -Force
Copy-Item "$repo\THIRD-PARTY-NOTICES.txt" "$stage\THIRD-PARTY-NOTICES.txt" -Force

# resources\sidecar.exe is a verbatim copy of node.exe, so Node's own licence has
# to travel with it. That file also carries the V8, OpenSSL and ICU notices. The
# repo copy comes first: a Windows Node install does not ship the text, so relying
# on the machine would make the payload depend on who built it.
$nodeLicense = "$repo\NODE-LICENSE.txt"
if (-not (Test-Path $nodeLicense)) {
  $nodeLicense = Join-Path (Split-Path (Get-Command node).Source) "LICENSE"
}
if (Test-Path $nodeLicense) {
  Copy-Item $nodeLicense "$stage\NODE-LICENSE.txt" -Force
} else {
  Write-Host "WARNING: no Node licence text found, so NODE-LICENSE.txt is not in this payload."
  Write-Host "         Fetch it from https://github.com/nodejs/node/blob/$((node --version))/LICENSE"
}

# 3. Zip it (deflate; the installer reads it with the `zip` crate).
Step "3/4 zip payload"
New-Item -ItemType Directory -Force -Path "$setupTauri\payload" | Out-Null
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $payloadZip -Force
"payload.zip: {0:N1} MB" -f ((Get-Item $payloadZip).Length/1MB)

# 4. Build the installer (embeds payload.zip via include_bytes!).
Step "4/4 build installer (tauri build --no-bundle)"
Set-Location $setup
npm run tauri build '--' --no-bundle
Check "installer build"

$out   = "$setupTauri\target\release\setup.exe"
$final = "$repo\Photos-for-Proton-Setup.exe"
Copy-Item $out $final -Force
Step "DONE"
"installer -> $final  ({0:N1} MB)" -f ((Get-Item $final).Length/1MB)
Write-Host "SUCCESS"
