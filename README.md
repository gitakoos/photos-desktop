<p align="center">
  <img src="docs/logo.png" alt="Photos for Proton" width="96" />
</p>

<h1 align="center">Photos for Proton for Windows</h1>

<p align="center">
  End-to-end encrypted photo backup and browsing for your Proton Drive Photos library.<br />
  <strong>Unofficial</strong> open-source Windows client built on Proton's own Drive SDK by
  <a href="https://akoos.eu">Akoos</a>. Not affiliated with Proton AG.
</p>

<p align="center">
  <a href="https://github.com/gitakoos/photos-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/gitakoos/photos-desktop?include_prereleases&label=release&color=blue" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" /></a>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-orange" alt="Windows 10 and 11" />
  <a href="https://www.photosforproton.eu"><img src="https://img.shields.io/badge/website-photosforproton.eu-8B7CFF" alt="Website" /></a>
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/akoos"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-100f0f?logo=buymeacoffee&logoColor=FFDD00" alt="Buy me a coffee" /></a>
</p>

> If something breaks, please open an [issue](https://github.com/gitakoos/photos-desktop/issues).

## Features

| Area | What you get |
| --- | --- |
| **End-to-end encrypted** | Built on Proton's official Drive SDK, so photos and metadata are decrypted only on this device. Sign in on Proton's own page in the browser, so the password never reaches the app, or with the password in the app. The session, the caches and any offline photos are sealed on this PC. No telemetry, and logs are scrubbed of key material. |
| **Browse** | The full timeline grouped by month, with a viewer that zooms around the cursor, pans by drag and switches between fit and actual pixels on a double click. A filmstrip and a contents list along the bottom, arrow keys between photos, and `F` to favourite, `S` to share, `I` for details, `Delete` to trash. Ctrl and the wheel change the grid density, which is remembered. |
| **Video** | Playback with its own controls: a scrub track that seeks as it is dragged, single frame steps while paused, mute, and the elapsed and total time. The bar fades while the video plays and comes back on a movement. |
| **Find** | Search by file name or media type, with the name index built locally in the background so results fill in as it completes. Nine category filters: favourites, screenshots, videos, live photos, selfies, portraits, bursts, panoramas and RAW. |
| **Albums and sharing** | Create, rename and delete albums, choose a cover, and add or remove photos. Share a photo by public link with an optional password and expiry, and revoke it later. Invite people to an album as viewer or editor. Albums shared with you open like your own. |
| **Organise** | Rubber-band selection across the grid with bulk actions, right-click menus throughout, favourites, renaming, and a trash that restores, deletes for good, or empties. |
| **Edit** | Crop, rotate, flip, adjust colour, apply filters and redact parts of a photo. Edits are saved as a new copy that keeps the original's date, camera and place; for a photo in Proton, the copy is uploaded beside it. |
| **Upload** | Choose files or a whole folder, or drag them onto the window. Photos and videos carry their thumbnail, capture time, size, length, the place they were taken and the camera that took them. The queue reports every item, including the ones skipped as duplicates. |
| **Import** | Bring in a Google Takeout or an Ente export, as a folder or as zip files. Everything is shown for review first, by album and with the date each photo will be filed under. Dates, places and captions come from the export's own records, albums are recreated, favourites are kept, Live Photos upload as one, and photos already in the library are skipped. |
| **File Explorer** | Optional. Your library appears as an ordinary folder in the navigation pane, built on the Windows Cloud Filter API, and nothing takes up disk space until it is opened. Photos are marked as not content-indexed, so Windows Search cannot lift capture dates, camera or GPS out of them. |
| **Kept on this PC** | Two independent ways, measured and cleared separately. *Available offline* keeps the app's own copy, encrypted inside the app, readable by nothing else. *Download* writes ordinary files, either into the Explorer folder or somewhere you pick. New photos arriving in the timeline can be downloaded automatically, or a single album instead. |
| **Files on this PC** | Open a photo or video from Explorer straight into the viewer, with no sign-in. Read its details, rename it, send it to the recycle bin, or upload it to Proton in one press. |
| **The app itself** | Runs in the system tray, and closing the window hides it there and releases the renderer's memory. It can start with Windows, and lock when hidden so reopening asks for the password again. Seven colour palettes across dark, light or system mode, eleven languages, and a banner offering new versions as they are published. |

## File Explorer integration

Optional. Choose it during install, or switch it later in Settings, then File Explorer. It adds a **Proton Photos** entry to the Explorer sidebar, built on the Windows Cloud Filter API: every photo is listed by name and date, album names become folder names, and nothing takes up disk space until it is fetched.

Understand what this exposes before turning it on. Any program that reads the folder downloads the full photo, so an antivirus scan or a backup tool can pull the whole library onto this computer as ordinary files. Explorer keeps its own thumbnail cache, which survives freeing up space and uninstalling.

Set against that, the folder and every placeholder inside it are marked as not content-indexed, which stops Windows Search from lifting capture dates, camera and GPS coordinates out of the photos. File names, sizes and timestamps are still indexed, as they are for any file.

Uninstalling keeps the photos that were fully downloaded, as ordinary files, and removes only the stubs that never held any data.

## Privacy

- End-to-end encrypted throughout. It uses Proton's official Drive SDK, so photos and metadata are decrypted only on this device.
- Signing in through the browser uses Proton's session fork: the password, the second factor and any captcha are entered on account.proton.me, and the app receives a session of its own with the key password, sealed under a key that travels only in the link's fragment, which the browser never sends to a server.
- The session, the caches and any offline photos are sealed with AES-256-GCM under a key derived (scrypt) from a password: the Proton password for a sign-in in the app, or one of the user's own after a browser sign-in. Either is asked at every cold start. A browser sign-in can instead keep a random key that Windows DPAPI seals to this user account, and then the app opens without asking. Locking discards the key rather than merely hiding the window. The few settings that have to be readable before sign-in, such as theme and language, are held separately under a key that Windows DPAPI seals to this user account.
- Logs are scrubbed of key material, and no telemetry is sent.
- Updates are fetched from a pinned URL and checked against the release's SHA-256 before anything runs.

## Install

Download `Photos-for-Proton-Setup.exe` from [Releases](https://github.com/gitakoos/photos-desktop/releases) and run it.

**The executable is not code-signed.** Windows SmartScreen will interrupt the first run with "Windows protected your PC": choose **More info**, then **Run anyway**. This happens on every release rather than just the first one, because the reputation SmartScreen looks for is tied to a signing certificate this project does not have.

The install is per-user and never asks for administrator rights. Nothing is written to Program Files, ProgramData or the machine-wide registry. What it does write:

- the program itself, by default in `%LOCALAPPDATA%\Photos for Proton\`, with its encrypted data in a `data` subfolder
- Desktop and Start Menu shortcuts, if you choose them
- two `HKCU` keys: the Add/Remove Programs entry, and the app's own preferences
- a WebView profile and a few working files in `%TEMP%`

On first run, with the Explorer integration on, the app creates `%USERPROFILE%\Proton Photos\` and registers it as a sync root, which adds a third `HKCU` key under Explorer's `SyncRootManager`.

Running the installer again over an existing install offers to upgrade in place, keeping the sign-in, the cached photos and the settings. To remove the app, use Settings, then Apps, or `uninstall.exe` in the install folder.

## Build from source

Requires Node and a Rust toolchain, both on `PATH`.

```powershell
cd app;        npm install
cd ../setup;   npm install
cd ../sidecar; npm install; npm run build
cd ..
./build-setup.ps1
```

The sidecar build is not optional: it bundles the server and stages the Node runtime that `build-setup.ps1` packs into the installer. The result is `Photos-for-Proton-Setup.exe` in the repo root.

Tests: `npm test` in `sidecar/`, and `cargo test --lib` in `app/src-tauri` and `setup/src-tauri`.

## How it is built

Tauri and Rust with a React frontend, plus a Node sidecar that hosts Proton's official Drive TypeScript SDK. The Explorer integration is a Cloud Filter provider in the Rust host. The installer in `setup/` is a second, smaller Tauri app that carries the whole application as an embedded payload.

## Not affiliated with Proton

This is an independent project, not affiliated with, endorsed by, or supported by Proton AG. "Proton" and "Proton Drive" are trademarks of Proton AG.

## License

GPL-3.0. See [LICENSE](LICENSE).

This app bundles third-party components, including Proton's Drive SDK, OpenPGP.js and the Node runtime. Their licences and permission notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt), and both files are installed alongside the app.

Made by [Akoos](https://akoos.eu) &middot; [photosforproton.eu](https://www.photosforproton.eu) &middot; github@akoos.eu
