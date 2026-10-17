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

// Italian (it) strings. Keys mirror en.ts exactly.
export const it: Record<string, string> = {
  // Common
  "common.cancel": "Annulla",
  "common.close": "Chiudi",
  "common.back": "Indietro",
  "common.loading": "Caricamento…",
  "common.photoCount.one": "{count} foto",
  "common.photoCount.other": "{count} foto",

  // Navigation
  "nav.photos": "Foto",
  "nav.albums": "Album",
  "nav.shared": "Condivisi",
  "nav.trash": "Cestino",

  "settings.sidebarLayout": "Barra laterale",
  "settings.sidebarLayoutDesc": "Sposta la navigazione e il tuo profilo in una barra laterale comprimibile a sinistra. Sperimentale e ancora in perfezionamento.",
  "sidebar.collapse": "Comprimi",
  "sidebar.expand": "Espandi",
  "sidebar.showAlbums": "Mostra album",
  "sidebar.hideAlbums": "Nascondi album",
  "sidebar.downloading": "Scaricamento",
  "sidebar.indexing": "Indicizzazione",
  "sidebar.dropHint": "o trascina qui i file",

  // App shell
  "app.restoring": "Ripristino della sessione…",
  "update.available": "L'aggiornamento {version} è disponibile",
  "update.now": "Aggiorna",
  "update.updating": "Aggiornamento…",
  "update.failed": "Aggiornamento non riuscito",
  "update.hashError": "Verifica del download non riuscita",
  "menu.reload": "Ricarica",
  "menu.moreSoon": "Altro in arrivo…",
  "menu.quit": "Esci",

  // Tray popup
  "tray.open": "Apri Photos for Proton",
  "tray.syncNow": "Sincronizza ora",
  "tray.syncing": "Sincronizzazione…",
  "tray.synced": "Tutto aggiornato",
  "tray.locked": "Bloccato",
  "tray.lockedHint": "Apri per sbloccare",
  "tray.signedOut": "Accesso non effettuato",
  "tray.signedOutHint": "Apri per accedere",

  // Login
  "login.subtitle": "Accedi al tuo account Proton",
  "login.emailLabel": "Email o nome utente",
  "login.passwordLabel": "Password",
  "login.passwordPlaceholder": "Password",
  "login.signIn": "Accedi",
  "login.signingIn": "Accesso in corso…",
  "login.twofaLabel": "Codice a due fattori",
  "login.verify": "Verifica",
  "login.verifying": "Verifica in corso…",
  "login.captchaHint": "Proton ti chiede di confermare di essere una persona reale.",
  "login.captchaExpired": "Il captcha è scaduto. Risolvilo di nuovo.",
  "login.withBrowser": "Accedi dal browser",
  "login.withBrowserHint": "Accedi sulla pagina di Proton. La tua password non arriva mai a questa app.",
  "login.withPassword": "Accedi invece con email e password",
  "login.or": "oppure con email e password",
  "login.browserWaiting": "Completa l'accesso nel browser. Questa finestra prosegue da sola.",
  "login.browserOpenAgain": "Apri di nuovo la pagina",
  "login.browserCopy": "Copia il link",
  "login.browserCopied": "Link copiato",
  "login.browserNotOpened": "Il browser non si è aperto. Copia il link e aprilo tu.",
  "login.browserTimeout": "L'accesso ha richiesto troppo tempo. Riprova.",
  "login.sessionEnded": "La tua sessione è terminata. Accedi di nuovo.",
  "login.unofficial": "Questa è un'applicazione di terze parti non supportata ufficialmente da Proton.",
  "protect.intro": "Come deve mantenere l'accesso questo computer?",
  "protect.password": "Con una mia password",
  "protect.passwordDesc": "Richiesta a ogni avvio dell'app. Può essere qualsiasi, non è la tua password di Proton.",
  "protect.newPassword": "Password per questa app",
  "protect.repeatPassword": "Ripeti la password",
  "protect.device": "Senza password",
  "protect.deviceDesc": "L'app si apre subito. La protegge il tuo account Windows: chi può accedervi può aprire anche l'app.",
  "protect.continue": "Continua",
  "protect.tooShort": "Usa almeno {n} caratteri.",
  "protect.mismatch": "Le due password non coincidono.",

  // Lock screen (returning cold start)
  "lock.subtitle": "Inserisci la password per sbloccare",
  "lock.unlock": "Sblocca",
  "lock.unlocking": "Sblocco in corso…",
  "lock.wrongPassword": "Password errata",
  "lock.failed": "Sblocco non riuscito. Riprova.",
  "lock.differentAccount": "Usa un altro account",

  // Titlebar
  "titlebar.minimize": "Riduci a icona",
  "titlebar.maximize": "Ingrandisci",

  // Settings
  "settings.title": "Impostazioni",
  "settings.general": "Generale",
  "settings.launchAtLogin": "Avvia con Windows",
  "settings.launchAtLoginDesc": "Si avvia in background all'accesso a Windows e mostra solo l'icona nell'area di notifica finché non la apri.",
  "settings.launchAtLoginLinux": "Avvia all'accesso",
  "settings.launchAtLoginLinuxDesc": "Apre Photos for Proton quando accedi al computer.",
  "settings.keepRunning": "Resta attivo dopo la chiusura",
  "settings.keepRunningDesc":
    "Chiudendo la finestra Photos for Proton resta attivo, così Proton Photos in File continua a funzionare. Riaprilo dalle applicazioni; per uscire usa il menu dell'account.",
  "settings.appearance": "Aspetto",
  "settings.theme": "Tema",
  "settings.themeDesc": "Sistema segue Windows e continua a seguirlo quando cambia.",
  "settings.theme.dark": "Scuro",
  "settings.theme.light": "Chiaro",
  "settings.theme.system": "Sistema",
  "settings.palette": "Tavolozza",
  "settings.paletteDesc": "Colore principale usato in tutta l'app.",
  "settings.palette.default": "Predefinita",
  "settings.palette.forest": "Foresta",
  "settings.palette.sunset": "Tramonto",
  "settings.palette.sea": "Mare",
  "settings.palette.sepia": "Seppia",
  "settings.palette.mono": "Mono",
  "settings.palette.amoled": "Nero puro (AMOLED)",
  "settings.language": "Lingua",
  "settings.languageDesc": "Scegli la lingua dell'interfaccia.",
  "settings.timeline": "Sequenza",
  "settings.hideAlbum": "Nascondi le foto negli album Drive",
  "settings.hideAlbumDesc":
    "Le foto aggiunte a un album Drive non appariranno nella tua sequenza principale. Restano visibili nelle schede Album e Condivisi e nei filtri per categoria.",
  "settings.security": "Sicurezza",
  "settings.about": "Informazioni",
  "settings.checkUpdates": "Controlla aggiornamenti",
  "settings.upToDate": "Sei aggiornato",
  "settings.website": "Sito web",
  "settings.sourceCode": "Codice sorgente",
  "settings.authorRole": "Creatore e manutentore",
  "settings.support": "Offrimi un caffè",
  "settings.supportDesc": "Sostieni l'app e il suo sviluppo",
  "settings.lockOnHide": "Richiedi la password alla riapertura dall'area di notifica",
  "settings.deviceProtected": "Protetta dal tuo account Windows",
  "settings.deviceProtectedDesc": "Questa app si apre senza password. Per usarne una, esci e accedi di nuovo.",
  "settings.debug": "Overlay di debug",
  "settings.debugDesc": "Mostra un HUD della memoria in tempo reale (dimensioni di heap e cache).",
  "settings.explorer": "Esplora file",
  "settings.showInExplorer": 'Mostra "Proton Photos" in Esplora file',
  "settings.showInExplorerDesc":
    "Aggiunge una voce Proton Photos alla barra laterale di Esplora file con le tue foto del cloud. Ha effetto dopo un riavvio.",
  "settings.autoDownload": "Scarica automaticamente le nuove foto",
  "settings.autoDownloadDesc":
    "Man mano che nuove foto vengono aggiunte alla tua libreria, vengono scaricate automaticamente nella cartella Proton Photos.",
  "settings.autoDownloadNeedsExplorer":
    'Funziona solo con "Proton Photos" in Esplora file, che è disattivato. Il download funziona comunque: ti viene chiesto dove salvare le foto.',
  "settings.restartNeeded": "Riavvia per applicare questa modifica.",
  "settings.restartNow": "Riavvia ora",
  "settings.filesDrive": "Gestore file",
  "settings.filesDriveShow": 'Mostra "Proton Photos" in File',
  "settings.filesDriveShowDesc":
    "Aggiunge Proton Photos alla barra laterale di File e degli altri gestori di file. Da lì puoi aprire e copiare le tue foto, e trascinarvi foto o cartelle per caricarle: una cartella diventa un album, oppure finisce nella cronologia se la trascini in Photos. Funziona mentre l'app è in esecuzione e sbloccata.",
  "settings.filesDriveAddress": "Indirizzo",
  "settings.filesDriveAddressDesc":
    "Per un gestore di file senza la voce nella barra laterale: connettiti a questo indirizzo. In Dolphin usa webdav:// al posto di dav://.",
  "settings.filesDriveCopy": "Copia",
  "settings.filesDriveCopied": "Copiato",
  "settings.filesDriveEdits": "Consenti eliminazione e rinomina",
  "settings.filesDriveEditsDesc":
    "Una foto eliminata in Photos va nel cestino di Proton, da cui si può ripristinare per 30 giorni. Eliminata nella cartella di un album, esce solo da quell'album; eliminare la cartella di un album elimina l'album e ne conserva le foto. Da File non si può eliminare nulla in Trash.",
  "settings.filesDriveByDate": "Dividi Photos per anno e mese",
  "settings.filesDriveByDateDesc":
    "Mostra Photos come cartelle per anno e mese invece di un unico lungo elenco.",
  "settings.filesDriveServer": "Indirizzo e porta",
  "settings.filesDriveServerDesc":
    "Dove l'unità è in ascolto su questo computer: localhost o un indirizzo da 127.0.0.1 a 127.255.255.254. Lascia la porta vuota per usarne una libera. Non è mai in ascolto sulla tua rete.",
  "settings.filesDriveAutoPort": "auto",
  "settings.filesDriveApply": "Applica",
  "settings.filesDriveErrAddress": "Usa localhost o un indirizzo che inizia con 127.",
  "settings.filesDriveErrPort": "Usa una porta da 1024 a 65535, oppure lasciala vuota.",
  "settings.filesDriveErrInUse": "Quella porta è già in uso. L'unità resta dov'era.",
  "settings.filesDrivePortTaken":
    "La porta scelta era occupata all'avvio dell'app, quindi se ne usa un'altra finché non si libera.",
  // File types. The "Open with" entries are the app's own to add and take back out;
  // the default handler is not, so that half leads out to Windows rather than
  // pretending to a choice Windows takes from the user alone.
  "settings.fileTypes": "Tipi di file",
  "settings.openWith": 'Aggiungi alla lista "Apri con"',
  "settings.openWithDesc":
    'Elenca Photos for Proton nel menu "Apri con" di Windows per le foto JPEG, PNG, GIF, WebP, AVIF, BMP, TIFF e HEIC e per i video MP4, MOV, M4V e WebM. Disattivandolo, le voci vengono rimosse.',
  "settings.fileTypesFailed": "Impossibile modificare i tipi di file. Riprova.",
  "settings.defaultApp": "App predefinita per foto e video",
  "settings.defaultAppDesc":
    "Così niente diventa predefinito: Windows accetta questa scelta solo da te, mai da un programma. Scegli Photos for Proton nelle impostazioni di Windows, in App predefinite.",
  "settings.defaultAppOpen": "Apri le impostazioni di Windows",
  "settings.defaultAppFailed": "Impossibile aprire le impostazioni di Windows. Riprova.",
  "settings.lockOnHideDesc":
    "Quando la finestra viene chiusa nell'area di notifica, l'app si blocca e chiede la password alla successiva apertura.",
  "settings.storage": "Spazio",
  // Two different places a photo can be kept on this machine: encrypted inside the
  // app, or downloaded into the Proton Photos folder where Windows can read it. The
  // panel names both rather than adding one number to the other.
  "settings.downloadedCount.one": "{count} foto scaricata",
  "settings.downloadedCount.other": "{count} foto scaricate",
  "settings.downloadedNone": "Nessuna foto scaricata",
  "settings.downloadedDesc":
    "Le foto scaricate sono file ordinari nella cartella Proton Photos, quindi la ricerca di Windows e altri programmi possono leggerle. Liberare spazio rimuove solo queste copie locali e le tue foto restano su Proton.",
  "settings.freeUpAll": "Libera {size}",
  "settings.freeUpNothing": "Niente da liberare",
  "settings.freeingUp": "Liberazione in corso…",
  "settings.storageOffline": "Foto offline",
  "settings.storageExplorer": "In Esplora file",
  "settings.offlineCount.one": "{count} foto nell'app",
  "settings.offlineCount.other": "{count} foto nell'app",
  "settings.offlineNone": "Nessuna foto nell'app",
  "settings.offlineDesc":
    "Le foto che segni come disponibili offline restano cifrate dentro l'app. Si aprono senza connessione e non compaiono mai nella cartella Proton Photos, quindi nulla fuori dall'app può leggerle.",
  "settings.offlineSaving": "Salvataggio {done}/{total}…",
  "settings.offlineRemoveAll": "Libera {size}",
  "settings.offlineRemoveNothing": "Niente da liberare",
  "settings.offlineRemoving": "Rimozione in corso…",
  "settings.freeUpFailed": "Impossibile liberare lo spazio. Riprova.",

  // Profile menu
  "profile.storage": "Spazio",
  "profile.used": "{size} usati",
  "profile.total": "{size} totali",
  "profile.signOut": "Disconnetti",

  // Avatar
  "avatar.uploading": "Caricamento",
  "avatar.syncing": "Sincronizzazione",
  "avatar.account": "Account e impostazioni",
  "avatar.showUploads": "Mostra caricamenti",

  // Photos view
  "photos.all": "Tutte",
  "photos.search": "Cerca",
  "photos.searchPlaceholder": "Cerca per nome file o tipo…",
  "photos.closeSearch": "Chiudi ricerca",
  "photos.indexing": "Indicizzazione {done}/{total}",
  "photos.uploadTitle": "Carica foto o una cartella come album",
  "photos.uploadingProgress": "Caricamento {progress}",
  "photos.noMatches": "Nessun risultato",
  "photos.noPhotos": "Ancora nessuna foto",
  "photos.noPhotosSub": "Le tue foto appariranno qui dopo la sincronizzazione.",
  "photos.stillIndexing": "Indicizzazione in corso, appariranno altri risultati.",
  "photos.dropTitle": "Rilascia per caricare",
  "photos.dropSub": "Una cartella diventa un album con lo stesso nome",
  "photos.offline": "Disponibile offline, cifrata nell'app",
  "photos.downloaded": "Scaricata nella cartella Proton Photos",
  "photos.renameTitle": "Rinomina la foto",
  "photos.namePlaceholder": "Nome del file",

  // Tile badges
  "badge.motionPhoto": "Foto in movimento",
  "badge.panorama": "Panorama",
  "badge.raw": "RAW",
  "badge.favorite": "Preferito",

  // Search type filters
  "filter.images": "Immagini",
  "filter.videos": "Video",

  // Filter panel
  "filter.title": "Filtro",
  "filter.categories": "Categorie",
  "filter.type": "Tipo",
  "filter.mediaAll": "Tutti",
  "filter.mediaPhotos": "Foto",
  "filter.reset": "Reimposta",

  // Categories
  "category.fav": "Preferiti",
  "category.screen": "Screenshot",
  "category.video": "Video",
  "category.live": "Live Photos",
  "category.selfie": "Selfie",
  "category.portrait": "Ritratti",
  "category.burst": "Scatti continui",
  "category.pano": "Panorami",
  "category.raw": "RAW",

  // Albums
  "albums.backToAlbums": "Torna agli album",
  "albums.untitled": "Album senza titolo",
  "albums.empty": "Questo album è vuoto",
  "albums.none": "Ancora nessun album",
  "albums.noneSub": "Creane uno qui, o trascina una cartella sulla finestra.",
  "albums.keepDownloaded": "Scarica questo album nella cartella Proton Photos",
  "albums.keptDownloaded": "Scaricamento nella cartella Proton Photos (clicca per interrompere)",
  "albums.freeUpTitle": "Liberare lo spazio di questo album?",
  "albums.freeUpCount.one":
    "L'album non si scarica più da solo. {count} foto è già nella cartella Proton Photos e può restare, oppure puoi liberare lo spazio che occupa. In entrambi i casi resta su Proton.",
  "albums.freeUpCount.other":
    "L'album non si scarica più da solo. {count} foto sono già nella cartella Proton Photos e possono restare, oppure puoi liberare lo spazio che occupano. In entrambi i casi restano su Proton.",
  "albums.freeUpKeep": "Mantieni scaricate",
  "albums.freeUpConfirm": "Libera",
  "albums.newAlbum": "Nuovo album",
  "albums.searchHint": "Cerca album",
  "albums.searchEmpty": "Nessun album corrisponde alla ricerca",
  "albums.sortName": "Nome (A-Z)",
  "albums.sortActivity": "Ultima attività",
  "albums.sortCount": "Numero di foto",
  "albums.pin": "Fissa",
  "albums.unpin": "Rimuovi",
  "albums.pinLimit": "Puoi fissare fino a 5 album",
  "albums.newTitle": "Dai un nome all'album",
  "albums.namePlaceholder": "Nome dell'album",
  "albums.create": "Crea",
  "albums.createAndAdd": "Crea e aggiungi",
  "albums.rename": "Rinomina",
  "albums.renameTitle": "Rinomina l'album",
  "albums.share": "Condividi album",
  "albums.delete": "Elimina album",
  "albums.more": "Altro",
  "albums.addPhotos": "Aggiungi foto",
  "albums.addFromLibrary": "Dalla tua libreria",
  "albums.addFromComputer": "Da questo computer",
  "albums.deleted": "Album eliminato",
  "albums.addTitle": "Aggiungi all'album",
  "albums.addCount.one": "Scegli dove mettere {count} foto.",
  "albums.addCount.other": "Scegli dove mettere {count} foto.",
  "albums.added": "{count} aggiunte",
  "albums.addPartial": "Aggiunte {ok}, {failed} non riuscite",
  "albums.removed": "{count} rimosse dall'album",
  "albums.removePartial": "Rimosse {ok}, {failed} non riuscite",
  "albums.coverSet": "Copertina aggiornata",
  "albums.strandedTitle.one": "{count} foto è solo in questo album",
  "albums.strandedTitle.other": "{count} foto sono solo in questo album",
  "albums.strandedMsg.one":
    "Non è nella tua sequenza, quindi eliminando l'album viene eliminata anche lei. Salvala nella tua sequenza per tenerla.",
  "albums.strandedMsg.other":
    "Non sono nella tua sequenza, quindi eliminando l'album vengono eliminate anche loro. Salvale nella tua sequenza per tenerle.",
  "albums.savePhotos": "Salva nella sequenza",
  "albums.deletePhotosToo": "Elimina anche le foto",

  // Shared
  "shared.byMe": "Condivisi da me",
  "shared.withMe": "Condivisi con me",
  "shared.flip": "Passa da condivisi da me a condivisi con me",
  "shared.emptyByTitle": "Non stai condividendo nulla",
  "shared.emptyWithTitle": "Nulla condiviso con te",
  "shared.emptyBySub": "Le foto e gli album che condividi appariranno qui.",
  "shared.emptyWithSub": "Le foto e gli album che altri condividono con te appariranno qui.",
  "shared.publicLink": "Condivisi tramite link pubblico",
  "shared.album": "Album",
  "shared.manage": "Gestisci la condivisione",
  "shared.back": "Torna ai condivisi",

  // Share dialog. A public link's URL carries the secret that decrypts what it
  // points at, so copying it whole is the whole point of the link section. A
  // link's password is never read back, so the dialog reports whether one is set
  // rather than showing it.
  "share.title": "Condividi",
  "share.linkTitle": "Link pubblico",
  "share.linkDesc": "Chiunque abbia il link può aprire questa foto.",
  "share.createLink": "Crea link",
  "share.copyLink": "Copia link",
  "share.copied": "Copiato",
  "share.removeLink": "Rimuovi link",
  "share.passwordLabel": "Password",
  "share.passwordSet": "Richiesta per aprire",
  "share.passwordNone": "Non impostata",
  "share.passwordPlaceholder": "Nuova password",
  "share.expiryLabel": "Scadenza",
  "share.expiryNever": "Mai",
  "share.expiryPast": "Scegli una data futura.",
  "share.add": "Aggiungi",
  "share.change": "Modifica",
  "share.set": "Imposta",
  "share.save": "Salva",
  "share.albumInviteOnly": "Gli album si condividono su invito, non con un link pubblico.",
  "share.peopleTitle": "Persone",
  "share.emailPlaceholder": "Indirizzo email",
  "share.invite": "Invita",
  "share.roleViewer": "Lettore",
  "share.roleEditor": "Editor",
  "share.stateInvited": "Invitato",
  "share.stateExternal": "Invitato (senza account Proton)",
  "share.remove": "Rimuovi",
  "share.noPeople": "Ancora nessuno",
  "share.stopSharing": "Interrompi la condivisione",
  "share.notOwned":
    "Questo è stato condiviso con te. Solo chi lo possiede può cambiare chi può accedervi.",
  "share.badEmail": "Questo non sembra un indirizzo email.",
  "share.copyFailed": "Impossibile copiare il link",
  "share.failed": "Impossibile aggiornare la condivisione",
  "share.working": "In corso…",

  // Trash
  "trash.emptyTitle": "Il cestino è vuoto",
  "trash.emptySub": "Le foto che sposti nel cestino compaiono qui e puoi ripristinarle.",
  "trash.emptyAction": "Svuota cestino",
  "trash.moved": "{count} spostate nel cestino",
  "trash.movedPartial": "{ok} spostate nel cestino, {failed} non riuscite",
  "trash.restored": "{count} ripristinate",
  "trash.deleted": "{count} eliminate definitivamente",
  "trash.emptied": "Cestino svuotato",
  "trash.partial": "Completate {ok}, {failed} non riuscite",

  // Photo viewer / lightbox
  "viewer.details": "Dettagli",
  "viewer.offlineAdd": "Conserva una copia offline, cifrata nell'app",
  "viewer.offlineRemove": "Rimuovi la copia offline",
  "viewer.download": "Scarica nella cartella Proton Photos",
  "viewer.saveToFolder": "Salva una copia dove preferisci",
  "viewer.freeUp": "Rimuovi la copia locale per liberare spazio",
  "viewer.detailsShortcut": "Dettagli (I)",
  "viewer.contents": "Contenuto",
  "viewer.contentsShortcut": "Contenuto (L)",
  "viewer.filmstrip": "Elementi vicini",
  "viewer.position": "{n} di {total}",
  "viewer.favoriteShortcut": "Aggiungi ai preferiti (F)",
  "viewer.unfavoriteShortcut": "Rimuovi dai preferiti (F)",
  "viewer.trashShortcut": "Sposta nel cestino (Del)",
  "viewer.shareShortcut": "Condividi (S)",
  "viewer.rename": "Clicca per rinominare",
  "viewer.closeShortcut": "Chiudi (Esc)",
  "viewer.prev": "Precedente (←)",
  "viewer.next": "Successiva (→)",
  "viewer.name": "Nome",
  "viewer.type": "Tipo",
  "viewer.dimensions": "Dimensioni",
  "viewer.taken": "Scattata",
  "viewer.added": "Aggiunta",
  "viewer.modified": "Modificata",
  "viewer.size": "Dimensione",
  "viewer.onServer": "Spazio usato",
  "viewer.albums": "Album",
  "viewer.shared": "Condivisa",
  "viewer.sharedPublic": "Link pubblico",
  "viewer.sharedPeople": "Con persone",
  "viewer.sharedNo": "No",
  "viewer.unverified": " (non verificata)",
  "viewer.trashFailed": "Non è stato possibile spostare questa foto nel cestino.",
  "viewer.favoriteFailed": "Non è stato possibile aggiornare i preferiti.",
  "viewer.downloadFailed": "Non è stato possibile scaricare questa foto.",
  "viewer.zoomOut": "Riduci zoom",
  "viewer.zoomIn": "Aumenta zoom",
  "viewer.resetFit": "Adatta alla finestra",
  "viewer.videoLoading": "Caricamento video…",
  "viewer.videoError":
    "Questo formato video non può essere riprodotto qui. Scaricalo per guardarlo in un altro lettore.",
  "viewer.videoTooLarge":
    "Questo video è troppo grande per essere riprodotto qui. Scaricalo per guardarlo in un altro lettore.",

  // The viewer's own video controls, which stand in for the browser's.
  "viewer.videoPlay": "Riproduci (Spazio)",
  "viewer.videoPause": "Pausa (Spazio)",
  "viewer.videoStepBack": "Fotogramma precedente",
  "viewer.videoStepForward": "Fotogramma successivo",
  "viewer.videoSeek": "Posizione di riproduzione",
  "viewer.videoMute": "Disattiva audio",
  "viewer.videoUnmute": "Attiva audio",

  // Local file viewer: a file opened from File Explorer, which the app can show
  // with nobody signed in. Everything both viewers say alike comes from above.
  "local.camera": "Fotocamera",
  "local.created": "Creata",
  "local.path": "Percorso",
  "local.upload": "Carica su Proton",
  "local.uploadUnsupported": "Proton non accetta questo tipo di file",
  "local.uploading": "Caricamento…",
  "local.uploaded": "Salvata su Proton",
  "local.uploadSkipped": "Già salvata",
  "local.uploadFailed": "Caricamento non riuscito. Riprova.",
  "local.delete": "Elimina",
  "local.deleteTitle": "Eliminare questo file?",
  "local.deleteMessage": "«{name}» verrà spostato nel cestino.",
  "local.notFound": "Questo file è stato spostato o eliminato.",
  "local.unreadable":
    "Non è stato possibile leggere questo file. Potrebbe essere aperto in un altro programma o fuori dalla portata di questo account.",
  "local.openFailed": "Questo file non può essere aperto.",
  "local.decodeFailed":
    "Non è stato possibile leggere questa foto. Il file potrebbe essere danneggiato o incompleto.",
  "local.videoUnsupported":
    "Questo formato video non può essere riprodotto qui. Aprilo in un altro lettore.",
  "local.noCodec":
    "Windows non ha un decoder per questo formato, quindi non può essere mostrato qui. Nel Microsoft Store si trova ciò che manca per alcuni: le estensioni HEIF e HEVC per le foto HEIC e Raw Image Extension per i file raw delle fotocamere.",
  "local.signInTitle": "Accedi per caricare",
  "local.signInBody": "Si apre la finestra dell'app per accedere. Questo file resta aperto qui.",
  "local.signInAction": "Accedi",

  // Upload panel
  "upload.title": "Caricamento",
  "upload.filterName": "Foto e video",
  "upload.dropHint": "Trascina foto o una cartella in un punto qualsiasi della finestra",
  "upload.dropSub":
    "Le foto vanno direttamente nella tua sequenza. Una cartella diventa un album con lo stesso nome.",
  "upload.chooseFiles": "Scegli file",
  "upload.chooseFolder": "Scegli cartella",
  "upload.importTitle": "Importa da Google Foto o Ente",
  "upload.importSub": "Mantiene data, luogo e preferito di ogni foto secondo l'esportazione e trasforma i suoi album in album.",
  "upload.importZip": "Scegli file zip",
  "upload.importFolder": "Scegli cartella di esportazione",
  "upload.zipFilterName": "Archivi zip",
  "upload.importUnpacking": "Estrazione della parte {part} di {parts}: {done} di {total}",
  "upload.importReading": "Lettura dell'esportazione…",
  "importReview.title": "Controlla l'importazione",
  "importReview.hint": "Fai clic su una foto per escluderla e di nuovo per rimetterla. Maiusc+clic fa lo stesso con tutte le foto tra l'ultima cliccata e questa.",
  "importReview.discard": "Scarta",
  "importReview.statItems": "Elementi: {n}",
  "importReview.statAlbums": "Album: {n}",
  "importReview.statLive": "Live Photo: {n}",
  "importReview.checking": "Ricerca di quelle già nella tua libreria: {done} / {total}",
  "importReview.statAlready": "Già nella tua libreria: {n}",
  "importReview.albumsToggle": "Crea gli album",
  "importReview.timeline": "Cronologia",
  "importReview.confirm": "Importa ({n})",
  "importReview.alreadyBadge": "Già presente",
  "importReview.noDate": "Nessuna data",
  "importReview.liveJoined": "La foto e il video vengono caricati insieme come un'unica Live Photo",
  "upload.alreadyThere": "{count} già presenti",
  "upload.failedCount": "{count} non riuscite",
  "upload.showingRows": "Mostrati {shown} di {total} file: tutti gli errori, quelli in caricamento e gli ultimi.",
  "upload.clear": "Cancella",
  "upload.statusUploading": "caricamento…",
  "upload.statusSkipped": "ignorato",
  "upload.statusQueued": "in coda",
  "upload.statusFailed": "non riuscito",

  // Grid tile
  "grid.select": "Seleziona",
  "grid.deselect": "Deseleziona",

  // Selection bar
  "selection.cancel": "Annulla selezione (Esc)",
  "selection.count.one": "{count} foto selezionata",
  "selection.count.other": "{count} foto selezionate",
  "selection.trash": "Cestina",
  "selection.restore": "Ripristina",
  "selection.deleteForever": "Elimina definitivamente",
  "selection.more": "Altro",
  "selection.download": "Scarica",
  "selection.showInFolder": "Mostra nella cartella",
  "selection.freeUp": "Libera spazio",
  "selection.addToAlbum": "Aggiungi all'album",
  "selection.removeFromAlbum": "Rimuovi dall'album",
  "selection.setCover": "Imposta come copertina",
  "selection.rename": "Rinomina",
  "selection.share": "Condividi",
  "selection.favorite": "Aggiungi ai preferiti",
  "selection.unfavorite": "Rimuovi dai preferiti",
  "selection.offlineAdd": "Disponibile offline",
  "selection.offlineRemove": "Rimuovi la copia offline",
  // Download: the copy that lands in the Proton Photos folder, where Windows and any
  // other program can read it. Never called offline, which is the app's own copy.
  "download.freedUp": "{count} liberate",
  "download.freedUpNone": "Non è stato liberato nulla",
  "download.notDownloaded": "Niente da liberare",
  "download.running": "Download in corso…",
  "download.progress": "Download {done}/{total}…",
  "download.done": "{count} scaricate nella cartella Proton Photos",
  "download.donePartial": "{ok} di {total} scaricate",
  "download.doneNone":
    "Non è stato scaricato nulla. La cartella Proton Photos potrebbe non essere ancora pronta.",
  "download.alreadyDownloaded": "Già scaricate",
  "download.saved": "{count} salvate nella cartella",
  "download.partial": "Salvate {ok}, {failed} non riuscite",

  // Available offline: the app's own encrypted copy, which is not the Proton Photos
  // folder. These say where the copy went, so the two are never mistaken for one another.
  "offline.added.one": "Salvataggio di {count} foto per l'uso offline",
  "offline.added.other": "Salvataggio di {count} foto per l'uso offline",
  "offline.removed.one": "{count} copia offline rimossa",
  "offline.removed.other": "{count} copie offline rimosse",
  "offline.alreadyOffline": "Già disponibile offline",
  "offline.noneOffline": "Nessuna copia offline da rimuovere",
  "offline.failed": "impossibile salvare per l'uso offline",

  // Trash confirmation
  "confirm.trashTitle": "Spostare nel cestino?",
  "confirm.trashConfirm": "Sposta nel cestino",
  "confirm.trashCount.one":
    "{count} foto verrà spostata nel cestino. Puoi ripristinarla dalla scheda Cestino.",
  "confirm.trashCount.other":
    "{count} foto verranno spostate nel cestino. Puoi ripristinarle dalla scheda Cestino.",
  "confirm.trashName":
    '"{name}" verrà spostata nel cestino. Puoi ripristinarla dalla scheda Cestino.',
  "confirm.thisPhoto": "Questa foto",

  // Remove from album. The photos stay in Photos; only the album loses them.
  "confirm.removeTitle": "Rimuovere dall'album?",
  "confirm.removeConfirm": "Rimuovi",
  "confirm.removeCount.one": "{count} foto uscirà da questo album e resterà nella tua sequenza.",
  "confirm.removeCount.other":
    "{count} foto usciranno da questo album e resteranno nella tua sequenza.",

  // Delete-forever confirmation. Nothing in the app or at Proton undoes these.
  "confirm.deleteTitle": "Eliminare definitivamente?",
  "confirm.deleteConfirm": "Elimina definitivamente",
  "confirm.deleteCount.one":
    "{count} foto verrà eliminata definitivamente da Proton. L'operazione non può essere annullata.",
  "confirm.deleteCount.other":
    "{count} foto verranno eliminate definitivamente da Proton. L'operazione non può essere annullata.",
  "confirm.emptyTitle": "Svuotare il cestino?",
  "confirm.emptyConfirm": "Elimina tutto",
  "confirm.emptyMessage":
    "Tutto il contenuto del cestino verrà eliminato definitivamente da Proton. L'operazione non può essere annullata.",

  // Deleting an album skips the trash, so the album is gone for good even though
  // the photos in your timeline are not.
  "confirm.deleteAlbumTitle": "Eliminare questo album?",
  "confirm.deleteAlbumMessage":
    "L'album verrà eliminato e non potrà essere ripristinato. Le foto nella tua sequenza restano.",

  // Revoking sharing takes access away from people who may already hold the link,
  // and nothing is deleted by it, so both of these say exactly what is lost.
  "confirm.removeLinkTitle": "Rimuovere il link?",
  "confirm.removeLinkMessage":
    "Il link smette di funzionare per tutti quelli che lo hanno. Le persone invitate via email mantengono il loro accesso.",
  "confirm.removeLinkConfirm": "Rimuovi link",
  "confirm.replaceLinkTitle": "Sostituire il link?",
  "confirm.replaceLinkMessage":
    "Questo link è troppo vecchio per essere modificato, quindi salvando viene sostituito con uno nuovo a un indirizzo diverso. Il vecchio link smette di funzionare per tutti quelli che lo hanno e la sua password viene rimossa. Il nuovo link viene copiato negli appunti.",
  "confirm.replaceLinkConfirm": "Sostituisci link",
  "confirm.stopSharingTitle": "Interrompere la condivisione?",
  "confirm.stopSharingMessage":
    "Il link smette di funzionare e tutte le persone invitate perdono l'accesso. Non viene eliminato nulla.",
  "confirm.stopSharingConfirm": "Interrompi la condivisione",

  // Freeing up drops the downloaded copies only. Nothing leaves Proton, so this asks
  // before a big change without treating it as one there is no way back from.
  "confirm.freeUpAllTitle": "Liberare tutte le foto scaricate?",
  "confirm.freeUpAllMessage":
    "I {size} nella cartella Proton Photos verranno rimossi. Le tue foto restano su Proton e vengono scaricate di nuovo quando le apri.",
  "confirm.freeUpAllConfirm": "Libera",

  // Removing every offline copy. The photos themselves are untouched, so this warns
  // about the download they will need next time and nothing more.
  "confirm.removeOfflineAllTitle": "Rimuovere tutte le copie offline?",
  "confirm.removeOfflineAllMessage":
    "I {size} conservati cifrati nell'app verranno rimossi. Le tue foto restano su Proton e per riaprirle servirà una connessione.",
  "confirm.removeOfflineAllConfirm": "Rimuovi",
  // Photo editor
  "editor.edit": "Modifica",
  "editor.title": "Modifica foto",
  "editor.cancel": "Annulla",
  "editor.undo": "Annulla",
  "editor.redo": "Ripeti",
  "editor.save": "Salva",
  "editor.saving": "Salvataggio…",
  "editor.saved": "Copia salvata",
  "editor.saveFailed": "Impossibile salvare la foto modificata",
  "editor.loadFailed": "Impossibile aprire questa foto per modificarla",
  "editor.tool.adjust": "Regola",
  "editor.tool.filters": "Filtri",
  "editor.tool.crop": "Ritaglia",
  "editor.tool.redact": "Oscura",
  "editor.tool.rotate": "Ruota",
  "editor.adj.brightness": "Luminosità",
  "editor.adj.contrast": "Contrasto",
  "editor.adj.saturation": "Saturazione",
  "editor.adj.exposure": "Esposizione",
  "editor.adj.highlights": "Alte luci",
  "editor.adj.shadows": "Ombre",
  "editor.adj.temperature": "Temperatura",
  "editor.adj.tone": "Tinta",
  "editor.filter.none": "Originale",
  "editor.filter.bw": "B/N",
  "editor.filter.sepia": "Seppia",
  "editor.filter.vintage": "Vintage",
  "editor.filter.vivid": "Vivido",
  "editor.filter.cool": "Freddo",
  "editor.filter.warm": "Caldo",
  "editor.crop.free": "Libero",
  "editor.crop.original": "Originale",
  "editor.redact.black": "Annerisci",
  "editor.redact.pixelate": "Pixela",
  "editor.redact.brush": "Dimensione pennello",
  "editor.redact.undoStroke": "Annulla ultimo",
  "editor.redact.clear": "Cancella",
  "editor.rotate": "Ruota a destra",
  "editor.flipH": "Capovolgi in orizzontale",
  "editor.flipV": "Capovolgi in verticale",
  "editor.discardTitle": "Ignorare le modifiche?",
  "editor.discardBody": "Le modifiche che hai fatto non verranno salvate.",
  "editor.discardConfirm": "Ignora",
};
