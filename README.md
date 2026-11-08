<p align="center">
  <img src="docs/logo.png" alt="Photos for Proton" width="96" />
</p>

<h1 align="center">Photos for Proton desktop</h1>

<p align="center">
  End-to-end encrypted photo backup and browsing for your Proton Drive Photos library.<br />
  <strong>Unofficial</strong> open-source desktop client for Windows and Linux, built on Proton's own Drive SDK by
  <a href="https://akoos.eu">Akoos</a>. Not affiliated with Proton AG.
</p>

<p align="center">
  <a href="https://github.com/gitakoos/photos-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/gitakoos/photos-desktop?label=release&color=blue" alt="Release" /></a>
  <a href="https://github.com/gitakoos/photos-desktop/releases"><img src="https://img.shields.io/github/downloads/gitakoos/photos-desktop/total?label=downloads&color=8B7CFF" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" /></a>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-orange" alt="Windows 10 and 11" />
  <img src="https://img.shields.io/badge/Linux-Flatpak-orange" alt="Linux, Flatpak" />
  <a href="https://www.photosforproton.eu"><img src="https://img.shields.io/badge/website-photosforproton.eu-8B7CFF" alt="Website" /></a>
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/akoos"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-100f0f?logo=buymeacoffee&logoColor=FFDD00" alt="Buy me a coffee" /></a>
</p>

<p align="center">
  <img src="docs/screenshots/timeline.png" alt="The timeline" width="49%" />
  <img src="docs/screenshots/albums.png" alt="Albums" width="49%" />
</p>

## Features

| Area | What you get |
| --- | --- |
| **End-to-end encrypted** | Built on Proton's official Drive SDK, so photos and metadata are decrypted only on this device. Sign in on Proton's own page in the browser, where the password, the second factor and any captcha are entered, so the app never sees your password. |
| **Browse & find** | The full timeline by month in a sidebar layout, with smooth zoom and a viewer that zooms around the cursor, a filmstrip and keyboard shortcuts. One search over photos, albums, people and labels, with dates, names, labels and categories as pills. A Collection of days and seasons from past years, and a map of where photos were taken with a searchable list of places. |
| **People & search on this PC** | Face recognition groups photos by the people in them, and search finds photos by what they show ("dog in the snow"), both on this PC, each with its own switch and a Gentle, Balanced or Fast scan that goes Gentle on battery. |
| **One backup with your phone** | With Automatic backup on, faces, names, labels, hidden photos and the search index stay the same on this PC and on phones with Photos for Proton 2.6.0 or newer; a later rename or merge wins on every device. |
| **Albums & sharing** | Create, rename and delete albums, choose a cover, and add or remove photos. Share a photo by public link with an optional password and expiry, invite people to an album as viewer or editor, and accept or decline albums shared with you. |
| **Organize** | Selection with click, Ctrl and Shift and bulk actions, right-click menus, favourites, labels, renaming, hidden photos and albums, and a trash that restores, deletes for good, or empties. |
| **Edit** | The Android app's editor: thirteen adjustments, curves and HSL, filters, crop, straighten and keystone, pen, text, redaction, Hide faces and frames. Edits are saved as a new copy that keeps the original's date, camera and place. |
| **Fix dates** | Change the date of photos beside the photo or the grid (set, shift, or take it from the file name), or fix many at once on the Fix dates page; each photo is replaced by a corrected copy that keeps its albums, labels and faces. |
| **Tools** | Copy text from photos, read on this PC, and a duplicate finder for identical and similar photos. |
| **Upload & import** | Files, folders or drag and drop, with thumbnails, capture time, place and camera, and photos and videos made smaller on upload if you like. Import a Google Takeout or an Ente export with a review first, or bring photos over from My files; dates, places, albums, favourites and Live Photos are kept, and photos already in the library are skipped. |
| **File Explorer** (Windows) | Optional. A Proton Photos folder in the Explorer sidebar that works both ways: copy photos in to upload them, make a folder under Albums for a new album, rename, move into Favorites, or delete to the Proton trash. Nothing takes space until it is opened, and Windows Search does not index the photos' dates, camera or places. Keep on this PC downloads new or every photo, with Pause and Resume. |
| **File manager** (Linux) | Proton Photos in the file manager's sidebar (GNOME Files, KDE Dolphin): open photos from there, copy files in to upload them, or delete to the Proton trash. |
| **Privacy & lock** | The session, the caches and any offline photos are sealed with AES-256-GCM on this PC, and locking discards the key. Hidden photos and the app lock open with Windows Hello, or on Linux with a password of your own. Keep photos available offline inside the app, readable by nothing else; started with no connection, the app opens on them. |
| **Hardened** | No telemetry, logs scrubbed of key material, and updates checked against the release's SHA-256 before they run. |
| **Comfort** | On Windows it runs in the system tray and releases the renderer's memory there, starts with Windows if you like, updates itself with its progress shown, and opens photos and videos from Explorer straight into the viewer. On Linux it starts at login if you like and keeps running when its window is closed. 11 languages, light, dark and system themes with a pure-black option, and 11 colour palettes. |

## Install

**Windows 10 and 11:** download `Photos-for-Proton-Setup.exe` from the [releases page](https://github.com/gitakoos/photos-desktop/releases/latest) and run it. It installs for your account only and asks for no administrator rights. Windows SmartScreen may show "Windows protected your PC" the first time: choose **More info**, then **Run anyway**.

**Linux:** download `photos-for-proton.flatpak` from the same page and install it with `flatpak install --user photos-for-proton.flatpak`. It uses the GNOME runtime from Flathub, which Flatpak fetches on its own. A later version installs the same way, over this one, keeping your sign-in and settings. To build it yourself: `bash flatpak/build-local.sh`.

## Architecture

The app has three parts:

| Part | Holds | Talks to |
|---|---|---|
| **Host** | Tauri and Rust: windows, tray, the sealed store, the File Explorer folder (a Windows Cloud Filter provider), the Linux file-manager drive (a local WebDAV server), the updater launch | Frontend, Sidecar |
| **Frontend** | React: every screen, from the timeline to Settings | Host |
| **Sidecar** | Node with Proton's Drive TypeScript SDK: sign-in, the library, uploads, downloads, sharing, search | Host, over JSON-RPC on stdin and stdout |

The installer in `setup/` is a second, smaller Tauri app that carries the whole application as an embedded payload.

## Project structure

```
app/
├── src/              Frontend (React)
│   ├── views/        Photos, Albums, Shared, Trash, Settings, Lock, tray popup, viewer window
│   ├── components/   Grid, viewer, editor, map, upload, sidebar, dialogs
│   ├── hooks/        Thumbnails, uploads, selection, cloud and folder media
│   ├── lib/          RPC, search terms, dates, geocoder, theme, i18n, locales (11 languages)
│   └── styles/       One stylesheet per screen
└── src-tauri/src/    Host (Rust)
    ├── lib.rs                       Windows, tray, commands, the sidecar channel
    ├── cloud_mount.rs               File Explorer folder (Cloud Filter provider)
    ├── explorer_sync.rs, explorer_rules.rs   Changes made in Explorer, read and applied
    ├── files_drive.rs               Linux file-manager drive (local WebDAV)
    ├── secure_store.rs              Sealed store and the vault key
    └── window_place.rs, notices.rs, file_assoc.rs, autostart.rs, …
sidecar/
├── server.ts         JSON-RPC server
├── update.ts         Release check and verified download
└── proton/           Session, library, upload, download, albums, sharing,
                      trash, import, search, faces, copy text, duplicates,
                      the backup shared with the phone
setup/                Installer (Tauri)
flatpak/              Linux Flatpak manifest and local build
```

## What's reused vs. what's built here

This project **uses Proton's published Drive SDK as-is** (no forks, no modifications). Requests carry a client-specific app version so Proton's servers see this independent client for what it is, rather than impersonating an official app. Everything around it, the host, the screens, the File Explorer folder and the Linux file-manager drive, is written for this project.

The app does not emit any telemetry events; there is no analytics call site anywhere in the code.

## Disclaimer

Not affiliated with Proton AG. Proton, Proton Drive, and Proton Photos are trademarks of Proton AG. Built on Proton's published Drive SDK with no proprietary code from Proton.

## Author

[**Akoos**](https://akoos.eu): creator and maintainer.

## License

[GPL-3.0](LICENSE). Third-party licences and notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt), installed alongside the app.
