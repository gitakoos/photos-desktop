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
#
# With -PreviousInstaller <the last release's Photos-for-Proton-Setup.exe> it also
# builds the update installer for that version, Photos-for-Proton-Update-from-<v>.exe,
# whose payload holds only the files that changed since then.
param([string]$PreviousInstaller)
# Resolved now: the steps below change directory.
if ($PreviousInstaller) { $PreviousInstaller = (Resolve-Path $PreviousInstaller -ErrorAction Stop).Path }

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
# Marks this as a release build, whose copies update themselves by default; a copy built
# from the source any other way leaves that off.
$env:VITE_PFP_OFFICIAL = "1"
npm run tauri build '--' --no-bundle
$appBuilt = $LASTEXITCODE
Remove-Item Env:\VITE_PFP_OFFICIAL
if ($appBuilt -ne 0) { Write-Host "FAILED: main app build (exit $appBuilt)"; exit 1 }

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
if (Test-Path "$final.minisig") { Remove-Item "$final.minisig" -Force }

# The app's updater runs only an installer signed with the update key, so a release
# uploads Photos-for-Proton-Setup.exe.minisig beside the installer. The key lives
# outside the repo; PFP_UPDATE_KEY points elsewhere if it is not in the default place.
Step "sign for the updater"
$key = if ($env:PFP_UPDATE_KEY) { $env:PFP_UPDATE_KEY } else { "$env:USERPROFILE\.pfp-signing\photos-desktop-update.key" }
$version = (Get-Content "$appTauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
if (Test-Path $key) {
  node "$setup\sign-update.mjs" sign $key $final $version
  Check "signing"
} else {
  Write-Host "WARNING: no update key at $key. NOT SIGNED: the app's updater will refuse this installer."
}

# 5. The update installer for the last release: the same installer, built again over a
#    payload of only the files that changed since that release, and told the one
#    version it may update (PFP_PATCH_FROM), which its signature names too.
$patchFinal = $null
if ($PreviousInstaller) {
  Step "update installer"
  $prevVersion = (Get-Item $PreviousInstaller).VersionInfo.ProductVersion
  if ($prevVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Write-Host "FAILED: no version on $PreviousInstaller"; exit 1 }
  if ($prevVersion -eq $version) { Write-Host "FAILED: $PreviousInstaller is this same version ($version)"; exit 1 }
  $patchStage = "$setupTauri\target\patch-stage"
  node "$setup\payload.mjs" changed $stage $PreviousInstaller $patchStage
  Check "changed files"
  $fullZip = "$setupTauri\target\payload-full.zip"
  Copy-Item $payloadZip $fullZip -Force
  Remove-Item $payloadZip -Force
  Compress-Archive -Path "$patchStage\*" -DestinationPath $payloadZip -Force
  "update payload.zip: {0:N1} MB" -f ((Get-Item $payloadZip).Length/1MB)
  Set-Location $setup
  $env:PFP_PATCH_FROM = $prevVersion
  npm run tauri build '--' --no-bundle
  $built = $LASTEXITCODE
  Remove-Item Env:\PFP_PATCH_FROM
  # The full payload goes back, so the next plain build is the full installer again.
  Copy-Item $fullZip $payloadZip -Force
  if ($built -ne 0) { Write-Host "FAILED: update installer build (exit $built)"; exit 1 }
  $patchFinal = "$repo\Photos-for-Proton-Update-from-$prevVersion.exe"
  Copy-Item $out $patchFinal -Force
  if (Test-Path "$patchFinal.minisig") { Remove-Item "$patchFinal.minisig" -Force }
  if (Test-Path $key) {
    node "$setup\sign-update.mjs" sign $key $patchFinal $version $prevVersion
    Check "signing the update installer"
  } else {
    Write-Host "WARNING: NOT SIGNED: the app's updater will refuse this update installer."
  }
}

Step "DONE"
"installer -> $final  ({0:N1} MB)" -f ((Get-Item $final).Length/1MB)
if ($patchFinal) { "update installer -> $patchFinal  ({0:N1} MB)" -f ((Get-Item $patchFinal).Length/1MB) }
Write-Host "SUCCESS"
