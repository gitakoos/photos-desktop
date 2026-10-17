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

// Czech (cs) strings. Keys mirror en.ts exactly.
export const cs: Record<string, string> = {
  // Common
  "common.cancel": "Zrušit",
  "common.close": "Zavřít",
  "common.back": "Zpět",
  "common.loading": "Načítání…",
  "common.photoCount.one": "{count} fotka",
  "common.photoCount.other": "{count} fotek",

  // Navigation
  "nav.photos": "Fotky",
  "nav.albums": "Alba",
  "nav.shared": "Sdílené",
  "nav.trash": "Koš",

  "settings.sidebarLayout": "Postranní panel",
  "settings.sidebarLayoutDesc": "Umístí navigaci a váš profil do sbalitelného postranního panelu vlevo. Experimentální a stále se dolaďuje.",
  "sidebar.collapse": "Sbalit",
  "sidebar.expand": "Rozbalit",
  "sidebar.showAlbums": "Zobrazit alba",
  "sidebar.hideAlbums": "Skrýt alba",
  "sidebar.downloading": "Stahování",
  "sidebar.indexing": "Indexování",
  "sidebar.dropHint": "nebo sem přetáhněte soubory",

  // App shell
  "app.restoring": "Obnovování relace…",
  "update.available": "Je dostupná aktualizace {version}",
  "update.now": "Aktualizovat",
  "update.updating": "Aktualizace…",
  "update.failed": "Aktualizace selhala",
  "update.hashError": "Stažený soubor neprošel ověřením",
  "menu.reload": "Znovu načíst",
  "menu.moreSoon": "Brzy více…",
  "menu.quit": "Ukončit",

  // Tray popup
  "tray.open": "Otevřít Photos for Proton",
  "tray.syncNow": "Synchronizovat nyní",
  "tray.syncing": "Synchronizace…",
  "tray.synced": "Aktuální",
  "tray.locked": "Uzamčeno",
  "tray.lockedHint": "Otevři pro odemknutí",
  "tray.signedOut": "Nepřihlášeno",
  "tray.signedOutHint": "Otevři pro přihlášení",

  // Login
  "login.subtitle": "Přihlas se ke svému účtu Proton",
  "login.emailLabel": "E-mail nebo uživatelské jméno",
  "login.passwordLabel": "Heslo",
  "login.passwordPlaceholder": "Heslo",
  "login.signIn": "Přihlásit se",
  "login.signingIn": "Přihlašování…",
  "login.twofaLabel": "Dvoufaktorový kód",
  "login.verify": "Ověřit",
  "login.verifying": "Ověřování…",
  "login.captchaHint": "Proton tě žádá o potvrzení, že jsi člověk.",
  "login.captchaExpired": "Platnost captcha vypršela. Vyřeš ji prosím znovu.",
  "login.withBrowser": "Přihlásit se v prohlížeči",
  "login.withBrowserHint": "Přihlásíš se na vlastní stránce Protonu. Tvé heslo se do této aplikace nikdy nedostane.",
  "login.withPassword": "Raději se přihlásit e-mailem a heslem",
  "login.or": "nebo e-mailem a heslem",
  "login.browserWaiting": "Dokonči přihlášení v prohlížeči. Toto okno pak pokračuje samo.",
  "login.browserOpenAgain": "Otevřít stránku znovu",
  "login.browserCopy": "Kopírovat odkaz",
  "login.browserCopied": "Odkaz zkopírován",
  "login.browserNotOpened": "Prohlížeč se neotevřel. Zkopíruj odkaz a otevři ho sám.",
  "login.browserTimeout": "Přihlášení trvalo příliš dlouho. Zkus to prosím znovu.",
  "login.sessionEnded": "Tvá relace skončila. Přihlas se prosím znovu.",
  "login.unofficial": "Toto je aplikace třetí strany, kterou Proton oficiálně nepodporuje.",
  "protect.intro": "Jak má tento počítač udržet tvé přihlášení?",
  "protect.password": "Vlastním heslem",
  "protect.passwordDesc": "Aplikace ho chce při každém spuštění. Může být jakékoli, není to tvé heslo k Protonu.",
  "protect.newPassword": "Heslo pro tuto aplikaci",
  "protect.repeatPassword": "Zopakuj heslo",
  "protect.device": "Bez hesla",
  "protect.deviceDesc": "Aplikace se otevře hned. Chrání ji tvůj účet Windows: kdo se do něj přihlásí, otevře i aplikaci.",
  "protect.continue": "Pokračovat",
  "protect.tooShort": "Použij alespoň {n} znaků.",
  "protect.mismatch": "Hesla se neshodují.",

  // Lock screen (returning cold start)
  "lock.subtitle": "Zadej své heslo pro odemknutí",
  "lock.unlock": "Odemknout",
  "lock.unlocking": "Odemykání…",
  "lock.wrongPassword": "Nesprávné heslo",
  "lock.failed": "Nepodařilo se odemknout. Zkus to prosím znovu.",
  "lock.differentAccount": "Použít jiný účet",

  // Titlebar
  "titlebar.minimize": "Minimalizovat",
  "titlebar.maximize": "Maximalizovat",

  // Settings
  "settings.title": "Nastavení",
  "settings.general": "Obecné",
  "settings.launchAtLogin": "Spouštět s Windows",
  "settings.launchAtLoginDesc": "Spustí se na pozadí při přihlášení do Windows a zobrazí jen ikonu v oznamovací oblasti, dokud aplikaci neotevřete.",
  "settings.launchAtLoginLinux": "Spouštět po přihlášení",
  "settings.launchAtLoginLinuxDesc": "Otevře Photos for Proton po přihlášení k počítači.",
  "settings.keepRunning": "Běžet i po zavření",
  "settings.keepRunningDesc":
    "Po zavření okna Photos for Proton dál běží, takže Proton Photos v Souborech funguje dál. Znovu ho otevřete ze seznamu aplikací; ukončit ho lze v nabídce účtu.",
  "settings.appearance": "Vzhled",
  "settings.theme": "Motiv",
  "settings.themeDesc": "Systém se řídí Windows a průběžně se přizpůsobuje jeho změnám.",
  "settings.theme.dark": "Tmavý",
  "settings.theme.light": "Světlý",
  "settings.theme.system": "Systém",
  "settings.palette": "Paleta",
  "settings.paletteDesc": "Barevný akcent používaný v celé aplikaci.",
  "settings.palette.default": "Výchozí",
  "settings.palette.forest": "Les",
  "settings.palette.sunset": "Západ slunce",
  "settings.palette.sea": "Moře",
  "settings.palette.sepia": "Sépie",
  "settings.palette.mono": "Mono",
  "settings.palette.amoled": "Čistá černá (AMOLED)",
  "settings.language": "Jazyk",
  "settings.languageDesc": "Zvol jazyk zobrazení.",
  "settings.timeline": "Časová osa",
  "settings.hideAlbum": "Skrýt fotky v albech na Drive",
  "settings.hideAlbumDesc":
    "Fotky přidané do alba na Drive se neobjeví na tvé hlavní časové ose. Stále se zobrazují v záložkách Alba a Sdílené a ve filtrech kategorií.",
  "settings.security": "Zabezpečení",
  "settings.about": "O aplikaci",
  "settings.checkUpdates": "Zkontrolovat aktualizace",
  "settings.upToDate": "Máte nejnovější verzi",
  "settings.website": "Webová stránka",
  "settings.sourceCode": "Zdrojový kód",
  "settings.authorRole": "Tvůrce a správce",
  "settings.support": "Kup mi kávu",
  "settings.supportDesc": "Podpořte aplikaci a její vývoj",
  "settings.lockOnHide": "Vyžadovat heslo při opětovném otevření z oznamovací oblasti",
  "settings.deviceProtected": "Chráněno tvým účtem Windows",
  "settings.deviceProtectedDesc": "Aplikace se otevírá bez hesla. Chceš-li heslo, odhlas se a znovu se přihlas.",
  "settings.debug": "Ladicí překryv",
  "settings.debugDesc": "Zobrazit živý přehled paměti (velikost haldy a mezipaměti).",
  "settings.explorer": "Průzkumník souborů",
  "settings.showInExplorer": 'Zobrazit "Proton Photos" v Průzkumníku souborů',
  "settings.showInExplorerDesc":
    "Přidá do postranního panelu Průzkumníka položku Proton Photos s tvými cloudovými fotkami. Projeví se po restartu.",
  "settings.autoDownload": "Automaticky stahovat nové fotky",
  "settings.autoDownloadDesc":
    "Jakmile se do tvé knihovny přidají nové fotky, automaticky se stáhnou do složky Proton Photos.",
  "settings.autoDownloadNeedsExplorer":
    'Funguje jen s "Proton Photos" v Průzkumníku souborů, což je vypnuté. Stahování funguje dál: zeptá se tě, kam fotky uložit.',
  "settings.restartNeeded": "Restartuj, aby se změna projevila.",
  "settings.restartNow": "Restartovat nyní",
  "settings.filesDrive": "Správce souborů",
  "settings.filesDriveShow": 'Zobrazit "Proton Photos" v Souborech',
  "settings.filesDriveShowDesc":
    "Přidá Proton Photos do postranního panelu Souborů a dalších správců souborů. Odtud můžete fotky otevírat a kopírovat a přetažením fotek nebo složek je nahrát: ze složky se stane album, nebo se po vložení do Photos přidá na časovou osu. Funguje, když aplikace běží a je odemčená.",
  "settings.filesDriveAddress": "Adresa",
  "settings.filesDriveAddressDesc":
    "Pro správce souborů bez položky v postranním panelu: připojte se k této adrese. V Dolphinu použijte webdav:// místo dav://.",
  "settings.filesDriveCopy": "Kopírovat",
  "settings.filesDriveCopied": "Zkopírováno",
  "settings.filesDriveEdits": "Povolit mazání a přejmenování",
  "settings.filesDriveEditsDesc":
    "Fotka smazaná v Photos se přesune do koše Proton, odkud ji lze 30 dní obnovit. Smazaná ve složce alba jen z alba zmizí; smazání složky alba smaže album a jeho fotky zachová. Ze složky Trash nelze v Souborech nic smazat.",
  "settings.filesDriveByDate": "Rozdělit Photos podle roku a měsíce",
  "settings.filesDriveByDateDesc":
    "Zobrazí Photos jako složky roků a měsíců místo jednoho dlouhého seznamu.",
  "settings.filesDriveServer": "Adresa a port",
  "settings.filesDriveServerDesc":
    "Kde disk na tomto počítači naslouchá: localhost nebo adresa od 127.0.0.1 do 127.255.255.254. Ponechte port prázdný a použije se libovolný volný. Na vaší síti nikdy nenaslouchá.",
  "settings.filesDriveAutoPort": "auto",
  "settings.filesDriveApply": "Použít",
  "settings.filesDriveErrAddress": "Použijte localhost nebo adresu začínající 127.",
  "settings.filesDriveErrPort": "Použijte port od 1024 do 65535, nebo ho nechte prázdný.",
  "settings.filesDriveErrInUse": "Tento port už používá něco jiného. Disk zůstává, kde byl.",
  "settings.filesDrivePortTaken":
    "Zvolený port byl při spuštění aplikace obsazený, takže se do jeho uvolnění používá jiný.",
  // File types. The "Open with" entries are the app's own to add and take back out;
  // the default handler is not, so that half leads out to Windows rather than
  // pretending to a choice Windows takes from the user alone.
  "settings.fileTypes": "Typy souborů",
  "settings.openWith": 'Přidat do nabídky "Otevřít v programu"',
  "settings.openWithDesc":
    'Uvede Photos for Proton v nabídce Windows "Otevřít v programu" u fotek JPEG, PNG, GIF, WebP, AVIF, BMP, TIFF a HEIC a u videí MP4, MOV, M4V a WebM. Po vypnutí se položky zase odeberou.',
  "settings.fileTypesFailed": "Typy souborů se nepodařilo změnit. Zkus to prosím znovu.",
  "settings.defaultApp": "Výchozí aplikace pro fotky a videa",
  "settings.defaultAppDesc":
    "Takto se nic výchozím nestane: tuhle volbu Windows přijme jen od tebe, nikdy od programu. Vyber Photos for Proton v nastavení Windows v části Výchozí aplikace.",
  "settings.defaultAppOpen": "Otevřít nastavení Windows",
  "settings.defaultAppFailed": "Nastavení Windows se nepodařilo otevřít. Zkus to prosím znovu.",
  "settings.lockOnHideDesc":
    "Když se okno zavře do oznamovací oblasti, aplikace se zamkne a při příštím otevření tě požádá o heslo.",
  "settings.storage": "Úložiště",
  // Two different places a photo can be kept on this machine: encrypted inside the
  // app, or downloaded into the Proton Photos folder where Windows can read it. The
  // panel names both rather than adding one number to the other.
  "settings.downloadedCount.one": "{count} fotka stažena",
  "settings.downloadedCount.other": "{count} fotek staženo",
  "settings.downloadedNone": "Nic není staženo",
  "settings.downloadedDesc":
    "Stažené fotky jsou běžné soubory ve složce Proton Photos, takže je může přečíst vyhledávání Windows i jiné programy. Uvolnění odstraní jen tyto místní kopie a tvoje fotky zůstávají v Protonu.",
  "settings.freeUpAll": "Uvolnit {size}",
  "settings.freeUpNothing": "Není co uvolnit",
  "settings.freeingUp": "Uvolňování…",
  "settings.storageOffline": "Offline fotky",
  "settings.storageExplorer": "V Průzkumníku souborů",
  "settings.offlineCount.one": "{count} fotka v aplikaci",
  "settings.offlineCount.other": "{count} fotek v aplikaci",
  "settings.offlineNone": "V aplikaci nejsou uloženy žádné fotky",
  "settings.offlineDesc":
    "Fotky označené jako dostupné offline zůstávají zašifrované uvnitř aplikace. Otevřou se i bez připojení a nikdy se neobjeví ve složce Proton Photos, takže je nic mimo aplikaci nepřečte.",
  "settings.offlineSaving": "Ukládání {done}/{total}…",
  "settings.offlineRemoveAll": "Uvolnit {size}",
  "settings.offlineRemoveNothing": "Není co uvolnit",
  "settings.offlineRemoving": "Odebírání…",
  "settings.freeUpFailed": "Místo se nepodařilo uvolnit. Zkus to prosím znovu.",

  // Profile menu
  "profile.storage": "Úložiště",
  "profile.used": "{size} využito",
  "profile.total": "{size} celkem",
  "profile.signOut": "Odhlásit se",

  // Avatar
  "avatar.uploading": "Nahrávání",
  "avatar.syncing": "Synchronizace",
  "avatar.account": "Účet a nastavení",
  "avatar.showUploads": "Zobrazit nahrávání",

  // Photos view
  "photos.all": "Vše",
  "photos.search": "Hledat",
  "photos.searchPlaceholder": "Hledat podle názvu nebo typu souboru…",
  "photos.closeSearch": "Zavřít hledání",
  "photos.indexing": "Indexování {done}/{total}",
  "photos.uploadTitle": "Nahrát fotky nebo složku jako album",
  "photos.uploadingProgress": "Nahrávání {progress}",
  "photos.noMatches": "Žádné shody",
  "photos.noPhotos": "Zatím žádné fotky",
  "photos.noPhotosSub": "Tvé fotky se zde objeví po synchronizaci.",
  "photos.stillIndexing": "Indexování stále probíhá, další výsledky se objeví.",
  "photos.dropTitle": "Přetáhni sem pro nahrání",
  "photos.dropSub": "Ze složky vznikne album se stejným názvem",
  "photos.offline": "Dostupné offline, zašifrované v aplikaci",
  "photos.downloaded": "Staženo do složky Proton Photos",
  "photos.renameTitle": "Přejmenovat fotku",
  "photos.namePlaceholder": "Název souboru",

  // Tile badges
  "badge.motionPhoto": "Pohyblivá fotka",
  "badge.panorama": "Panorama",
  "badge.raw": "RAW",
  "badge.favorite": "Oblíbené",

  // Search type filters
  "filter.images": "Obrázky",
  "filter.videos": "Videa",

  // Filter panel
  "filter.title": "Filtr",
  "filter.categories": "Kategorie",
  "filter.type": "Typ",
  "filter.mediaAll": "Vše",
  "filter.mediaPhotos": "Fotky",
  "filter.reset": "Resetovat",

  // Categories
  "category.fav": "Oblíbené",
  "category.screen": "Snímky obrazovky",
  "category.video": "Videa",
  "category.live": "Živé fotky",
  "category.selfie": "Selfie",
  "category.portrait": "Portréty",
  "category.burst": "Sériové snímky",
  "category.pano": "Panoramata",
  "category.raw": "RAW",

  // Albums
  "albums.backToAlbums": "Zpět na alba",
  "albums.untitled": "Album bez názvu",
  "albums.empty": "Toto album je prázdné",
  "albums.none": "Zatím žádná alba",
  "albums.noneSub": "Vytvoř ho tady, nebo přetáhni složku do okna.",
  "albums.keepDownloaded": "Stáhnout toto album do složky Proton Photos",
  "albums.keptDownloaded": "Stahování do složky Proton Photos (kliknutím ukončíš)",
  "albums.freeUpTitle": "Uvolnit místo tohoto alba?",
  "albums.freeUpCount.one":
    "Album se už samo nestahuje. {count} fotka už je ve složce Proton Photos a může tu zůstat, nebo můžeš uvolnit místo, které zabírá. V obou případech zůstává v Protonu.",
  "albums.freeUpCount.other":
    "Album se už samo nestahuje. {count} fotek už je ve složce Proton Photos a mohou tu zůstat, nebo můžeš uvolnit místo, které zabírají. V obou případech zůstávají v Protonu.",
  "albums.freeUpKeep": "Ponechat stažené",
  "albums.freeUpConfirm": "Uvolnit",
  "albums.newAlbum": "Nové album",
  "albums.searchHint": "Hledat alba",
  "albums.searchEmpty": "Žádná alba neodpovídají hledání",
  "albums.sortName": "Název (A-Z)",
  "albums.sortActivity": "Poslední aktivita",
  "albums.sortCount": "Počet fotek",
  "albums.pin": "Připnout",
  "albums.unpin": "Odepnout",
  "albums.pinLimit": "Můžeš připnout až 5 alb",
  "albums.newTitle": "Pojmenuj album",
  "albums.namePlaceholder": "Název alba",
  "albums.create": "Vytvořit",
  "albums.createAndAdd": "Vytvořit a přidat",
  "albums.rename": "Přejmenovat",
  "albums.renameTitle": "Přejmenovat album",
  "albums.share": "Sdílet album",
  "albums.delete": "Smazat album",
  "albums.more": "Více",
  "albums.addPhotos": "Přidat fotky",
  "albums.addFromLibrary": "Z vaší knihovny",
  "albums.addFromComputer": "Z tohoto počítače",
  "albums.deleted": "Album smazáno",
  "albums.addTitle": "Přidat do alba",
  "albums.addCount.one": "Vyber, kam patří {count} fotka.",
  "albums.addCount.other": "Vyber, kam patří fotky ({count}).",
  "albums.added": "{count} přidáno",
  "albums.addPartial": "Přidáno {ok}, {failed} selhalo",
  "albums.removed": "{count} odebráno z alba",
  "albums.removePartial": "Odebráno {ok}, {failed} selhalo",
  "albums.coverSet": "Obal aktualizován",
  "albums.strandedTitle.one": "{count} fotka je jen v tomto albu",
  "albums.strandedTitle.other": "Jen v tomto albu jsou fotky ({count})",
  "albums.strandedMsg.one":
    "Není na tvé časové ose, takže se smazáním alba zmizí i ona. Ulož ji na časovou osu, aby ti zůstala.",
  "albums.strandedMsg.other":
    "Nejsou na tvé časové ose, takže se smazáním alba zmizí i ony. Ulož je na časovou osu, aby ti zůstaly.",
  "albums.savePhotos": "Uložit na časovou osu",
  "albums.deletePhotosToo": "Smazat i fotky",

  // Shared
  "shared.byMe": "Sdílené mnou",
  "shared.withMe": "Sdílené se mnou",
  "shared.flip": "Přepnout mezi sdílenými mnou a sdílenými se mnou",
  "shared.emptyByTitle": "Nic nesdílíš",
  "shared.emptyWithTitle": "S tebou není nic sdíleno",
  "shared.emptyBySub": "Fotky a alba, která sdílíš, se zobrazí zde.",
  "shared.emptyWithSub": "Fotky a alba, která s tebou sdílejí ostatní, se zobrazí zde.",
  "shared.publicLink": "Sdíleno veřejným odkazem",
  "shared.album": "Album",
  "shared.manage": "Spravovat sdílení",
  "shared.back": "Zpět na sdílené",

  // Share dialog. A public link's URL carries the secret that decrypts what it
  // points at, so copying it whole is the whole point of the link section. A
  // link's password is never read back, so the dialog reports whether one is set
  // rather than showing it.
  "share.title": "Sdílení",
  "share.linkTitle": "Veřejný odkaz",
  "share.linkDesc": "Tuto fotku může otevřít kdokoli, kdo má odkaz.",
  "share.createLink": "Vytvořit odkaz",
  "share.copyLink": "Kopírovat odkaz",
  "share.copied": "Zkopírováno",
  "share.removeLink": "Odebrat odkaz",
  "share.passwordLabel": "Heslo",
  "share.passwordSet": "Nutné k otevření",
  "share.passwordNone": "Nenastaveno",
  "share.passwordPlaceholder": "Nové heslo",
  "share.expiryLabel": "Vyprší",
  "share.expiryNever": "Nikdy",
  "share.expiryPast": "Vyber datum v budoucnosti.",
  "share.add": "Přidat",
  "share.change": "Změnit",
  "share.set": "Nastavit",
  "share.save": "Uložit",
  "share.albumInviteOnly": "Alba se sdílejí pozvánkou, ne veřejným odkazem.",
  "share.peopleTitle": "Lidé",
  "share.emailPlaceholder": "E-mailová adresa",
  "share.invite": "Pozvat",
  "share.roleViewer": "Prohlížející",
  "share.roleEditor": "Editor",
  "share.stateInvited": "Pozván",
  "share.stateExternal": "Pozván (bez účtu Proton)",
  "share.remove": "Odebrat",
  "share.noPeople": "Zatím nikdo",
  "share.stopSharing": "Ukončit sdílení",
  "share.notOwned": "Tohle bylo sdíleno s tebou. Změnit, kdo k tomu má přístup, může jen vlastník.",
  "share.badEmail": "Tohle nevypadá jako e-mailová adresa.",
  "share.copyFailed": "Odkaz se nepodařilo zkopírovat",
  "share.failed": "Sdílení se nepodařilo změnit",
  "share.working": "Probíhá…",

  // Trash
  "trash.emptyTitle": "Koš je prázdný",
  "trash.emptySub": "Fotky přesunuté do koše se objeví tady a můžeš je obnovit.",
  "trash.emptyAction": "Vysypat koš",
  "trash.moved": "{count} přesunuto do koše",
  "trash.movedPartial": "{ok} přesunuto do koše, {failed} selhalo",
  "trash.restored": "{count} obnoveno",
  "trash.deleted": "{count} trvale smazáno",
  "trash.emptied": "Koš vysypán",
  "trash.partial": "Hotovo {ok}, {failed} selhalo",

  // Photo viewer / lightbox
  "viewer.details": "Podrobnosti",
  "viewer.offlineAdd": "Ponechat offline kopii, zašifrovanou v aplikaci",
  "viewer.offlineRemove": "Odebrat offline kopii",
  "viewer.download": "Stáhnout do složky Proton Photos",
  "viewer.saveToFolder": "Uložit kopii, kam chceš",
  "viewer.freeUp": "Odstranit místní kopii a uvolnit místo",
  "viewer.detailsShortcut": "Podrobnosti (I)",
  "viewer.contents": "Obsah",
  "viewer.contentsShortcut": "Obsah (L)",
  "viewer.filmstrip": "Sousední položky",
  "viewer.position": "{n} z {total}",
  "viewer.favoriteShortcut": "Přidat do oblíbených (F)",
  "viewer.unfavoriteShortcut": "Odebrat z oblíbených (F)",
  "viewer.trashShortcut": "Přesunout do koše (Del)",
  "viewer.shareShortcut": "Sdílet (S)",
  "viewer.rename": "Kliknutím přejmenuješ",
  "viewer.closeShortcut": "Zavřít (Esc)",
  "viewer.prev": "Předchozí (←)",
  "viewer.next": "Další (→)",
  "viewer.name": "Název",
  "viewer.type": "Typ",
  "viewer.dimensions": "Rozměry",
  "viewer.taken": "Pořízeno",
  "viewer.added": "Přidáno",
  "viewer.modified": "Změněno",
  "viewer.size": "Velikost",
  "viewer.onServer": "Využité místo",
  "viewer.albums": "Alba",
  "viewer.shared": "Sdílené",
  "viewer.sharedPublic": "Veřejný odkaz",
  "viewer.sharedPeople": "S lidmi",
  "viewer.sharedNo": "Ne",
  "viewer.unverified": " (neověřeno)",
  "viewer.trashFailed": "Tuto fotku se nepodařilo přesunout do koše.",
  "viewer.favoriteFailed": "Oblíbené se nepodařilo aktualizovat.",
  "viewer.downloadFailed": "Tuto fotku se nepodařilo stáhnout.",
  "viewer.zoomOut": "Oddálit",
  "viewer.zoomIn": "Přiblížit",
  "viewer.resetFit": "Přizpůsobit velikosti",
  "viewer.videoLoading": "Načítání videa…",
  "viewer.videoError":
    "Tento formát videa tady nejde přehrát. Stáhni si ho a přehraj v jiném přehrávači.",
  "viewer.videoTooLarge":
    "Toto video je příliš velké, než aby šlo přehrát tady. Stáhni si ho a přehraj v jiném přehrávači.",

  // The viewer's own video controls, which stand in for the browser's.
  "viewer.videoPlay": "Přehrát (mezerník)",
  "viewer.videoPause": "Pozastavit (mezerník)",
  "viewer.videoStepBack": "Předchozí snímek",
  "viewer.videoStepForward": "Další snímek",
  "viewer.videoSeek": "Pozice přehrávání",
  "viewer.videoMute": "Ztlumit",
  "viewer.videoUnmute": "Zrušit ztlumení",

  // Local file viewer: a file opened from File Explorer, which the app can show
  // with nobody signed in. Everything both viewers say alike comes from above.
  "local.camera": "Fotoaparát",
  "local.created": "Vytvořeno",
  "local.path": "Umístění",
  "local.upload": "Nahrát do Protonu",
  "local.uploadUnsupported": "Proton tento typ souboru nepřijímá",
  "local.uploading": "Nahrávání…",
  "local.uploaded": "Uloženo do Protonu",
  "local.uploadSkipped": "Už uloženo",
  "local.uploadFailed": "Nahrání se nezdařilo. Zkus to znovu.",
  "local.delete": "Odstranit",
  "local.deleteTitle": "Odstranit soubor?",
  "local.deleteMessage": "„{name}“ bude přesunut do koše.",
  "local.notFound": "Tento soubor byl přesunut nebo smazán.",
  "local.unreadable":
    "Tento soubor se nepodařilo přečíst. Možná ho má otevřený jiný program, nebo je mimo dosah tohoto účtu.",
  "local.openFailed": "Tento soubor se nepodařilo otevřít.",
  "local.decodeFailed": "Tuto fotku se nepodařilo přečíst. Soubor může být poškozený nebo neúplný.",
  "local.videoUnsupported": "Tento formát videa tady nejde přehrát. Otevři ho v jiném přehrávači.",
  "local.noCodec":
    "Windows nemá pro tento formát dekodér, takže ho tady nelze zobrazit. V Microsoft Storu je to, co u některých chybí: rozšíření HEIF a HEVC pro fotky HEIC a Raw Image Extension pro surové soubory z fotoaparátů.",
  "local.signInTitle": "Přihlas se pro nahrání",
  "local.signInBody":
    "Otevře se okno aplikace, kde se můžeš přihlásit. Tento soubor zůstane otevřený tady.",
  "local.signInAction": "Přihlásit se",

  // Upload panel
  "upload.title": "Nahrát",
  "upload.filterName": "Fotky a videa",
  "upload.dropHint": "Přetáhni fotky nebo složku kamkoli do okna",
  "upload.dropSub":
    "Fotky jdou rovnou na tvou časovou osu. Ze složky vznikne album se stejným názvem.",
  "upload.chooseFiles": "Vybrat soubory",
  "upload.chooseFolder": "Vybrat složku",
  "upload.importTitle": "Import z Fotek Google nebo z Ente",
  "upload.importSub": "Ponechá každé fotce datum, místo a oblíbení podle exportu a z jeho alb udělá alba.",
  "upload.importZip": "Vybrat soubory zip",
  "upload.importFolder": "Vybrat složku exportu",
  "upload.zipFilterName": "Archivy zip",
  "upload.importUnpacking": "Rozbalování části {part} z {parts}: {done} z {total}",
  "upload.importReading": "Načítání exportu…",
  "importReview.title": "Kontrola importu",
  "importReview.hint": "Kliknutím fotku vynecháte, dalším kliknutím ji vrátíte. Shift+kliknutí udělá totéž se všemi fotkami mezi naposledy kliknutou a touto.",
  "importReview.discard": "Zahodit",
  "importReview.statItems": "Položky: {n}",
  "importReview.statAlbums": "Alba: {n}",
  "importReview.statLive": "Live Photos: {n}",
  "importReview.checking": "Hledání už nahraných: {done} / {total}",
  "importReview.statAlready": "Už ve vaší knihovně: {n}",
  "importReview.albumsToggle": "Vytvořit alba",
  "importReview.timeline": "Časová osa",
  "importReview.confirm": "Importovat ({n})",
  "importReview.alreadyBadge": "V knihovně",
  "importReview.noDate": "Bez data",
  "importReview.liveJoined": "Fotka a video se nahrají společně jako jedna Live Photo",
  "upload.alreadyThere": "{count} již nahráno",
  "upload.failedCount": "{count} selhalo",
  "upload.showingRows": "Zobrazeno {shown} z {total} souborů: všechny chyby, co se právě nahrává, a ty nejnovější.",
  "upload.clear": "Vymazat",
  "upload.statusUploading": "nahrávání…",
  "upload.statusSkipped": "přeskočeno",
  "upload.statusQueued": "ve frontě",
  "upload.statusFailed": "selhalo",

  // Grid tile
  "grid.select": "Vybrat",
  "grid.deselect": "Zrušit výběr",

  // Selection bar
  "selection.cancel": "Zrušit výběr (Esc)",
  "selection.count.one": "{count} fotka vybrána",
  "selection.count.other": "{count} fotek vybráno",
  "selection.trash": "Do koše",
  "selection.restore": "Obnovit",
  "selection.deleteForever": "Smazat navždy",
  "selection.more": "Další",
  "selection.download": "Stáhnout",
  "selection.showInFolder": "Zobrazit ve složce",
  "selection.freeUp": "Uvolnit",
  "selection.addToAlbum": "Přidat do alba",
  "selection.removeFromAlbum": "Odebrat z alba",
  "selection.setCover": "Nastavit jako obal",
  "selection.rename": "Přejmenovat",
  "selection.share": "Sdílet",
  "selection.favorite": "Přidat do oblíbených",
  "selection.unfavorite": "Odebrat z oblíbených",
  "selection.offlineAdd": "Dostupné offline",
  "selection.offlineRemove": "Odebrat offline kopii",
  // Download: the copy that lands in the Proton Photos folder, where Windows and any
  // other program can read it. Never called offline, which is the app's own copy.
  "download.freedUp": "{count} uvolněno",
  "download.freedUpNone": "Nic se neuvolnilo",
  "download.notDownloaded": "Není co uvolnit",
  "download.running": "Stahování…",
  "download.progress": "Stahování {done}/{total}…",
  "download.done": "{count} staženo do složky Proton Photos",
  "download.donePartial": "{ok} z {total} staženo",
  "download.doneNone":
    "Nic nebylo staženo. Složka Proton Photos možná ještě není připravená.",
  "download.alreadyDownloaded": "Již staženo",
  "download.saved": "{count} uloženo do složky",
  "download.partial": "Uloženo {ok}, {failed} selhalo",

  // Available offline: the app's own encrypted copy, which is not the Proton Photos
  // folder. These say where the copy went, so the two are never mistaken for one another.
  "offline.added.one": "{count} fotka se ukládá pro offline použití",
  "offline.added.other": "{count} fotek se ukládá pro offline použití",
  "offline.removed.one": "{count} offline kopie odebrána",
  "offline.removed.other": "{count} offline kopií odebráno",
  "offline.alreadyOffline": "Již dostupné offline",
  "offline.noneOffline": "Nejsou žádné offline kopie k odebrání",
  "offline.failed": "nepodařilo se uložit pro offline použití",

  // Trash confirmation
  "confirm.trashTitle": "Přesunout do koše?",
  "confirm.trashConfirm": "Přesunout do koše",
  "confirm.trashCount.one":
    "{count} fotka se přesune do koše. Můžeš ji obnovit na kartě Koš.",
  "confirm.trashCount.other":
    "{count} fotek se přesune do koše. Můžeš je obnovit na kartě Koš.",
  "confirm.trashName":
    '"{name}" se přesune do koše. Můžeš ji obnovit na kartě Koš.',
  "confirm.thisPhoto": "Tato fotka",

  // Remove from album. The photos stay in Photos; only the album loses them.
  "confirm.removeTitle": "Odebrat z alba?",
  "confirm.removeConfirm": "Odebrat",
  "confirm.removeCount.one": "{count} fotka zmizí z tohoto alba, ale zůstane na tvé časové ose.",
  "confirm.removeCount.other":
    "Fotky ({count}) zmizí z tohoto alba, ale zůstanou na tvé časové ose.",

  // Delete-forever confirmation. Nothing in the app or at Proton undoes these.
  "confirm.deleteTitle": "Smazat navždy?",
  "confirm.deleteConfirm": "Smazat navždy",
  "confirm.deleteCount.one":
    "{count} fotka bude trvale smazána z Protonu. Tohle nejde vzít zpět.",
  "confirm.deleteCount.other":
    "{count} fotek bude trvale smazáno z Protonu. Tohle nejde vzít zpět.",
  "confirm.emptyTitle": "Vysypat koš?",
  "confirm.emptyConfirm": "Smazat vše",
  "confirm.emptyMessage":
    "Celý obsah koše bude trvale smazán z Protonu. Tohle nejde vzít zpět.",

  // Deleting an album skips the trash, so the album is gone for good even though
  // the photos in your timeline are not.
  "confirm.deleteAlbumTitle": "Smazat toto album?",
  "confirm.deleteAlbumMessage":
    "Album bude smazáno a nejde ho obnovit. Fotky na tvé časové ose zůstanou.",

  // Revoking sharing takes access away from people who may already hold the link,
  // and nothing is deleted by it, so both of these say exactly what is lost.
  "confirm.removeLinkTitle": "Odebrat odkaz?",
  "confirm.removeLinkMessage":
    "Odkaz přestane fungovat všem, kdo ho mají. Lidé pozvaní e-mailem si přístup ponechají.",
  "confirm.removeLinkConfirm": "Odebrat odkaz",
  "confirm.replaceLinkTitle": "Nahradit odkaz?",
  "confirm.replaceLinkMessage":
    "Tento odkaz je příliš starý na to, aby šel změnit, takže se uložením nahradí novým na jiné adrese. Starý odkaz přestane fungovat všem, kdo ho mají, a jeho heslo se zruší. Nový odkaz se zkopíruje do schránky.",
  "confirm.replaceLinkConfirm": "Nahradit odkaz",
  "confirm.stopSharingTitle": "Ukončit sdílení?",
  "confirm.stopSharingMessage":
    "Odkaz přestane fungovat a všichni pozvaní ztratí přístup. Nic se nesmaže.",
  "confirm.stopSharingConfirm": "Ukončit sdílení",

  // Freeing up drops the downloaded copies only. Nothing leaves Proton, so this asks
  // before a big change without treating it as one there is no way back from.
  "confirm.freeUpAllTitle": "Uvolnit všechny stažené fotky?",
  "confirm.freeUpAllMessage":
    "{size} ve složce Proton Photos se odstraní. Tvoje fotky zůstávají v Protonu a stáhnou se znovu, jakmile je otevřeš.",
  "confirm.freeUpAllConfirm": "Uvolnit",

  // Removing every offline copy. The photos themselves are untouched, so this warns
  // about the download they will need next time and nothing more.
  "confirm.removeOfflineAllTitle": "Odebrat všechny offline kopie?",
  "confirm.removeOfflineAllMessage":
    "{size} uložených zašifrovaně v aplikaci se odstraní. Tvoje fotky zůstávají v Protonu a k jejich opětovnému otevření bude potřeba připojení.",
  "confirm.removeOfflineAllConfirm": "Odebrat",
  // Photo editor
  "editor.edit": "Upravit",
  "editor.title": "Úprava fotky",
  "editor.cancel": "Zrušit",
  "editor.undo": "Zpět",
  "editor.redo": "Znovu",
  "editor.save": "Uložit",
  "editor.saving": "Ukládání…",
  "editor.saved": "Kopie uložena",
  "editor.saveFailed": "Upravenou fotku se nepodařilo uložit",
  "editor.loadFailed": "Tuto fotku se nepodařilo otevřít k úpravě",
  "editor.tool.adjust": "Úpravy",
  "editor.tool.filters": "Filtry",
  "editor.tool.crop": "Oříznout",
  "editor.tool.redact": "Zakrýt",
  "editor.tool.rotate": "Otočit",
  "editor.adj.brightness": "Jas",
  "editor.adj.contrast": "Kontrast",
  "editor.adj.saturation": "Sytost",
  "editor.adj.exposure": "Expozice",
  "editor.adj.highlights": "Světla",
  "editor.adj.shadows": "Stíny",
  "editor.adj.temperature": "Teplota",
  "editor.adj.tone": "Odstín",
  "editor.filter.none": "Originál",
  "editor.filter.bw": "Černobílá",
  "editor.filter.sepia": "Sépie",
  "editor.filter.vintage": "Vintage",
  "editor.filter.vivid": "Živé",
  "editor.filter.cool": "Studené",
  "editor.filter.warm": "Teplé",
  "editor.crop.free": "Volně",
  "editor.crop.original": "Originál",
  "editor.redact.black": "Začernit",
  "editor.redact.pixelate": "Pixelovat",
  "editor.redact.brush": "Velikost štětce",
  "editor.redact.undoStroke": "Zpět poslední",
  "editor.redact.clear": "Vymazat",
  "editor.rotate": "Otočit doprava",
  "editor.flipH": "Překlopit vodorovně",
  "editor.flipV": "Překlopit svisle",
  "editor.discardTitle": "Zahodit změny?",
  "editor.discardBody": "Provedené změny se neuloží.",
  "editor.discardConfirm": "Zahodit",
};
