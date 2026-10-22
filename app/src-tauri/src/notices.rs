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

//! What a delete in the file manager did, said in a notification. Shared by the Linux
//! Files drive and the Windows File Explorer folder: both delete into the Proton trash
//! where the file manager says "permanently", so the app says what really happened.

#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

/// What a delete in the file manager actually did to the library. The file manager itself
/// says it deletes "permanently", which is never true here, so the app says what was.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Notice {
    Trashed,
    LeftAlbum(String),
    Unfavorited,
    AlbumDeleted(String),
    /// Dragged out of `Trash/` back onto the timeline or into an album.
    Restored,
    /// A delete in `Trash/`, refused: it stays in the Proton trash. Linux only: on
    /// Windows, Explorer reports the refusal itself.
    #[cfg_attr(windows, allow(dead_code))]
    TrashKept,
    /// Something dropped into `Shared/` or `Trash/`, which take nothing. Linux only, as
    /// `TrashKept` is.
    #[cfg_attr(windows, allow(dead_code))]
    ReadOnly,
}

/// The notice's title and text, in the app's language: `{n}` is how many photos, `{album}`
/// the album's name.
pub(crate) fn notice_text(lang: &str, notice: &Notice) -> (&'static str, &'static str) {
    let i = match notice {
        Notice::Trashed => 0,
        Notice::LeftAlbum(_) => 1,
        Notice::Unfavorited => 2,
        Notice::AlbumDeleted(_) => 3,
        Notice::Restored => 4,
        Notice::TrashKept => 5,
        Notice::ReadOnly => 6,
    };
    let table: [(&str, &str); 7] = match lang {
        "hu" => [
            ("A Proton kukájába került ({n})", "Ha tévedés volt, 30 napon belül visszaállíthatod a Trash mappából."),
            ("Kikerült a(z) „{album}” albumból ({n})", "Csak az albumból: a fotók a Photos mappában megvannak."),
            ("Kikerült a kedvencek közül ({n})", "A fotók a Photos mappában megvannak."),
            ("A(z) „{album}” album törölve", "A fotói a Photos mappában megvannak."),
            ("Visszaállítva a kukából ({n})", "A fotók újra a Photos mappában vannak."),
            ("A Proton kukájában maradt ({n})", "A Trash mappából a Fájlokban semmi nem törlődik. Visszaállításhoz húzd a Photos mappába, a kukát az appban ürítheted."),
            ("Ide nem lehet feltölteni ({n})", "A Shared és a Trash mappa csak olvasható. A fotókat a Photos mappába vagy egy albummappába húzd."),
        ],
        "de" => [
            ("In den Proton-Papierkorb verschoben ({n})", "Falls das ein Versehen war: innerhalb von 30 Tagen aus Trash wiederherstellen."),
            ("Aus „{album}“ entfernt ({n})", "Nur aus dem Album: die Fotos sind weiterhin in Photos."),
            ("Aus den Favoriten entfernt ({n})", "Die Fotos sind weiterhin in Photos."),
            ("Album „{album}“ gelöscht", "Seine Fotos sind weiterhin in Photos."),
            ("Aus dem Papierkorb wiederhergestellt ({n})", "Die Fotos sind wieder in Photos."),
            ("Im Proton-Papierkorb behalten ({n})", "Aus Trash wird in Dateien nichts gelöscht. Zum Wiederherstellen nach Photos ziehen; geleert wird der Papierkorb in der App."),
            ("Hier kann nichts hinzugefügt werden ({n})", "Shared und Trash sind schreibgeschützt. Fotos nach Photos oder in einen Albumordner ziehen."),
        ],
        "es" => [
            ("Movido a la papelera de Proton ({n})", "Si fue un error, restáuralo desde Trash en 30 días."),
            ("Quitado de «{album}» ({n})", "Solo del álbum: las fotos siguen en Photos."),
            ("Quitado de Favoritos ({n})", "Las fotos siguen en Photos."),
            ("Álbum «{album}» eliminado", "Sus fotos siguen en Photos."),
            ("Restaurado de la papelera ({n})", "Las fotos vuelven a estar en Photos."),
            ("Se queda en la papelera de Proton ({n})", "Desde Archivos no se elimina nada de Trash. Para restaurar, arrastra a Photos; la papelera se vacía en la app."),
            ("Aquí no se puede añadir nada ({n})", "Shared y Trash son de solo lectura. Suelta las fotos en Photos o en la carpeta de un álbum."),
        ],
        "fr" => [
            ("Placé dans la corbeille Proton ({n})", "En cas d'erreur, restaurez depuis Trash sous 30 jours."),
            ("Retiré de « {album} » ({n})", "Seulement de l'album : les photos restent dans Photos."),
            ("Retiré des favoris ({n})", "Les photos restent dans Photos."),
            ("Album « {album} » supprimé", "Ses photos restent dans Photos."),
            ("Restauré depuis la corbeille ({n})", "Les photos sont de retour dans Photos."),
            ("Conservé dans la corbeille Proton ({n})", "Rien n'est supprimé de Trash depuis Fichiers. Pour restaurer, faites glisser vers Photos ; la corbeille se vide dans l'app."),
            ("Rien ne peut être ajouté ici ({n})", "Shared et Trash sont en lecture seule. Déposez les photos dans Photos ou dans le dossier d'un album."),
        ],
        "it" => [
            ("Spostato nel cestino di Proton ({n})", "Se è stato un errore, ripristina da Trash entro 30 giorni."),
            ("Rimosso da «{album}» ({n})", "Solo dall'album: le foto sono ancora in Photos."),
            ("Rimosso dai preferiti ({n})", "Le foto sono ancora in Photos."),
            ("Album «{album}» eliminato", "Le sue foto sono ancora in Photos."),
            ("Ripristinato dal cestino ({n})", "Le foto sono di nuovo in Photos."),
            ("Rimasto nel cestino di Proton ({n})", "Da File non si elimina nulla da Trash. Per ripristinare trascina in Photos; il cestino si svuota nell'app."),
            ("Qui non si può aggiungere nulla ({n})", "Shared e Trash sono di sola lettura. Trascina le foto in Photos o nella cartella di un album."),
        ],
        "nl" => [
            ("Naar de Proton-prullenbak verplaatst ({n})", "Was dat een vergissing? Herstel binnen 30 dagen vanuit Trash."),
            ("Uit ‘{album}’ gehaald ({n})", "Alleen uit het album: de foto's staan nog in Photos."),
            ("Uit favorieten gehaald ({n})", "De foto's staan nog in Photos."),
            ("Album ‘{album}’ verwijderd", "De foto's staan nog in Photos."),
            ("Hersteld uit de prullenbak ({n})", "De foto's staan weer in Photos."),
            ("In de Proton-prullenbak gebleven ({n})", "Uit Trash wordt in Bestanden niets verwijderd. Sleep naar Photos om te herstellen; legen doe je in de app."),
            ("Hier kan niets worden toegevoegd ({n})", "Shared en Trash zijn alleen-lezen. Zet foto's in Photos of in een albummap."),
        ],
        "pl" => [
            ("Przeniesiono do kosza Proton ({n})", "Jeśli to pomyłka, przywróć z Trash w ciągu 30 dni."),
            ("Usunięto z albumu „{album}” ({n})", "Tylko z albumu: zdjęcia nadal są w Photos."),
            ("Usunięto z ulubionych ({n})", "Zdjęcia nadal są w Photos."),
            ("Usunięto album „{album}”", "Jego zdjęcia nadal są w Photos."),
            ("Przywrócono z kosza ({n})", "Zdjęcia znów są w Photos."),
            ("Pozostało w koszu Proton ({n})", "W Plikach nic nie jest usuwane z Trash. Aby przywrócić, przeciągnij do Photos; kosz opróżnisz w aplikacji."),
            ("Tu nie można nic dodać ({n})", "Shared i Trash są tylko do odczytu. Upuść zdjęcia w Photos lub w folderze albumu."),
        ],
        "cs" => [
            ("Přesunuto do koše Proton ({n})", "Pokud to byla chyba, obnovte je z Trash do 30 dní."),
            ("Odebráno z alba „{album}“ ({n})", "Jen z alba: fotky jsou dál v Photos."),
            ("Odebráno z oblíbených ({n})", "Fotky jsou dál v Photos."),
            ("Album „{album}“ smazáno", "Jeho fotky jsou dál v Photos."),
            ("Obnoveno z koše ({n})", "Fotky jsou zpět v Photos."),
            ("Zůstalo v koši Proton ({n})", "Ze složky Trash se v Souborech nic nemaže. Pro obnovení přetáhněte do Photos; koš vyprázdníte v aplikaci."),
            ("Sem nelze nic přidat ({n})", "Shared a Trash jsou jen pro čtení. Fotky přetáhněte do Photos nebo do složky alba."),
        ],
        "sk" => [
            ("Presunuté do koša Proton ({n})", "Ak to bola chyba, obnovte ich z Trash do 30 dní."),
            ("Odobraté z albumu „{album}“ ({n})", "Len z albumu: fotky sú ďalej v Photos."),
            ("Odobraté z obľúbených ({n})", "Fotky sú ďalej v Photos."),
            ("Album „{album}“ vymazaný", "Jeho fotky sú ďalej v Photos."),
            ("Obnovené z koša ({n})", "Fotky sú späť v Photos."),
            ("Zostalo v koši Proton ({n})", "Z priečinka Trash sa v Súboroch nič nemaže. Na obnovenie potiahnite do Photos; kôš vyprázdnite v aplikácii."),
            ("Sem nemožno nič pridať ({n})", "Shared a Trash sú len na čítanie. Fotky potiahnite do Photos alebo do priečinka albumu."),
        ],
        "sl" => [
            ("Premaknjeno v Protonov koš ({n})", "Če je bila pomota, jih v 30 dneh obnovite iz Trash."),
            ("Odstranjeno iz albuma »{album}« ({n})", "Samo iz albuma: fotografije so še vedno v Photos."),
            ("Odstranjeno iz priljubljenih ({n})", "Fotografije so še vedno v Photos."),
            ("Album »{album}« izbrisan", "Njegove fotografije so še vedno v Photos."),
            ("Obnovljeno iz koša ({n})", "Fotografije so spet v Photos."),
            ("Ostalo v Protonovem košu ({n})", "Iz mape Trash se v Datotekah nič ne izbriše. Za obnovitev povlecite v Photos; koš izpraznite v aplikaciji."),
            ("Sem ni mogoče ničesar dodati ({n})", "Shared in Trash sta samo za branje. Fotografije spustite v Photos ali v mapo albuma."),
        ],
        _ => [
            ("Moved to the Proton trash ({n})", "If that was a mistake, restore from Trash within 30 days."),
            ("Removed from “{album}” ({n})", "Only from the album: the photos are still in Photos."),
            ("Removed from Favorites ({n})", "The photos are still in Photos."),
            ("Album “{album}” deleted", "Its photos are still in Photos."),
            ("Restored from the trash ({n})", "The photos are back in Photos."),
            ("Kept in the Proton trash ({n})", "Nothing is deleted from Trash in Files. To restore, drag into Photos; empty the trash in the app."),
            ("Nothing can be added here ({n})", "Shared and Trash are read-only. Drop photos into Photos or an album's folder."),
        ],
    };
    table[i]
}

/// The app's language on Windows: the one chosen in its settings, else the language
/// Windows shows itself in, which is what the window picks too.
#[cfg(windows)]
fn app_language(app: &tauri::AppHandle) -> String {
    if let Some(lang) = crate::page_setting(app, "lang").and_then(|v| v.as_str().map(str::to_string)) {
        return lang.chars().take(2).collect::<String>().to_lowercase();
    }
    // The primary language of the user's display language, as a LANGID.
    let primary = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() } & 0x3ff;
    match primary {
        0x05 => "cs",
        0x07 => "de",
        0x0a => "es",
        0x0c => "fr",
        0x0e => "hu",
        0x10 => "it",
        0x13 => "nl",
        0x15 => "pl",
        0x1b => "sk",
        0x24 => "sl",
        _ => "en",
    }
    .to_string()
}

#[cfg(windows)]
fn pending() -> &'static Mutex<HashMap<Notice, usize>> {
    static PENDING: OnceLock<Mutex<HashMap<Notice, usize>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Count one photo into a notice, shown a moment later together with every other one the
/// same action touched, so deleting fifty is one notice rather than fifty.
#[cfg(windows)]
pub(crate) fn tell(app: &tauri::AppHandle, notice: Notice) {
    let first = {
        let mut pending = pending().lock().unwrap();
        let count = pending.entry(notice.clone()).or_insert(0);
        *count += 1;
        *count == 1
    };
    if !first {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let count = pending().lock().unwrap().remove(&notice).unwrap_or(1);
        let (title, body) = notice_text(&app_language(&app), &notice);
        let album = match &notice {
            Notice::LeftAlbum(a) | Notice::AlbumDeleted(a) => a.as_str(),
            _ => "",
        };
        let fill = |s: &str| s.replace("{n}", &count.to_string()).replace("{album}", album);
        if let Err(e) = toast(&fill(title), &fill(body)) {
            crate::note(&app, &format!("[explorer] notification not shown: {e}"));
        }
    });
}

/// The id Windows files the app's notifications under: the installer's own, so they
/// group with the app in the notification centre.
#[cfg(windows)]
const AUMID: &str = "eu.akoos.photos.desktop";

/// A notification in the Windows notification centre. An app that is not packaged has
/// to name itself to Windows first, by its id, a display name and an icon.
#[cfg(windows)]
fn toast(title: &str, body: &str) -> windows::core::Result<()> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    register_app();
    let xml = format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_escape(title),
        xml_escape(body)
    );
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
}

/// Names the app to Windows for its notifications, once per run: per user, under
/// `HKCU\Software\Classes\AppUserModelId`, with the icon written beside the app's data.
#[cfg(windows)]
fn register_app() {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        let icon = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .map(|d| d.join(AUMID).join("notification.png"));
        if let Some(icon) = &icon {
            let _ = std::fs::write(icon, include_bytes!("../icons/128x128.png"));
        }
        let Ok((key, _)) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(format!("Software\\Classes\\AppUserModelId\\{AUMID}"))
        else {
            return;
        };
        let _ = key.set_value("DisplayName", &"Photos for Proton");
        if let Some(icon) = icon {
            let _ = key.set_value("IconUri", &icon.to_string_lossy().into_owned());
        }
    });
}

#[cfg(windows)]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shows a real notification, to look at: `cargo test -- --ignored shows_a_notification`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn shows_a_notification() {
        toast("Moved to the Proton trash (2)", "If that was a mistake, restore from Trash within 30 days.").unwrap();
    }

    #[test]
    fn every_language_says_what_a_delete_did() {
        let notices = [
            Notice::Trashed,
            Notice::LeftAlbum("a".into()),
            Notice::Unfavorited,
            Notice::AlbumDeleted("a".into()),
            Notice::Restored,
            Notice::TrashKept,
            Notice::ReadOnly,
        ];
        for lang in ["en", "hu", "de", "es", "fr", "it", "nl", "pl", "cs", "sk", "sl", "xx"] {
            for notice in &notices {
                let (title, body) = notice_text(lang, notice);
                assert!(!title.is_empty() && !body.is_empty(), "{lang} {notice:?}");
                let counted = !matches!(notice, Notice::AlbumDeleted(_));
                assert_eq!(title.contains("{n}"), counted, "{lang} {notice:?}");
                let named = matches!(notice, Notice::LeftAlbum(_) | Notice::AlbumDeleted(_));
                assert_eq!(title.contains("{album}"), named, "{lang} {notice:?}");
            }
        }
        // An unknown language reads English.
        assert_eq!(notice_text("xx", &Notice::Trashed), notice_text("en", &Notice::Trashed));
    }
}
