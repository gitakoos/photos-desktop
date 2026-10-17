/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// German (de) strings. Keys mirror en.ts exactly.
export const de: Record<string, string> = {
  // Common
  "common.cancel": "Abbrechen",
  "common.close": "Schließen",
  "common.back": "Zurück",
  "common.loading": "Wird geladen…",
  "common.photoCount.one": "{count} Foto",
  "common.photoCount.other": "{count} Fotos",

  // Navigation
  "nav.photos": "Fotos",
  "nav.albums": "Alben",
  "nav.shared": "Geteilt",
  "nav.trash": "Papierkorb",

  "settings.sidebarLayout": "Seitenleiste",
  "settings.sidebarLayoutDesc": "Navigation und Profil in einer einklappbaren Seitenleiste links. Experimentell und noch in Arbeit.",
  "sidebar.collapse": "Einklappen",
  "sidebar.expand": "Ausklappen",
  "sidebar.showAlbums": "Alben anzeigen",
  "sidebar.hideAlbums": "Alben ausblenden",
  "sidebar.downloading": "Wird heruntergeladen",
  "sidebar.indexing": "Wird indexiert",
  "sidebar.dropHint": "oder Dateien hierher ziehen",

  // App shell
  "app.restoring": "Sitzung wird wiederhergestellt…",
  "update.available": "Update {version} ist verfügbar",
  "update.now": "Aktualisieren",
  "update.updating": "Wird aktualisiert…",
  "update.failed": "Update fehlgeschlagen",
  "update.hashError": "Überprüfung des Downloads fehlgeschlagen",
  "menu.reload": "Neu laden",
  "menu.moreSoon": "Bald mehr…",
  "menu.quit": "Beenden",

  // Tray popup
  "tray.open": "Photos for Proton öffnen",
  "tray.syncNow": "Jetzt synchronisieren",
  "tray.syncing": "Wird synchronisiert…",
  "tray.synced": "Auf dem neuesten Stand",
  "tray.locked": "Gesperrt",
  "tray.lockedHint": "Zum Entsperren öffnen",
  "tray.signedOut": "Nicht angemeldet",
  "tray.signedOutHint": "Zum Anmelden öffnen",

  // Login
  "login.subtitle": "Melde dich bei deinem Proton-Konto an",
  "login.emailLabel": "E-Mail oder Benutzername",
  "login.passwordLabel": "Passwort",
  "login.passwordPlaceholder": "Passwort",
  "login.signIn": "Anmelden",
  "login.signingIn": "Anmeldung läuft…",
  "login.twofaLabel": "Zwei-Faktor-Code",
  "login.verify": "Bestätigen",
  "login.verifying": "Wird bestätigt…",
  "login.captchaHint": "Proton bittet dich zu bestätigen, dass du ein Mensch bist.",
  "login.captchaExpired": "Das Captcha ist abgelaufen. Bitte löse es erneut.",
  "login.withBrowser": "Im Browser anmelden",
  "login.withBrowserHint": "Du meldest dich auf Protons eigener Seite an. Dein Passwort erreicht diese App nie.",
  "login.withPassword": "Stattdessen mit E-Mail und Passwort anmelden",
  "login.or": "oder mit E-Mail und Passwort",
  "login.browserWaiting": "Schließe die Anmeldung im Browser ab. Dieses Fenster macht dann von selbst weiter.",
  "login.browserOpenAgain": "Seite erneut öffnen",
  "login.browserCopy": "Link kopieren",
  "login.browserCopied": "Link kopiert",
  "login.browserNotOpened": "Der Browser hat sich nicht geöffnet. Kopiere den Link und öffne ihn selbst.",
  "login.browserTimeout": "Die Anmeldung hat zu lange gedauert. Bitte versuche es erneut.",
  "login.sessionEnded": "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.",
  "login.unofficial": "Dies ist eine Drittanbieter-App, die von Proton nicht offiziell unterstützt wird.",
  "protect.intro": "Wie soll dieser Computer dich angemeldet halten?",
  "protect.password": "Mit einem eigenen Passwort",
  "protect.passwordDesc": "Wird bei jedem Start der App abgefragt. Es kann beliebig sein, es ist nicht dein Proton-Passwort.",
  "protect.newPassword": "Passwort für diese App",
  "protect.repeatPassword": "Passwort wiederholen",
  "protect.device": "Ohne Passwort",
  "protect.deviceDesc": "Die App öffnet sich sofort. Dein Windows-Konto schützt sie: Wer sich daran anmelden kann, kann auch die App öffnen.",
  "protect.continue": "Weiter",
  "protect.tooShort": "Mindestens {n} Zeichen.",
  "protect.mismatch": "Die beiden Passwörter stimmen nicht überein.",

  // Lock screen (returning cold start)
  "lock.subtitle": "Gib dein Passwort ein, um zu entsperren",
  "lock.unlock": "Entsperren",
  "lock.unlocking": "Wird entsperrt…",
  "lock.wrongPassword": "Falsches Passwort",
  "lock.failed": "Entsperren fehlgeschlagen. Bitte versuche es erneut.",
  "lock.differentAccount": "Anderes Konto verwenden",

  // Titlebar
  "titlebar.minimize": "Minimieren",
  "titlebar.maximize": "Maximieren",

  // Settings
  "settings.title": "Einstellungen",
  "settings.general": "Allgemein",
  "settings.launchAtLogin": "Mit Windows starten",
  "settings.launchAtLoginDesc": "Startet beim Anmelden bei Windows im Hintergrund. Bis zum Öffnen ist nur das Symbol im Infobereich zu sehen.",
  "settings.launchAtLoginLinux": "Beim Anmelden starten",
  "settings.launchAtLoginLinuxDesc": "Öffnet Photos for Proton beim Anmelden am Computer.",
  "settings.keepRunning": "Nach dem Schließen weiterlaufen",
  "settings.keepRunningDesc":
    "Nach dem Schließen des Fensters läuft Photos for Proton weiter, damit Proton Photos in Dateien erreichbar bleibt. Über die Anwendungen wieder öffnen, über das Kontomenü beenden.",
  "settings.appearance": "Darstellung",
  "settings.theme": "Design",
  "settings.themeDesc": "System folgt Windows und passt sich weiter an, wenn sich das Design ändert.",
  "settings.theme.dark": "Dunkel",
  "settings.theme.light": "Hell",
  "settings.theme.system": "System",
  "settings.palette": "Palette",
  "settings.paletteDesc": "Akzentfarbe für die gesamte App.",
  "settings.palette.default": "Standard",
  "settings.palette.forest": "Wald",
  "settings.palette.sunset": "Sonnenuntergang",
  "settings.palette.sea": "Meer",
  "settings.palette.sepia": "Sepia",
  "settings.palette.mono": "Mono",
  "settings.palette.amoled": "Reines Schwarz (AMOLED)",
  "settings.language": "Sprache",
  "settings.languageDesc": "Wähle die Anzeigesprache.",
  "settings.timeline": "Zeitleiste",
  "settings.hideAlbum": "Fotos in Drive-Alben ausblenden",
  "settings.hideAlbumDesc":
    "Fotos, die einem Drive-Album hinzugefügt wurden, erscheinen nicht in deiner Haupt-Zeitleiste. In den Tabs Alben und Geteilt sowie in den Kategoriefiltern bleiben sie sichtbar.",
  "settings.security": "Sicherheit",
  "settings.about": "Über",
  "settings.checkUpdates": "Nach Updates suchen",
  "settings.upToDate": "Du bist auf dem neuesten Stand",
  "settings.website": "Website",
  "settings.sourceCode": "Quellcode",
  "settings.authorRole": "Entwickler und Maintainer",
  "settings.support": "Spendier mir einen Kaffee",
  "settings.supportDesc": "Unterstütze die App und ihre Entwicklung",
  "settings.lockOnHide": "Passwort beim erneuten Öffnen aus der Taskleiste verlangen",
  "settings.deviceProtected": "Durch dein Windows-Konto geschützt",
  "settings.deviceProtectedDesc": "Diese App öffnet sich ohne Passwort. Für ein Passwort meldest du dich ab und wieder an.",
  "settings.debug": "Debug-Overlay",
  "settings.debugDesc": "Live-Speicheranzeige einblenden (Heap- und Cache-Größen).",
  "settings.explorer": "Datei-Explorer",
  "settings.showInExplorer": '"Proton Photos" im Datei-Explorer anzeigen',
  "settings.showInExplorerDesc":
    "Fügt der Explorer-Seitenleiste einen Eintrag für Proton Photos mit deinen Cloud-Fotos hinzu. Wird nach einem Neustart wirksam.",
  "settings.autoDownload": "Neue Fotos automatisch herunterladen",
  "settings.autoDownloadDesc":
    "Sobald neue Fotos zu deiner Bibliothek hinzukommen, werden sie automatisch in den Ordner Proton Photos heruntergeladen.",
  "settings.autoDownloadNeedsExplorer":
    'Funktioniert nur, wenn "Proton Photos" im Datei-Explorer angezeigt wird, und das ist ausgeschaltet. Das Herunterladen funktioniert weiterhin: Du wirst gefragt, wo deine Fotos gespeichert werden sollen.',
  "settings.restartNeeded": "Starte neu, um diese Änderung anzuwenden.",
  "settings.restartNow": "Jetzt neu starten",
  "settings.filesDrive": "Dateimanager",
  "settings.filesDriveShow": '"Proton Photos" in Dateien anzeigen',
  "settings.filesDriveShowDesc":
    "Fügt Proton Photos der Seitenleiste von Dateien und anderen Dateimanagern hinzu. Dort Fotos öffnen und kopieren, und Fotos oder Ordner hineinziehen, um sie hochzuladen: Ein Ordner wird zu einem Album, in Photos abgelegt landet er in der Zeitleiste. Funktioniert, solange die App läuft und entsperrt ist.",
  "settings.filesDriveAddress": "Adresse",
  "settings.filesDriveAddressDesc":
    "Für einen Dateimanager ohne Eintrag in der Seitenleiste: mit dieser Adresse verbinden. In Dolphin webdav:// statt dav:// verwenden.",
  "settings.filesDriveCopy": "Kopieren",
  "settings.filesDriveCopied": "Kopiert",
  "settings.filesDriveEdits": "Löschen und Umbenennen erlauben",
  "settings.filesDriveEditsDesc":
    "Ein in Photos gelöschtes Foto kommt in den Proton-Papierkorb und kann 30 Tage lang wiederhergestellt werden. In einem Albumordner gelöscht, wird es nur aus dem Album entfernt; das Löschen eines Albumordners löscht das Album, seine Fotos bleiben erhalten. Aus Trash lässt sich in Dateien nichts löschen.",
  "settings.filesDriveByDate": "Photos nach Jahr und Monat aufteilen",
  "settings.filesDriveByDateDesc":
    "Zeigt Photos als Jahres- und Monatsordner statt einer langen Liste.",
  "settings.filesDriveServer": "Adresse und Port",
  "settings.filesDriveServerDesc":
    "Wo das Laufwerk auf diesem Computer erreichbar ist: localhost oder eine Adresse von 127.0.0.1 bis 127.255.255.254. Ohne Port wird ein freier verwendet. Im Netzwerk ist es nie erreichbar.",
  "settings.filesDriveAutoPort": "auto",
  "settings.filesDriveApply": "Übernehmen",
  "settings.filesDriveErrAddress": "localhost oder eine Adresse, die mit 127. beginnt.",
  "settings.filesDriveErrPort": "Ein Port von 1024 bis 65535, oder leer lassen.",
  "settings.filesDriveErrInUse":
    "Dieser Port wird bereits verwendet. Das Laufwerk bleibt, wo es war.",
  "settings.filesDrivePortTaken":
    "Der gewählte Port war beim Start belegt, daher wird bis zu seiner Freigabe ein anderer verwendet.",
  // File types. The "Open with" entries are the app's own to add and take back out;
  // the default handler is not, so that half leads out to Windows rather than
  // pretending to a choice Windows takes from the user alone.
  "settings.fileTypes": "Dateitypen",
  "settings.openWith": 'Zur Liste "Öffnen mit" hinzufügen',
  "settings.openWithDesc":
    'Führt Photos for Proton im Windows-Menü "Öffnen mit" für JPEG-, PNG-, GIF-, WebP-, AVIF-, BMP-, TIFF- und HEIC-Fotos sowie für MP4-, MOV-, M4V- und WebM-Videos auf. Beim Ausschalten werden die Einträge wieder entfernt.',
  "settings.fileTypesFailed": "Die Dateitypen konnten nicht geändert werden. Bitte versuche es erneut.",
  "settings.defaultApp": "Standard-App für Fotos und Videos",
  "settings.defaultAppDesc":
    "So wird nichts zur Standard-App: Diese Wahl akzeptiert Windows nur von dir, nie von einem Programm. Wähle Photos for Proton in den Windows-Einstellungen unter Standard-Apps aus.",
  "settings.defaultAppOpen": "Windows-Einstellungen öffnen",
  "settings.defaultAppFailed": "Die Windows-Einstellungen konnten nicht geöffnet werden. Bitte versuche es erneut.",
  "settings.lockOnHideDesc":
    "Wird das Fenster in die Taskleiste geschlossen, sperrt sich die App und fragt beim nächsten Öffnen nach deinem Passwort.",
  "settings.storage": "Speicher",
  // Two different places a photo can be kept on this machine: encrypted inside the
  // app, or downloaded into the Proton Photos folder where Windows can read it. The
  // panel names both rather than adding one number to the other.
  "settings.downloadedCount.one": "{count} Foto heruntergeladen",
  "settings.downloadedCount.other": "{count} Fotos heruntergeladen",
  "settings.downloadedNone": "Nichts heruntergeladen",
  "settings.downloadedDesc":
    "Heruntergeladene Fotos sind gewöhnliche Dateien im Ordner Proton Photos, sodass die Windows-Suche und andere Programme sie lesen können. Beim Freigeben werden nur diese lokalen Kopien entfernt, und deine Fotos bleiben bei Proton.",
  "settings.freeUpAll": "{size} freigeben",
  "settings.freeUpNothing": "Nichts freizugeben",
  "settings.freeingUp": "Wird freigegeben…",
  "settings.storageOffline": "Offline-Fotos",
  "settings.storageExplorer": "Im Datei-Explorer",
  "settings.offlineCount.one": "{count} Foto in der App",
  "settings.offlineCount.other": "{count} Fotos in der App",
  "settings.offlineNone": "Keine Fotos in der App gespeichert",
  "settings.offlineDesc":
    "Fotos, die du als offline verfügbar markierst, bleiben verschlüsselt in der App. Sie lassen sich ohne Verbindung öffnen und erscheinen nie im Ordner Proton Photos, sodass nichts außerhalb der App sie lesen kann.",
  "settings.offlineSaving": "Wird gespeichert {done}/{total}…",
  "settings.offlineRemoveAll": "{size} freigeben",
  "settings.offlineRemoveNothing": "Nichts freizugeben",
  "settings.offlineRemoving": "Wird entfernt…",
  "settings.freeUpFailed": "Der Speicherplatz konnte nicht freigegeben werden. Bitte versuche es erneut.",

  // Profile menu
  "profile.storage": "Speicher",
  "profile.used": "{size} belegt",
  "profile.total": "{size} gesamt",
  "profile.signOut": "Abmelden",

  // Avatar
  "avatar.uploading": "Wird hochgeladen",
  "avatar.syncing": "Wird synchronisiert",
  "avatar.account": "Konto und Einstellungen",
  "avatar.showUploads": "Uploads anzeigen",

  // Photos view
  "photos.all": "Alle",
  "photos.search": "Suchen",
  "photos.searchPlaceholder": "Nach Dateiname oder Typ suchen…",
  "photos.closeSearch": "Suche schließen",
  "photos.indexing": "Indexierung {done}/{total}",
  "photos.uploadTitle": "Fotos hochladen oder einen Ordner als Album",
  "photos.uploadingProgress": "Wird hochgeladen {progress}",
  "photos.noMatches": "Keine Treffer",
  "photos.noPhotos": "Noch keine Fotos",
  "photos.noPhotosSub": "Deine Fotos erscheinen hier nach der Synchronisierung.",
  "photos.stillIndexing": "Indexierung läuft noch, weitere Ergebnisse folgen.",
  "photos.dropTitle": "Zum Hochladen ablegen",
  "photos.dropSub": "Ein Ordner wird zu einem Album mit demselben Namen",
  "photos.offline": "Offline verfügbar, verschlüsselt in der App",
  "photos.downloaded": "In den Ordner Proton Photos heruntergeladen",
  "photos.renameTitle": "Foto umbenennen",
  "photos.namePlaceholder": "Dateiname",

  // Tile badges
  "badge.motionPhoto": "Bewegtes Foto",
  "badge.panorama": "Panorama",
  "badge.raw": "RAW",
  "badge.favorite": "Favorit",

  // Search type filters
  "filter.images": "Bilder",
  "filter.videos": "Videos",

  // Filter panel
  "filter.title": "Filter",
  "filter.categories": "Kategorien",
  "filter.type": "Typ",
  "filter.mediaAll": "Alle",
  "filter.mediaPhotos": "Fotos",
  "filter.reset": "Zurücksetzen",

  // Categories
  "category.fav": "Favoriten",
  "category.screen": "Screenshots",
  "category.video": "Videos",
  "category.live": "Live-Fotos",
  "category.selfie": "Selfies",
  "category.portrait": "Porträts",
  "category.burst": "Serienaufnahmen",
  "category.pano": "Panoramen",
  "category.raw": "RAW",

  // Albums
  "albums.backToAlbums": "Zurück zu den Alben",
  "albums.untitled": "Unbenanntes Album",
  "albums.empty": "Dieses Album ist leer",
  "albums.none": "Noch keine Alben",
  "albums.noneSub": "Erstelle hier eines, oder ziehe einen Ordner auf das Fenster.",
  "albums.keepDownloaded": "Dieses Album in den Ordner Proton Photos herunterladen",
  "albums.keptDownloaded": "Wird in den Ordner Proton Photos heruntergeladen (zum Beenden klicken)",
  "albums.freeUpTitle": "Speicherplatz dieses Albums freigeben?",
  "albums.freeUpCount.one":
    "Das Album lädt sich nicht mehr selbst herunter. {count} Foto liegt bereits im Ordner Proton Photos und kann dort bleiben, oder du gibst seinen Speicherplatz frei. Es bleibt in beiden Fällen bei Proton.",
  "albums.freeUpCount.other":
    "Das Album lädt sich nicht mehr selbst herunter. {count} Fotos liegen bereits im Ordner Proton Photos und können dort bleiben, oder du gibst ihren Speicherplatz frei. Sie bleiben in beiden Fällen bei Proton.",
  "albums.freeUpKeep": "Heruntergeladen behalten",
  "albums.freeUpConfirm": "Freigeben",
  "albums.newAlbum": "Neues Album",
  "albums.searchHint": "Alben suchen",
  "albums.searchEmpty": "Keine Alben entsprechen deiner Suche",
  "albums.sortName": "Name (A bis Z)",
  "albums.sortActivity": "Letzte Aktivität",
  "albums.sortCount": "Anzahl Fotos",
  "albums.pin": "Anheften",
  "albums.unpin": "Lösen",
  "albums.pinLimit": "Du kannst bis zu 5 Alben anheften",
  "albums.newTitle": "Album benennen",
  "albums.namePlaceholder": "Albumname",
  "albums.create": "Erstellen",
  "albums.createAndAdd": "Erstellen und hinzufügen",
  "albums.rename": "Umbenennen",
  "albums.renameTitle": "Album umbenennen",
  "albums.share": "Album teilen",
  "albums.delete": "Album löschen",
  "albums.more": "Mehr",
  "albums.addPhotos": "Fotos hinzufügen",
  "albums.addFromLibrary": "Aus deiner Bibliothek",
  "albums.addFromComputer": "Von diesem Computer",
  "albums.deleted": "Album gelöscht",
  "albums.addTitle": "Zum Album hinzufügen",
  "albums.addCount.one": "Wähle, wohin {count} Foto soll.",
  "albums.addCount.other": "Wähle, wohin {count} Fotos sollen.",
  "albums.added": "{count} hinzugefügt",
  "albums.addPartial": "{ok} hinzugefügt, {failed} fehlgeschlagen",
  "albums.removed": "{count} aus dem Album entfernt",
  "albums.removePartial": "{ok} entfernt, {failed} fehlgeschlagen",
  "albums.coverSet": "Titelbild aktualisiert",
  "albums.strandedTitle.one": "{count} Foto ist nur in diesem Album",
  "albums.strandedTitle.other": "{count} Fotos sind nur in diesem Album",
  "albums.strandedMsg.one":
    "Es ist nicht in deiner Zeitleiste und wird mit dem Album gelöscht. Speichere es in deiner Zeitleiste, um es zu behalten.",
  "albums.strandedMsg.other":
    "Sie sind nicht in deiner Zeitleiste und werden mit dem Album gelöscht. Speichere sie in deiner Zeitleiste, um sie zu behalten.",
  "albums.savePhotos": "In Zeitleiste speichern",
  "albums.deletePhotosToo": "Fotos mitlöschen",

  // Shared
  "shared.byMe": "Von mir geteilt",
  "shared.withMe": "Mit mir geteilt",
  "shared.flip": "Zwischen von mir geteilt und mit mir geteilt wechseln",
  "shared.emptyByTitle": "Du teilst nichts",
  "shared.emptyWithTitle": "Nichts mit dir geteilt",
  "shared.emptyBySub": "Fotos und Alben, die du teilst, erscheinen hier.",
  "shared.emptyWithSub": "Fotos und Alben, die andere mit dir teilen, erscheinen hier.",
  "shared.publicLink": "Über öffentlichen Link geteilt",
  "shared.album": "Album",
  "shared.manage": "Freigabe verwalten",
  "shared.back": "Zurück zu Geteilt",

  // Share dialog. A public link's URL carries the secret that decrypts what it
  // points at, so copying it whole is the whole point of the link section. A
  // link's password is never read back, so the dialog reports whether one is set
  // rather than showing it.
  "share.title": "Teilen",
  "share.linkTitle": "Öffentlicher Link",
  "share.linkDesc": "Wer den Link hat, kann dieses Foto öffnen.",
  "share.createLink": "Link erstellen",
  "share.copyLink": "Link kopieren",
  "share.copied": "Kopiert",
  "share.removeLink": "Link entfernen",
  "share.passwordLabel": "Passwort",
  "share.passwordSet": "Zum Öffnen erforderlich",
  "share.passwordNone": "Nicht gesetzt",
  "share.passwordPlaceholder": "Neues Passwort",
  "share.expiryLabel": "Läuft ab",
  "share.expiryNever": "Nie",
  "share.expiryPast": "Wähle ein Datum in der Zukunft.",
  "share.add": "Hinzufügen",
  "share.change": "Ändern",
  "share.set": "Festlegen",
  "share.save": "Speichern",
  "share.albumInviteOnly":
    "Alben werden per Einladung geteilt, nicht über einen öffentlichen Link.",
  "share.peopleTitle": "Personen",
  "share.emailPlaceholder": "E-Mail-Adresse",
  "share.invite": "Einladen",
  "share.roleViewer": "Betrachter",
  "share.roleEditor": "Bearbeiter",
  "share.stateInvited": "Eingeladen",
  "share.stateExternal": "Eingeladen (kein Proton-Konto)",
  "share.remove": "Entfernen",
  "share.noPeople": "Noch niemand",
  "share.stopSharing": "Freigabe beenden",
  "share.notOwned":
    "Das wurde mit dir geteilt. Nur wem es gehört, kann ändern, wer darauf zugreifen kann.",
  "share.badEmail": "Das sieht nicht nach einer E-Mail-Adresse aus.",
  "share.copyFailed": "Link konnte nicht kopiert werden",
  "share.failed": "Freigabe konnte nicht geändert werden",
  "share.working": "Wird ausgeführt…",

  // Trash
  "trash.emptyTitle": "Der Papierkorb ist leer",
  "trash.emptySub":
    "Fotos, die du in den Papierkorb verschiebst, erscheinen hier und lassen sich wiederherstellen.",
  "trash.emptyAction": "Papierkorb leeren",
  "trash.moved": "{count} in den Papierkorb verschoben",
  "trash.movedPartial": "{ok} in den Papierkorb verschoben, {failed} fehlgeschlagen",
  "trash.restored": "{count} wiederhergestellt",
  "trash.deleted": "{count} endgültig gelöscht",
  "trash.emptied": "Papierkorb geleert",
  "trash.partial": "{ok} erledigt, {failed} fehlgeschlagen",

  // Photo viewer / lightbox
  "viewer.details": "Details",
  "viewer.offlineAdd": "Offline-Kopie behalten, verschlüsselt in der App",
  "viewer.offlineRemove": "Offline-Kopie entfernen",
  "viewer.download": "In den Ordner Proton Photos herunterladen",
  "viewer.saveToFolder": "Kopie an einem selbst gewählten Ort speichern",
  "viewer.freeUp": "Lokale Kopie entfernen und Speicher freigeben",
  "viewer.detailsShortcut": "Details (I)",
  "viewer.contents": "Inhalt",
  "viewer.contentsShortcut": "Inhalt (L)",
  "viewer.filmstrip": "Benachbarte Elemente",
  "viewer.position": "{n} von {total}",
  "viewer.favoriteShortcut": "Zu Favoriten hinzufügen (F)",
  "viewer.unfavoriteShortcut": "Aus Favoriten entfernen (F)",
  "viewer.trashShortcut": "In den Papierkorb (Del)",
  "viewer.shareShortcut": "Teilen (S)",
  "viewer.rename": "Zum Umbenennen klicken",
  "viewer.closeShortcut": "Schließen (Esc)",
  "viewer.prev": "Vorheriges (←)",
  "viewer.next": "Nächstes (→)",
  "viewer.name": "Name",
  "viewer.type": "Typ",
  "viewer.dimensions": "Abmessungen",
  "viewer.taken": "Aufgenommen",
  "viewer.added": "Hinzugefügt",
  "viewer.modified": "Geändert",
  "viewer.size": "Größe",
  "viewer.onServer": "Belegter Speicher",
  "viewer.albums": "Alben",
  "viewer.shared": "Geteilt",
  "viewer.sharedPublic": "Öffentlicher Link",
  "viewer.sharedPeople": "Mit Personen",
  "viewer.sharedNo": "Nein",
  "viewer.unverified": " (nicht verifiziert)",
  "viewer.trashFailed": "Dieses Foto konnte nicht in den Papierkorb verschoben werden.",
  "viewer.favoriteFailed": "Favoriten konnten nicht aktualisiert werden.",
  "viewer.downloadFailed": "Dieses Foto konnte nicht heruntergeladen werden.",
  "viewer.zoomOut": "Verkleinern",
  "viewer.zoomIn": "Vergrößern",
  "viewer.resetFit": "An Fenster anpassen",
  "viewer.videoLoading": "Video wird geladen…",
  "viewer.videoError":
    "Dieses Videoformat kann hier nicht abgespielt werden. Lade es herunter und sieh es dir in einem anderen Player an.",
  "viewer.videoTooLarge":
    "Dieses Video ist zu groß, um hier abgespielt zu werden. Lade es herunter und sieh es dir in einem anderen Player an.",

  // The viewer's own video controls, which stand in for the browser's.
  "viewer.videoPlay": "Abspielen (Leertaste)",
  "viewer.videoPause": "Pause (Leertaste)",
  "viewer.videoStepBack": "Vorheriges Bild",
  "viewer.videoStepForward": "Nächstes Bild",
  "viewer.videoSeek": "Wiedergabeposition",
  "viewer.videoMute": "Stummschalten",
  "viewer.videoUnmute": "Stummschaltung aufheben",

  // Local file viewer: a file opened from File Explorer, which the app can show
  // with nobody signed in. Everything both viewers say alike comes from above.
  "local.camera": "Kamera",
  "local.created": "Erstellt",
  "local.path": "Speicherort",
  "local.upload": "Zu Proton hochladen",
  "local.uploadUnsupported": "Proton nimmt diesen Dateityp nicht an",
  "local.uploading": "Wird hochgeladen…",
  "local.uploaded": "Bei Proton gespeichert",
  "local.uploadSkipped": "Bereits gespeichert",
  "local.uploadFailed": "Hochladen fehlgeschlagen. Versuche es erneut.",
  "local.delete": "Löschen",
  "local.deleteTitle": "Datei löschen?",
  "local.deleteMessage": "„{name}“ wird in den Papierkorb verschoben.",
  "local.notFound": "Diese Datei wurde verschoben oder gelöscht.",
  "local.unreadable":
    "Diese Datei konnte nicht gelesen werden. Vielleicht ist sie in einem anderen Programm geöffnet oder für dieses Konto nicht erreichbar.",
  "local.openFailed": "Diese Datei konnte nicht geöffnet werden.",
  "local.decodeFailed":
    "Dieses Foto konnte nicht gelesen werden. Die Datei ist möglicherweise beschädigt oder unvollständig.",
  "local.videoUnsupported":
    "Dieses Videoformat kann hier nicht abgespielt werden. Öffne es in einem anderen Player.",
  "local.noCodec":
    "Windows hat keinen Decoder für dieses Format, deshalb kann es hier nicht angezeigt werden. Im Microsoft Store gibt es für einige davon das Fehlende: die HEIF- und HEVC-Erweiterungen für HEIC-Fotos und die Raw Image Extension für Rohdateien aus Kameras.",
  "local.signInTitle": "Zum Hochladen anmelden",
  "local.signInBody": "Das App-Fenster öffnet sich zum Anmelden. Diese Datei bleibt hier geöffnet.",
  "local.signInAction": "Anmelden",

  // Upload panel
  "upload.title": "Upload",
  "upload.filterName": "Fotos und Videos",
  "upload.dropHint": "Lege Fotos oder einen Ordner irgendwo auf dem Fenster ab",
  "upload.dropSub":
    "Fotos gehen direkt in deine Zeitleiste. Ein Ordner wird zu einem Album mit demselben Namen.",
  "upload.chooseFiles": "Dateien auswählen",
  "upload.chooseFolder": "Ordner auswählen",
  "upload.importTitle": "Aus Google Fotos oder Ente importieren",
  "upload.importSub": "Übernimmt Datum, Ort und Favoriten jedes Fotos aus dem Export und macht seine Alben zu Alben.",
  "upload.importZip": "Zip-Dateien auswählen",
  "upload.importFolder": "Exportordner auswählen",
  "upload.zipFilterName": "Zip-Archive",
  "upload.importUnpacking": "Entpacke Teil {part} von {parts}: {done} von {total}",
  "upload.importReading": "Export wird gelesen…",
  "importReview.title": "Import prüfen",
  "importReview.hint": "Klicke auf ein Foto, um es auszulassen, und noch einmal, um es zurückzuholen. Umschalt+Klick macht das für alle Fotos zwischen dem zuletzt angeklickten und diesem.",
  "importReview.discard": "Verwerfen",
  "importReview.statItems": "Elemente: {n}",
  "importReview.statAlbums": "Alben: {n}",
  "importReview.statLive": "Live Photos: {n}",
  "importReview.checking": "Suche nach schon vorhandenen: {done} / {total}",
  "importReview.statAlready": "Schon in deiner Bibliothek: {n}",
  "importReview.albumsToggle": "Alben anlegen",
  "importReview.timeline": "Zeitleiste",
  "importReview.confirm": "Importieren ({n})",
  "importReview.alreadyBadge": "Vorhanden",
  "importReview.noDate": "Kein Datum",
  "importReview.liveJoined": "Foto und Video werden zusammen als ein Live Photo hochgeladen",
  "upload.alreadyThere": "{count} bereits vorhanden",
  "upload.failedCount": "{count} fehlgeschlagen",
  "upload.showingRows": "{shown} von {total} Dateien: alle Fehler, was gerade hochlädt, und die neuesten.",
  "upload.clear": "Leeren",
  "upload.statusUploading": "wird hochgeladen…",
  "upload.statusSkipped": "übersprungen",
  "upload.statusQueued": "in Warteschlange",
  "upload.statusFailed": "fehlgeschlagen",

  // Grid tile
  "grid.select": "Auswählen",
  "grid.deselect": "Abwählen",

  // Selection bar
  "selection.cancel": "Auswahl abbrechen (Esc)",
  "selection.count.one": "{count} Foto ausgewählt",
  "selection.count.other": "{count} Fotos ausgewählt",
  "selection.trash": "Papierkorb",
  "selection.restore": "Wiederherstellen",
  "selection.deleteForever": "Endgültig löschen",
  "selection.more": "Mehr",
  "selection.download": "Herunterladen",
  "selection.showInFolder": "Im Ordner anzeigen",
  "selection.freeUp": "Freigeben",
  "selection.addToAlbum": "Zum Album hinzufügen",
  "selection.removeFromAlbum": "Aus Album entfernen",
  "selection.setCover": "Als Titelbild festlegen",
  "selection.rename": "Umbenennen",
  "selection.share": "Teilen",
  "selection.favorite": "Zu Favoriten hinzufügen",
  "selection.unfavorite": "Aus Favoriten entfernen",
  "selection.offlineAdd": "Offline verfügbar",
  "selection.offlineRemove": "Offline-Kopie entfernen",
  // Download: the copy that lands in the Proton Photos folder, where Windows and any
  // other program can read it. Never called offline, which is the app's own copy.
  "download.freedUp": "{count} freigegeben",
  "download.freedUpNone": "Es wurde nichts freigegeben",
  "download.notDownloaded": "Keine heruntergeladenen Dateien zum Freigeben",
  "download.running": "Wird heruntergeladen…",
  "download.progress": "Wird heruntergeladen {done}/{total}…",
  "download.done": "{count} in den Ordner Proton Photos heruntergeladen",
  "download.donePartial": "{ok} von {total} heruntergeladen",
  "download.doneNone":
    "Es wurde nichts heruntergeladen. Der Ordner Proton Photos ist möglicherweise noch nicht bereit.",
  "download.alreadyDownloaded": "Bereits heruntergeladen",
  "download.saved": "{count} im Ordner gespeichert",
  "download.partial": "{ok} gespeichert, {failed} fehlgeschlagen",

  // Available offline: the app's own encrypted copy, which is not the Proton Photos
  // folder. These say where the copy went, so the two are never mistaken for one another.
  "offline.added.one": "{count} Foto wird für die Offline-Nutzung gespeichert",
  "offline.added.other": "{count} Fotos werden für die Offline-Nutzung gespeichert",
  "offline.removed.one": "{count} Offline-Kopie entfernt",
  "offline.removed.other": "{count} Offline-Kopien entfernt",
  "offline.alreadyOffline": "Bereits offline verfügbar",
  "offline.noneOffline": "Keine Offline-Kopien zum Entfernen",
  "offline.failed": "konnte nicht für die Offline-Nutzung gespeichert werden",

  // Trash confirmation
  "confirm.trashTitle": "In den Papierkorb verschieben?",
  "confirm.trashConfirm": "In den Papierkorb verschieben",
  "confirm.trashCount.one":
    "{count} Foto wird in den Papierkorb verschoben. Du kannst es im Tab Papierkorb wiederherstellen.",
  "confirm.trashCount.other":
    "{count} Fotos werden in den Papierkorb verschoben. Du kannst sie im Tab Papierkorb wiederherstellen.",
  "confirm.trashName":
    '"{name}" wird in den Papierkorb verschoben. Du kannst es im Tab Papierkorb wiederherstellen.',
  "confirm.thisPhoto": "Dieses Foto",

  // Remove from album. The photos stay in Photos; only the album loses them.
  "confirm.removeTitle": "Aus dem Album entfernen?",
  "confirm.removeConfirm": "Entfernen",
  "confirm.removeCount.one":
    "{count} Foto wird aus diesem Album genommen und bleibt in deiner Zeitleiste erhalten.",
  "confirm.removeCount.other":
    "{count} Fotos werden aus diesem Album genommen und bleiben in deiner Zeitleiste erhalten.",

  // Delete-forever confirmation. Nothing in the app or at Proton undoes these.
  "confirm.deleteTitle": "Endgültig löschen?",
  "confirm.deleteConfirm": "Endgültig löschen",
  "confirm.deleteCount.one":
    "{count} Foto wird endgültig von Proton gelöscht. Das lässt sich nicht rückgängig machen.",
  "confirm.deleteCount.other":
    "{count} Fotos werden endgültig von Proton gelöscht. Das lässt sich nicht rückgängig machen.",
  "confirm.emptyTitle": "Papierkorb leeren?",
  "confirm.emptyConfirm": "Alles löschen",
  "confirm.emptyMessage":
    "Alles im Papierkorb wird endgültig von Proton gelöscht. Das lässt sich nicht rückgängig machen.",

  // Deleting an album skips the trash, so the album is gone for good even though
  // the photos in your timeline are not.
  "confirm.deleteAlbumTitle": "Dieses Album löschen?",
  "confirm.deleteAlbumMessage":
    "Das Album wird gelöscht und lässt sich nicht wiederherstellen. Fotos in deiner Zeitleiste bleiben erhalten.",

  // Revoking sharing takes access away from people who may already hold the link,
  // and nothing is deleted by it, so both of these say exactly what is lost.
  "confirm.removeLinkTitle": "Link entfernen?",
  "confirm.removeLinkMessage":
    "Der Link funktioniert für alle nicht mehr, die ihn haben. Per E-Mail eingeladene Personen behalten ihren Zugriff.",
  "confirm.removeLinkConfirm": "Link entfernen",
  "confirm.replaceLinkTitle": "Link ersetzen?",
  "confirm.replaceLinkMessage":
    "Dieser Link ist zu alt, um geändert zu werden. Beim Speichern wird er durch einen neuen unter einer anderen Adresse ersetzt. Der alte Link funktioniert für alle nicht mehr, die ihn haben, und sein Passwort wird entfernt. Der neue Link landet in deiner Zwischenablage.",
  "confirm.replaceLinkConfirm": "Link ersetzen",
  "confirm.stopSharingTitle": "Freigabe beenden?",
  "confirm.stopSharingMessage":
    "Der Link funktioniert nicht mehr und alle Eingeladenen verlieren ihren Zugriff. Es wird nichts gelöscht.",
  "confirm.stopSharingConfirm": "Freigabe beenden",

  // Freeing up drops the downloaded copies only. Nothing leaves Proton, so this asks
  // before a big change without treating it as one there is no way back from.
  "confirm.freeUpAllTitle": "Alle heruntergeladenen Fotos freigeben?",
  "confirm.freeUpAllMessage":
    "Die {size} im Ordner Proton Photos werden entfernt. Deine Fotos bleiben bei Proton und werden wieder heruntergeladen, sobald du sie öffnest.",
  "confirm.freeUpAllConfirm": "Freigeben",

  // Removing every offline copy. The photos themselves are untouched, so this warns
  // about the download they will need next time and nothing more.
  "confirm.removeOfflineAllTitle": "Alle Offline-Kopien entfernen?",
  "confirm.removeOfflineAllMessage":
    "Die {size}, die verschlüsselt in der App gespeichert sind, werden entfernt. Deine Fotos bleiben bei Proton, und zum erneuten Öffnen wird eine Verbindung benötigt.",
  "confirm.removeOfflineAllConfirm": "Entfernen",
  // Photo editor
  "editor.edit": "Bearbeiten",
  "editor.title": "Foto bearbeiten",
  "editor.cancel": "Abbrechen",
  "editor.undo": "Rückgängig",
  "editor.redo": "Wiederholen",
  "editor.save": "Speichern",
  "editor.saving": "Wird gespeichert…",
  "editor.saved": "Kopie gespeichert",
  "editor.saveFailed": "Das bearbeitete Foto konnte nicht gespeichert werden",
  "editor.loadFailed": "Dieses Foto konnte nicht zum Bearbeiten geöffnet werden",
  "editor.tool.adjust": "Anpassen",
  "editor.tool.filters": "Filter",
  "editor.tool.crop": "Zuschneiden",
  "editor.tool.redact": "Schwärzen",
  "editor.tool.rotate": "Drehen",
  "editor.adj.brightness": "Helligkeit",
  "editor.adj.contrast": "Kontrast",
  "editor.adj.saturation": "Sättigung",
  "editor.adj.exposure": "Belichtung",
  "editor.adj.highlights": "Lichter",
  "editor.adj.shadows": "Schatten",
  "editor.adj.temperature": "Temperatur",
  "editor.adj.tone": "Farbton",
  "editor.filter.none": "Original",
  "editor.filter.bw": "S/W",
  "editor.filter.sepia": "Sepia",
  "editor.filter.vintage": "Vintage",
  "editor.filter.vivid": "Lebendig",
  "editor.filter.cool": "Kühl",
  "editor.filter.warm": "Warm",
  "editor.crop.free": "Frei",
  "editor.crop.original": "Original",
  "editor.redact.black": "Schwärzen",
  "editor.redact.pixelate": "Verpixeln",
  "editor.redact.brush": "Pinselgröße",
  "editor.redact.undoStroke": "Letzten rückgängig",
  "editor.redact.clear": "Löschen",
  "editor.rotate": "Nach rechts drehen",
  "editor.flipH": "Horizontal spiegeln",
  "editor.flipV": "Vertikal spiegeln",
  "editor.discardTitle": "Änderungen verwerfen?",
  "editor.discardBody": "Deine Änderungen werden nicht gespeichert.",
  "editor.discardConfirm": "Verwerfen",
};
