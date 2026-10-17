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

// Slovak (sk) strings. Keys mirror en.ts exactly.
export const sk: Record<string, string> = {
  // Common
  "common.cancel": "Zrušiť",
  "common.close": "Zavrieť",
  "common.back": "Späť",
  "common.loading": "Načítava sa…",
  "common.photoCount.one": "{count} fotka",
  "common.photoCount.other": "{count} fotiek",

  // Navigation
  "nav.photos": "Fotky",
  "nav.albums": "Albumy",
  "nav.shared": "Zdieľané",
  "nav.trash": "Kôš",

  "settings.sidebarLayout": "Bočný panel",
  "settings.sidebarLayoutDesc": "Umiestni navigáciu a váš profil do zbaliteľného bočného panela vľavo. Experimentálne a stále sa dolaďuje.",
  "sidebar.collapse": "Zbaliť",
  "sidebar.expand": "Rozbaliť",
  "sidebar.showAlbums": "Zobraziť albumy",
  "sidebar.hideAlbums": "Skryť albumy",
  "sidebar.downloading": "Sťahovanie",
  "sidebar.indexing": "Indexovanie",
  "sidebar.dropHint": "alebo sem presuňte súbory",

  // App shell
  "app.restoring": "Obnovuje sa relácia…",
  "update.available": "K dispozícii je aktualizácia {version}",
  "update.now": "Aktualizovať",
  "update.updating": "Aktualizuje sa…",
  "update.failed": "Aktualizácia zlyhala",
  "update.hashError": "Overenie stiahnutého súboru zlyhalo",
  "menu.reload": "Znova načítať",
  "menu.moreSoon": "Čoskoro viac…",
  "menu.quit": "Ukončiť",

  // Tray popup
  "tray.open": "Otvoriť Photos for Proton",
  "tray.syncNow": "Synchronizovať teraz",
  "tray.syncing": "Synchronizuje sa…",
  "tray.synced": "Aktuálne",
  "tray.locked": "Uzamknuté",
  "tray.lockedHint": "Otvorte na odomknutie",
  "tray.signedOut": "Neprihlásené",
  "tray.signedOutHint": "Otvorte na prihlásenie",

  // Login
  "login.subtitle": "Prihláste sa do svojho účtu Proton",
  "login.emailLabel": "E-mail alebo používateľské meno",
  "login.passwordLabel": "Heslo",
  "login.passwordPlaceholder": "Heslo",
  "login.signIn": "Prihlásiť sa",
  "login.signingIn": "Prihlasovanie…",
  "login.twofaLabel": "Dvojfaktorový kód",
  "login.verify": "Overiť",
  "login.verifying": "Overuje sa…",
  "login.captchaHint": "Proton vás žiada o potvrdenie, že ste človek.",
  "login.captchaExpired": "Platnosť testu captcha vypršala. Vyriešte ho znova.",
  "login.withBrowser": "Prihlásiť sa v prehliadači",
  "login.withBrowserHint": "Prihlásite sa na vlastnej stránke Protonu. Vaše heslo sa do tejto aplikácie nikdy nedostane.",
  "login.withPassword": "Radšej sa prihlásiť e-mailom a heslom",
  "login.or": "alebo e-mailom a heslom",
  "login.browserWaiting": "Dokončite prihlásenie v prehliadači. Toto okno potom pokračuje samo.",
  "login.browserOpenAgain": "Otvoriť stránku znova",
  "login.browserCopy": "Kopírovať odkaz",
  "login.browserCopied": "Odkaz skopírovaný",
  "login.browserNotOpened": "Prehliadač sa neotvoril. Skopírujte odkaz a otvorte ho sami.",
  "login.browserTimeout": "Prihlásenie trvalo príliš dlho. Skúste to znova.",
  "login.sessionEnded": "Vaša relácia skončila. Prihláste sa znova.",
  "login.unofficial": "Toto je aplikácia tretej strany, ktorú Proton oficiálne nepodporuje.",
  "protect.intro": "Ako má tento počítač udržať vaše prihlásenie?",
  "protect.password": "Vlastným heslom",
  "protect.passwordDesc": "Aplikácia ho pýta pri každom spustení. Môže byť akékoľvek, nie je to vaše heslo k Protonu.",
  "protect.newPassword": "Heslo pre túto aplikáciu",
  "protect.repeatPassword": "Zopakujte heslo",
  "protect.device": "Bez hesla",
  "protect.deviceDesc": "Aplikácia sa otvorí hneď. Chráni ju váš účet Windows: kto sa doň prihlási, otvorí aj aplikáciu.",
  "protect.continue": "Pokračovať",
  "protect.tooShort": "Použite aspoň {n} znakov.",
  "protect.mismatch": "Heslá sa nezhodujú.",

  // Lock screen (returning cold start)
  "lock.subtitle": "Zadajte heslo na odomknutie",
  "lock.unlock": "Odomknúť",
  "lock.unlocking": "Odomyká sa…",
  "lock.wrongPassword": "Nesprávne heslo",
  "lock.failed": "Nepodarilo sa odomknúť. Skúste to znova.",
  "lock.differentAccount": "Použiť iný účet",

  // Titlebar
  "titlebar.minimize": "Minimalizovať",
  "titlebar.maximize": "Maximalizovať",

  // Settings
  "settings.title": "Nastavenia",
  "settings.general": "Všeobecné",
  "settings.launchAtLogin": "Spúšťať so systémom Windows",
  "settings.launchAtLoginDesc": "Spustí sa na pozadí po prihlásení do systému Windows a zobrazí iba ikonu na paneli úloh, kým ju neotvoríte.",
  "settings.launchAtLoginLinux": "Spúšťať po prihlásení",
  "settings.launchAtLoginLinuxDesc": "Otvorí Photos for Proton po prihlásení do počítača.",
  "settings.keepRunning": "Bežať aj po zatvorení",
  "settings.keepRunningDesc":
    "Po zatvorení okna Photos for Proton ďalej beží, takže Proton Photos v Súboroch funguje ďalej. Znova ho otvoríte zo zoznamu aplikácií; ukončiť ho môžete v ponuke účtu.",
  "settings.appearance": "Vzhľad",
  "settings.theme": "Motív",
  "settings.themeDesc": "Systém sa riadi Windowsom a mení sa spolu s ním.",
  "settings.theme.dark": "Tmavý",
  "settings.theme.light": "Svetlý",
  "settings.theme.system": "Systém",
  "settings.palette": "Paleta",
  "settings.paletteDesc": "Farba zvýraznenia použitá v celej aplikácii.",
  "settings.palette.default": "Predvolená",
  "settings.palette.forest": "Les",
  "settings.palette.sunset": "Západ slnka",
  "settings.palette.sea": "More",
  "settings.palette.sepia": "Sépia",
  "settings.palette.mono": "Mono",
  "settings.palette.amoled": "Čistá čierna (AMOLED)",
  "settings.language": "Jazyk",
  "settings.languageDesc": "Vyberte jazyk zobrazenia.",
  "settings.timeline": "Časová os",
  "settings.hideAlbum": "Skryť fotky v albumoch na Drive",
  "settings.hideAlbumDesc":
    "Fotky pridané do albumu na Drive sa nezobrazia vo vašej hlavnej časovej osi. Naďalej sa zobrazujú na kartách Albumy a Zdieľané a vo filtroch kategórií.",
  "settings.security": "Zabezpečenie",
  "settings.about": "O aplikácii",
  "settings.checkUpdates": "Skontrolovať aktualizácie",
  "settings.upToDate": "Máte najnovšiu verziu",
  "settings.website": "Webová stránka",
  "settings.sourceCode": "Zdrojový kód",
  "settings.authorRole": "Tvorca a správca",
  "settings.support": "Kúp mi kávu",
  "settings.supportDesc": "Podporte aplikáciu a jej vývoj",
  "settings.lockOnHide": "Vyžadovať heslo pri opätovnom otvorení zo systémovej lišty",
  "settings.deviceProtected": "Chránené vaším účtom Windows",
  "settings.deviceProtectedDesc": "Aplikácia sa otvára bez hesla. Ak chcete heslo, odhláste sa a znova sa prihláste.",
  "settings.debug": "Ladiaca vrstva",
  "settings.debugDesc": "Zobraziť živý prehľad pamäte (veľkosť haldy a vyrovnávacej pamäte).",
  "settings.explorer": "Prieskumník súborov",
  "settings.showInExplorer": "Zobraziť „Proton Photos“ v Prieskumníkovi súborov",
  "settings.showInExplorerDesc":
    "Pridá do bočného panela Prieskumníka položku Proton Photos s vašimi cloudovými fotkami. Prejaví sa po reštarte.",
  "settings.autoDownload": "Automaticky sťahovať nové fotky",
  "settings.autoDownloadDesc":
    "Keď sa do knižnice pridávajú nové fotky, automaticky sa stiahnu do priečinka Proton Photos.",
  "settings.autoDownloadNeedsExplorer":
    "Funguje len so zapnutou položkou „Proton Photos“ v Prieskumníkovi súborov, ktorá je vypnutá. Sťahovanie funguje aj tak: spýta sa vás, kam sa majú fotky uložiť.",
  "settings.restartNeeded": "Reštartujte, aby sa zmena prejavila.",
  "settings.restartNow": "Reštartovať teraz",
  "settings.filesDrive": "Správca súborov",
  "settings.filesDriveShow": "Zobraziť „Proton Photos“ v Súboroch",
  "settings.filesDriveShowDesc":
    "Pridá Proton Photos do bočného panela Súborov a ďalších správcov súborov. Odtiaľ môžete fotky otvárať a kopírovať a pretiahnutím fotiek alebo priečinkov ich nahrať: z priečinka sa stane album, alebo sa po vložení do Photos pridá na časovú os. Funguje, keď aplikácia beží a je odomknutá.",
  "settings.filesDriveAddress": "Adresa",
  "settings.filesDriveAddressDesc":
    "Pre správcu súborov bez položky v bočnom paneli: pripojte sa na túto adresu. V Dolphine použite webdav:// namiesto dav://.",
  "settings.filesDriveCopy": "Kopírovať",
  "settings.filesDriveCopied": "Skopírované",
  "settings.filesDriveEdits": "Povoliť mazanie a premenovanie",
  "settings.filesDriveEditsDesc":
    "Fotka vymazaná v Photos sa presunie do koša Proton, odkiaľ ju možno 30 dní obnoviť. Vymazaná v priečinku albumu len z albumu zmizne; vymazanie priečinka albumu vymaže album a jeho fotky zachová. Z priečinka Trash nemožno v Súboroch nič vymazať.",
  "settings.filesDriveByDate": "Rozdeliť Photos podľa roka a mesiaca",
  "settings.filesDriveByDateDesc":
    "Zobrazí Photos ako priečinky rokov a mesiacov namiesto jedného dlhého zoznamu.",
  "settings.filesDriveServer": "Adresa a port",
  "settings.filesDriveServerDesc":
    "Kde disk na tomto počítači počúva: localhost alebo adresa od 127.0.0.1 do 127.255.255.254. Ponechajte port prázdny a použije sa ľubovoľný voľný. Na vašej sieti nikdy nepočúva.",
  "settings.filesDriveAutoPort": "auto",
  "settings.filesDriveApply": "Použiť",
  "settings.filesDriveErrAddress": "Použite localhost alebo adresu začínajúcu 127.",
  "settings.filesDriveErrPort": "Použite port od 1024 do 65535, alebo ho nechajte prázdny.",
  "settings.filesDriveErrInUse": "Tento port už používa niečo iné. Disk zostáva, kde bol.",
  "settings.filesDrivePortTaken":
    "Zvolený port bol pri spustení aplikácie obsadený, takže sa do jeho uvoľnenia používa iný.",
  // File types. The "Open with" entries are the app's own to add and take back out;
  // the default handler is not, so that half leads out to Windows rather than
  // pretending to a choice Windows takes from the user alone.
  "settings.fileTypes": "Typy súborov",
  "settings.openWith": "Pridať do ponuky „Otvoriť v programe“",
  "settings.openWithDesc":
    "Uvedie Photos for Proton v ponuke Windows „Otvoriť v programe“ pri fotkách JPEG, PNG, GIF, WebP, AVIF, BMP, TIFF a HEIC a pri videách MP4, MOV, M4V a WebM. Po vypnutí sa položky zase odstránia.",
  "settings.fileTypesFailed": "Typy súborov sa nepodarilo zmeniť. Skúste to znova.",
  "settings.defaultApp": "Predvolená aplikácia pre fotky a videá",
  "settings.defaultAppDesc":
    "Takto sa nič nestane predvoleným: túto voľbu Windows prijme len od vás, nikdy od programu. Vyberte Photos for Proton v nastaveniach Windows v časti Predvolené aplikácie.",
  "settings.defaultAppOpen": "Otvoriť nastavenia Windows",
  "settings.defaultAppFailed": "Nastavenia Windows sa nepodarilo otvoriť. Skúste to znova.",
  "settings.lockOnHideDesc":
    "Keď sa okno zavrie do systémovej lišty, aplikácia sa uzamkne a pri ďalšom otvorení si vyžiada heslo.",
  "settings.storage": "Úložisko",
  // Two different places a photo can be kept on this machine: encrypted inside the
  // app, or downloaded into the Proton Photos folder where Windows can read it. The
  // panel names both rather than adding one number to the other.
  "settings.downloadedCount.one": "{count} stiahnutá fotka",
  "settings.downloadedCount.other": "{count} stiahnutých fotiek",
  "settings.downloadedNone": "Nič nie je stiahnuté",
  "settings.downloadedDesc":
    "Stiahnuté fotky sú bežné súbory v priečinku Proton Photos, takže ich dokáže prečítať vyhľadávanie Windows aj iné programy. Uvoľnenie odstráni len tieto miestne kópie a vaše fotky zostávajú v Protone.",
  "settings.freeUpAll": "Uvoľniť {size}",
  "settings.freeUpNothing": "Nie je čo uvoľniť",
  "settings.freeingUp": "Uvoľňovanie…",
  "settings.storageOffline": "Offline fotky",
  "settings.storageExplorer": "V Prieskumníkovi súborov",
  "settings.offlineCount.one": "{count} fotka v aplikácii",
  "settings.offlineCount.other": "{count} fotiek v aplikácii",
  "settings.offlineNone": "V aplikácii nie sú uložené žiadne fotky",
  "settings.offlineDesc":
    "Fotky označené ako dostupné offline zostávajú zašifrované vo vnútri aplikácie. Otvoria sa aj bez pripojenia a v priečinku Proton Photos sa nikdy nezobrazia, takže ich nič mimo aplikácie neprečíta.",
  "settings.offlineSaving": "Ukladá sa {done}/{total}…",
  "settings.offlineRemoveAll": "Uvoľniť {size}",
  "settings.offlineRemoveNothing": "Nie je čo uvoľniť",
  "settings.offlineRemoving": "Odstraňuje sa…",
  "settings.freeUpFailed": "Miesto sa nepodarilo uvoľniť. Skúste to znova.",

  // Profile menu
  "profile.storage": "Úložisko",
  "profile.used": "{size} použitých",
  "profile.total": "{size} celkovo",
  "profile.signOut": "Odhlásiť sa",

  // Avatar
  "avatar.uploading": "Nahráva sa",
  "avatar.syncing": "Synchronizuje sa",
  "avatar.account": "Účet a nastavenia",
  "avatar.showUploads": "Zobraziť nahrávania",

  // Photos view
  "photos.all": "Všetko",
  "photos.search": "Hľadať",
  "photos.searchPlaceholder": "Hľadať podľa názvu alebo typu súboru…",
  "photos.closeSearch": "Zavrieť vyhľadávanie",
  "photos.indexing": "Indexuje sa {done}/{total}",
  "photos.uploadTitle": "Nahrať fotky alebo priečinok ako album",
  "photos.uploadingProgress": "Nahráva sa {progress}",
  "photos.noMatches": "Žiadne zhody",
  "photos.noPhotos": "Zatiaľ žiadne fotky",
  "photos.noPhotosSub": "Vaše fotky sa tu objavia po synchronizácii.",
  "photos.stillIndexing": "Indexovanie stále prebieha, objaví sa viac výsledkov.",
  "photos.dropTitle": "Pustite sem pre nahranie",
  "photos.dropSub": "Priečinok sa stane albumom s rovnakým názvom",
  "photos.offline": "Dostupné offline, zašifrované v aplikácii",
  "photos.downloaded": "Stiahnuté do priečinka Proton Photos",
  "photos.renameTitle": "Premenovať fotku",
  "photos.namePlaceholder": "Názov súboru",

  // Tile badges
  "badge.motionPhoto": "Pohyblivá fotka",
  "badge.panorama": "Panoráma",
  "badge.raw": "RAW",
  "badge.favorite": "Obľúbené",

  // Search type filters
  "filter.images": "Obrázky",
  "filter.videos": "Videá",

  // Filter panel
  "filter.title": "Filter",
  "filter.categories": "Kategórie",
  "filter.type": "Typ",
  "filter.mediaAll": "Všetko",
  "filter.mediaPhotos": "Fotky",
  "filter.reset": "Obnoviť",

  // Categories
  "category.fav": "Obľúbené",
  "category.screen": "Snímky obrazovky",
  "category.video": "Videá",
  "category.live": "Živé fotky",
  "category.selfie": "Selfie",
  "category.portrait": "Portréty",
  "category.burst": "Sekvencie",
  "category.pano": "Panorámy",
  "category.raw": "RAW",

  // Albums
  "albums.backToAlbums": "Späť na albumy",
  "albums.untitled": "Album bez názvu",
  "albums.empty": "Tento album je prázdny",
  "albums.none": "Zatiaľ žiadne albumy",
  "albums.noneSub": "Vytvorte ho tu, alebo presuňte priečinok na okno.",
  "albums.keepDownloaded": "Stiahnuť tento album do priečinka Proton Photos",
  "albums.keptDownloaded": "Sťahovanie do priečinka Proton Photos (kliknutím zrušíte)",
  "albums.freeUpTitle": "Uvoľniť miesto tohto albumu?",
  "albums.freeUpCount.one":
    "Album sa už sám nesťahuje. {count} fotka už je v priečinku Proton Photos a môže tu zostať, alebo môžete uvoľniť miesto, ktoré zaberá. V oboch prípadoch zostáva v Protone.",
  "albums.freeUpCount.other":
    "Album sa už sám nesťahuje. {count} fotiek už je v priečinku Proton Photos a môžu tu zostať, alebo môžete uvoľniť miesto, ktoré zaberajú. V oboch prípadoch zostávajú v Protone.",
  "albums.freeUpKeep": "Ponechať stiahnuté",
  "albums.freeUpConfirm": "Uvoľniť",
  "albums.newAlbum": "Nový album",
  "albums.searchHint": "Hľadať albumy",
  "albums.searchEmpty": "Žiadne albumy nezodpovedajú hľadaniu",
  "albums.sortName": "Názov (A-Z)",
  "albums.sortActivity": "Posledná aktivita",
  "albums.sortCount": "Počet fotiek",
  "albums.pin": "Pripnúť",
  "albums.unpin": "Odopnúť",
  "albums.pinLimit": "Môžeš pripnúť až 5 albumov",
  "albums.newTitle": "Pomenujte album",
  "albums.namePlaceholder": "Názov albumu",
  "albums.create": "Vytvoriť",
  "albums.createAndAdd": "Vytvoriť a pridať",
  "albums.rename": "Premenovať",
  "albums.renameTitle": "Premenovať album",
  "albums.share": "Zdieľať album",
  "albums.delete": "Zmazať album",
  "albums.more": "Viac",
  "albums.addPhotos": "Pridať fotky",
  "albums.addFromLibrary": "Z vašej knižnice",
  "albums.addFromComputer": "Z tohto počítača",
  "albums.deleted": "Album zmazaný",
  "albums.addTitle": "Pridať do albumu",
  "albums.addCount.one": "Vyberte, kam patrí {count} fotka.",
  "albums.addCount.other": "Vyberte, kam patria fotky ({count}).",
  "albums.added": "Pridané: {count}",
  "albums.addPartial": "Pridané {ok}, zlyhalo {failed}",
  "albums.removed": "Odobraté z albumu: {count}",
  "albums.removePartial": "Odobraté {ok}, zlyhalo {failed}",
  "albums.coverSet": "Obal aktualizovaný",
  "albums.strandedTitle.one": "{count} fotka je len v tomto albume",
  "albums.strandedTitle.other": "Len v tomto albume sú fotky ({count})",
  "albums.strandedMsg.one":
    "Nie je na vašej časovej osi, takže so zmazaním albumu zmizne aj ona. Uložte ju na časovú os, aby vám zostala.",
  "albums.strandedMsg.other":
    "Nie sú na vašej časovej osi, takže so zmazaním albumu zmiznú aj ony. Uložte ich na časovú os, aby vám zostali.",
  "albums.savePhotos": "Uložiť na časovú os",
  "albums.deletePhotosToo": "Zmazať aj fotky",

  // Shared
  "shared.byMe": "Zdieľané mnou",
  "shared.withMe": "Zdieľané so mnou",
  "shared.flip": "Prepnúť medzi zdieľanými mnou a zdieľanými so mnou",
  "shared.emptyByTitle": "Nič nezdieľate",
  "shared.emptyWithTitle": "Nič vám nebolo zdieľané",
  "shared.emptyBySub": "Fotky a albumy, ktoré zdieľate, sa objavia tu.",
  "shared.emptyWithSub": "Fotky a albumy, ktoré s vami zdieľajú ostatní, sa objavia tu.",
  "shared.publicLink": "Zdieľané cez verejný odkaz",
  "shared.album": "Album",
  "shared.manage": "Spravovať zdieľanie",
  "shared.back": "Späť na zdieľané",

  // Share dialog. A public link's URL carries the secret that decrypts what it
  // points at, so copying it whole is the whole point of the link section. A
  // link's password is never read back, so the dialog reports whether one is set
  // rather than showing it.
  "share.title": "Zdieľanie",
  "share.linkTitle": "Verejný odkaz",
  "share.linkDesc": "Túto fotku môže otvoriť ktokoľvek, kto má odkaz.",
  "share.createLink": "Vytvoriť odkaz",
  "share.copyLink": "Kopírovať odkaz",
  "share.copied": "Skopírované",
  "share.removeLink": "Odstrániť odkaz",
  "share.passwordLabel": "Heslo",
  "share.passwordSet": "Potrebné na otvorenie",
  "share.passwordNone": "Nenastavené",
  "share.passwordPlaceholder": "Nové heslo",
  "share.expiryLabel": "Vyprší",
  "share.expiryNever": "Nikdy",
  "share.expiryPast": "Vyberte dátum v budúcnosti.",
  "share.add": "Pridať",
  "share.change": "Zmeniť",
  "share.set": "Nastaviť",
  "share.save": "Uložiť",
  "share.albumInviteOnly": "Albumy sa zdieľajú pozvánkou, nie verejným odkazom.",
  "share.peopleTitle": "Ľudia",
  "share.emailPlaceholder": "E-mailová adresa",
  "share.invite": "Pozvať",
  "share.roleViewer": "Prezerajúci",
  "share.roleEditor": "Editor",
  "share.stateInvited": "Pozvaný",
  "share.stateExternal": "Pozvaný (bez konta Proton)",
  "share.remove": "Odstrániť",
  "share.noPeople": "Zatiaľ nikto",
  "share.stopSharing": "Ukončiť zdieľanie",
  "share.notOwned": "Toto bolo zdieľané s vami. Iba vlastník môže zmeniť, kto k tomu má prístup.",
  "share.badEmail": "Toto nevyzerá ako e-mailová adresa.",
  "share.copyFailed": "Odkaz sa nepodarilo skopírovať",
  "share.failed": "Zdieľanie sa nepodarilo zmeniť",
  "share.working": "Prebieha…",

  // Trash
  "trash.emptyTitle": "Kôš je prázdny",
  "trash.emptySub": "Fotky presunuté do koša sa zobrazia tu a môžete ich obnoviť.",
  "trash.emptyAction": "Vysypať kôš",
  "trash.moved": "Presunuté do koša: {count}",
  "trash.movedPartial": "Presunuté do koša: {ok}, zlyhalo {failed}",
  "trash.restored": "Obnovené: {count}",
  "trash.deleted": "Trvalo zmazané: {count}",
  "trash.emptied": "Kôš vysypaný",
  "trash.partial": "Hotové {ok}, zlyhalo {failed}",

  // Photo viewer / lightbox
  "viewer.details": "Podrobnosti",
  "viewer.offlineAdd": "Ponechať offline kópiu, zašifrovanú v aplikácii",
  "viewer.offlineRemove": "Odstrániť offline kópiu",
  "viewer.download": "Stiahnuť do priečinka Proton Photos",
  "viewer.saveToFolder": "Uložiť kópiu na zvolené miesto",
  "viewer.freeUp": "Odstrániť lokálnu kópiu a uvoľniť miesto",
  "viewer.detailsShortcut": "Podrobnosti (I)",
  "viewer.contents": "Obsah",
  "viewer.contentsShortcut": "Obsah (L)",
  "viewer.filmstrip": "Susedné položky",
  "viewer.position": "{n} z {total}",
  "viewer.favoriteShortcut": "Pridať do obľúbených (F)",
  "viewer.unfavoriteShortcut": "Odobrať z obľúbených (F)",
  "viewer.trashShortcut": "Presunúť do koša (Del)",
  "viewer.shareShortcut": "Zdieľať (S)",
  "viewer.rename": "Kliknutím premenujete",
  "viewer.closeShortcut": "Zavrieť (Esc)",
  "viewer.prev": "Predchádzajúca (←)",
  "viewer.next": "Ďalšia (→)",
  "viewer.name": "Názov",
  "viewer.type": "Typ",
  "viewer.dimensions": "Rozmery",
  "viewer.taken": "Nasnímané",
  "viewer.added": "Pridané",
  "viewer.modified": "Upravené",
  "viewer.size": "Veľkosť",
  "viewer.onServer": "Využité miesto",
  "viewer.albums": "Albumy",
  "viewer.shared": "Zdieľané",
  "viewer.sharedPublic": "Verejný odkaz",
  "viewer.sharedPeople": "S ľuďmi",
  "viewer.sharedNo": "Nie",
  "viewer.unverified": " (neoverené)",
  "viewer.trashFailed": "Túto fotku sa nepodarilo presunúť do koša.",
  "viewer.favoriteFailed": "Obľúbené sa nepodarilo aktualizovať.",
  "viewer.downloadFailed": "Túto fotku sa nepodarilo stiahnuť.",
  "viewer.zoomOut": "Oddialiť",
  "viewer.zoomIn": "Priblížiť",
  "viewer.resetFit": "Prispôsobiť veľkosti",
  "viewer.videoLoading": "Načítava sa video…",
  "viewer.videoError":
    "Tento formát videa sa tu nedá prehrať. Stiahnite si ho a prehrajte v inom prehrávači.",
  "viewer.videoTooLarge":
    "Toto video je príliš veľké na prehratie tu. Stiahnite si ho a prehrajte v inom prehrávači.",

  // The viewer's own video controls, which stand in for the browser's.
  "viewer.videoPlay": "Prehrať (medzerník)",
  "viewer.videoPause": "Pozastaviť (medzerník)",
  "viewer.videoStepBack": "Predchádzajúca snímka",
  "viewer.videoStepForward": "Ďalšia snímka",
  "viewer.videoSeek": "Pozícia prehrávania",
  "viewer.videoMute": "Stlmiť",
  "viewer.videoUnmute": "Zrušiť stlmenie",

  // Local file viewer: a file opened from File Explorer, which the app can show
  // with nobody signed in. Everything both viewers say alike comes from above.
  "local.camera": "Fotoaparát",
  "local.created": "Vytvorené",
  "local.path": "Umiestnenie",
  "local.upload": "Nahrať do Protonu",
  "local.uploadUnsupported": "Proton neprijíma tento typ súboru",
  "local.uploading": "Nahrávanie…",
  "local.uploaded": "Uložené do Protonu",
  "local.uploadSkipped": "Už uložené",
  "local.uploadFailed": "Nahrávanie zlyhalo. Skúste to znova.",
  "local.delete": "Odstrániť",
  "local.deleteTitle": "Odstrániť tento súbor?",
  "local.deleteMessage": "Súbor „{name}“ sa presunie do koša.",
  "local.notFound": "Tento súbor bol presunutý alebo odstránený.",
  "local.unreadable":
    "Tento súbor sa nepodarilo prečítať. Možno ho má otvorený iný program, alebo je mimo dosahu tohto účtu.",
  "local.openFailed": "Tento súbor sa nepodarilo otvoriť.",
  "local.decodeFailed":
    "Túto fotku sa nepodarilo prečítať. Súbor môže byť poškodený alebo neúplný.",
  "local.videoUnsupported": "Tento formát videa sa tu nedá prehrať. Otvorte ho v inom prehrávači.",
  "local.noCodec":
    "Windows nemá pre tento formát dekodér, takže sa tu nedá zobraziť. V Microsoft Store je to, čo pri niektorých chýba: rozšírenia HEIF a HEVC pre fotky HEIC a Raw Image Extension pre surové súbory z fotoaparátov.",
  "local.signInTitle": "Prihláste sa na nahrávanie",
  "local.signInBody":
    "Otvorí sa okno aplikácie, kde sa môžete prihlásiť. Tento súbor zostane otvorený tu.",
  "local.signInAction": "Prihlásiť sa",

  // Upload panel
  "upload.title": "Nahrať",
  "upload.filterName": "Fotky a videá",
  "upload.dropHint": "Presuňte fotky alebo priečinok kamkoľvek na okno",
  "upload.dropSub":
    "Fotky idú rovno do vašej časovej osi. Priečinok sa stane albumom s rovnakým názvom.",
  "upload.chooseFiles": "Vybrať súbory",
  "upload.chooseFolder": "Vybrať priečinok",
  "upload.importTitle": "Import z Fotiek Google alebo z Ente",
  "upload.importSub": "Ponechá každej fotke dátum, miesto a obľúbenie podľa exportu a z jeho albumov urobí albumy.",
  "upload.importZip": "Vybrať súbory zip",
  "upload.importFolder": "Vybrať priečinok exportu",
  "upload.zipFilterName": "Archívy zip",
  "upload.importUnpacking": "Rozbaľovanie časti {part} z {parts}: {done} z {total}",
  "upload.importReading": "Načítava sa export…",
  "importReview.title": "Kontrola importu",
  "importReview.hint": "Kliknutím fotku vynecháte, ďalším kliknutím ju vrátite. Shift+kliknutie urobí to isté so všetkými fotkami medzi naposledy kliknutou a touto.",
  "importReview.discard": "Zahodiť",
  "importReview.statItems": "Položky: {n}",
  "importReview.statAlbums": "Albumy: {n}",
  "importReview.statLive": "Live Photos: {n}",
  "importReview.checking": "Hľadanie už nahraných: {done} / {total}",
  "importReview.statAlready": "Už vo vašej knižnici: {n}",
  "importReview.albumsToggle": "Vytvoriť albumy",
  "importReview.timeline": "Časová os",
  "importReview.confirm": "Importovať ({n})",
  "importReview.alreadyBadge": "V knižnici",
  "importReview.noDate": "Bez dátumu",
  "importReview.liveJoined": "Fotka a video sa nahrajú spolu ako jedna Live Photo",
  "upload.alreadyThere": "{count} už existuje",
  "upload.failedCount": "{count} zlyhalo",
  "upload.showingRows": "Zobrazených {shown} z {total} súborov: všetky chyby, čo sa práve nahráva, a tie najnovšie.",
  "upload.clear": "Vymazať",
  "upload.statusUploading": "nahráva sa…",
  "upload.statusSkipped": "preskočené",
  "upload.statusQueued": "v poradí",
  "upload.statusFailed": "zlyhalo",

  // Grid tile
  "grid.select": "Vybrať",
  "grid.deselect": "Zrušiť výber",

  // Selection bar
  "selection.cancel": "Zrušiť výber (Esc)",
  "selection.count.one": "Vybraná {count} fotka",
  "selection.count.other": "Vybraných {count} fotiek",
  "selection.trash": "Do koša",
  "selection.restore": "Obnoviť",
  "selection.deleteForever": "Zmazať navždy",
  "selection.more": "Ďalšie",
  "selection.download": "Stiahnuť",
  "selection.showInFolder": "Zobraziť v priečinku",
  "selection.freeUp": "Uvoľniť",
  "selection.addToAlbum": "Pridať do albumu",
  "selection.removeFromAlbum": "Odobrať z albumu",
  "selection.setCover": "Nastaviť ako obal",
  "selection.rename": "Premenovať",
  "selection.share": "Zdieľať",
  "selection.favorite": "Pridať do obľúbených",
  "selection.unfavorite": "Odobrať z obľúbených",
  "selection.offlineAdd": "Dostupné offline",
  "selection.offlineRemove": "Odstrániť offline kópiu",
  // Download: the copy that lands in the Proton Photos folder, where Windows and any
  // other program can read it. Never called offline, which is the app's own copy.
  "download.freedUp": "Uvoľnené: {count}",
  "download.freedUpNone": "Nič sa neuvoľnilo",
  "download.notDownloaded": "Nie je nič stiahnuté na uvoľnenie",
  "download.running": "Sťahuje sa…",
  "download.progress": "Sťahuje sa {done}/{total}…",
  "download.done": "Stiahnuté do priečinka Proton Photos: {count}",
  "download.donePartial": "Stiahnuté: {ok} z {total}",
  "download.doneNone":
    "Nič nebolo stiahnuté. Priečinok Proton Photos možno ešte nie je pripravený.",
  "download.alreadyDownloaded": "Už stiahnuté",
  "download.saved": "Uložené do priečinka: {count}",
  "download.partial": "Uložené {ok}, zlyhalo {failed}",

  // Available offline: the app's own encrypted copy, which is not the Proton Photos
  // folder. These say where the copy went, so the two are never mistaken for one another.
  "offline.added.one": "{count} fotka sa ukladá na použitie offline",
  "offline.added.other": "{count} fotiek sa ukladá na použitie offline",
  "offline.removed.one": "Odstránená {count} offline kópia",
  "offline.removed.other": "Odstránených {count} offline kópií",
  "offline.alreadyOffline": "Už dostupné offline",
  "offline.noneOffline": "Nie sú žiadne offline kópie na odstránenie",
  "offline.failed": "nepodarilo sa uložiť na použitie offline",

  // Trash confirmation
  "confirm.trashTitle": "Presunúť do koša?",
  "confirm.trashConfirm": "Presunúť do koša",
  "confirm.trashCount.one":
    "{count} fotka sa presunie do koša. Môžete ju obnoviť na karte Kôš.",
  "confirm.trashCount.other":
    "{count} fotiek sa presunie do koša. Môžete ich obnoviť na karte Kôš.",
  "confirm.trashName":
    "„{name}“ sa presunie do koša. Môžete ju obnoviť na karte Kôš.",
  "confirm.thisPhoto": "Táto fotka",

  // Remove from album. The photos stay in Photos; only the album loses them.
  "confirm.removeTitle": "Odobrať z albumu?",
  "confirm.removeConfirm": "Odobrať",
  "confirm.removeCount.one":
    "{count} fotka zmizne z tohto albumu, ale zostane na vašej časovej osi.",
  "confirm.removeCount.other":
    "Fotky ({count}) zmiznú z tohto albumu, ale zostanú na vašej časovej osi.",

  // Delete-forever confirmation. Nothing in the app or at Proton undoes these.
  "confirm.deleteTitle": "Zmazať navždy?",
  "confirm.deleteConfirm": "Zmazať navždy",
  "confirm.deleteCount.one":
    "{count} fotka bude trvalo zmazaná z Protonu. Túto akciu nemožno vrátiť späť.",
  "confirm.deleteCount.other":
    "{count} fotiek bude trvalo zmazaných z Protonu. Túto akciu nemožno vrátiť späť.",
  "confirm.emptyTitle": "Vysypať kôš?",
  "confirm.emptyConfirm": "Zmazať všetko",
  "confirm.emptyMessage":
    "Celý obsah koša bude trvalo zmazaný z Protonu. Túto akciu nemožno vrátiť späť.",

  // Deleting an album skips the trash, so the album is gone for good even though
  // the photos in your timeline are not.
  "confirm.deleteAlbumTitle": "Zmazať tento album?",
  "confirm.deleteAlbumMessage":
    "Album bude zmazaný a nedá sa obnoviť. Fotky na vašej časovej osi zostanú.",

  // Revoking sharing takes access away from people who may already hold the link,
  // and nothing is deleted by it, so both of these say exactly what is lost.
  "confirm.removeLinkTitle": "Odstrániť odkaz?",
  "confirm.removeLinkMessage":
    "Odkaz prestane fungovať všetkým, ktorí ho majú. Ľudia pozvaní e-mailom si prístup ponechajú.",
  "confirm.removeLinkConfirm": "Odstrániť odkaz",
  "confirm.replaceLinkTitle": "Nahradiť odkaz?",
  "confirm.replaceLinkMessage":
    "Tento odkaz je príliš starý na to, aby sa dal zmeniť, takže uložením sa nahradí novým na inej adrese. Starý odkaz prestane fungovať všetkým, ktorí ho majú, a jeho heslo sa zruší. Nový odkaz sa skopíruje do schránky.",
  "confirm.replaceLinkConfirm": "Nahradiť odkaz",
  "confirm.stopSharingTitle": "Ukončiť zdieľanie?",
  "confirm.stopSharingMessage":
    "Odkaz prestane fungovať a všetci pozvaní stratia prístup. Nič sa nezmaže.",
  "confirm.stopSharingConfirm": "Ukončiť zdieľanie",

  // Freeing up drops the downloaded copies only. Nothing leaves Proton, so this asks
  // before a big change without treating it as one there is no way back from.
  "confirm.freeUpAllTitle": "Uvoľniť všetky stiahnuté fotky?",
  "confirm.freeUpAllMessage":
    "{size} v priečinku Proton Photos sa odstráni. Vaše fotky zostávajú v Protone a znova sa stiahnu, keď ich otvoríte.",
  "confirm.freeUpAllConfirm": "Uvoľniť",

  // Removing every offline copy. The photos themselves are untouched, so this warns
  // about the download they will need next time and nothing more.
  "confirm.removeOfflineAllTitle": "Odstrániť všetky offline kópie?",
  "confirm.removeOfflineAllMessage":
    "{size} uložených zašifrovane v aplikácii sa odstráni. Vaše fotky zostávajú v Protone a na ich opätovné otvorenie bude potrebné pripojenie.",
  "confirm.removeOfflineAllConfirm": "Odstrániť",
  // Photo editor
  "editor.edit": "Upraviť",
  "editor.title": "Úprava fotky",
  "editor.cancel": "Zrušiť",
  "editor.undo": "Späť",
  "editor.redo": "Znova",
  "editor.save": "Uložiť",
  "editor.saving": "Ukladanie…",
  "editor.saved": "Kópia uložená",
  "editor.saveFailed": "Upravenú fotku sa nepodarilo uložiť",
  "editor.loadFailed": "Túto fotku sa nepodarilo otvoriť na úpravu",
  "editor.tool.adjust": "Úpravy",
  "editor.tool.filters": "Filtre",
  "editor.tool.crop": "Orezať",
  "editor.tool.redact": "Zakryť",
  "editor.tool.rotate": "Otočiť",
  "editor.adj.brightness": "Jas",
  "editor.adj.contrast": "Kontrast",
  "editor.adj.saturation": "Sýtosť",
  "editor.adj.exposure": "Expozícia",
  "editor.adj.highlights": "Svetlá",
  "editor.adj.shadows": "Tiene",
  "editor.adj.temperature": "Teplota",
  "editor.adj.tone": "Odtieň",
  "editor.filter.none": "Originál",
  "editor.filter.bw": "Čiernobiela",
  "editor.filter.sepia": "Sépia",
  "editor.filter.vintage": "Vintage",
  "editor.filter.vivid": "Živé",
  "editor.filter.cool": "Studené",
  "editor.filter.warm": "Teplé",
  "editor.crop.free": "Voľne",
  "editor.crop.original": "Originál",
  "editor.redact.black": "Začierniť",
  "editor.redact.pixelate": "Pixelovať",
  "editor.redact.brush": "Veľkosť štetca",
  "editor.redact.undoStroke": "Späť posledný",
  "editor.redact.clear": "Vymazať",
  "editor.rotate": "Otočiť doprava",
  "editor.flipH": "Prevrátiť vodorovne",
  "editor.flipV": "Prevrátiť zvisle",
  "editor.discardTitle": "Zahodiť zmeny?",
  "editor.discardBody": "Vykonané zmeny sa neuložia.",
  "editor.discardConfirm": "Zahodiť",
};
