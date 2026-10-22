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

//! What a change in the Proton Photos folder means for the library.
//!
//! File Explorer changes the folder first and says so afterwards, so the folder is
//! watched and its changes are read back in batches: a file that left one place and
//! arrived in another under the same file id was moved, one that only left was deleted
//! (to the Recycle Bin or for good, which look the same), one that only arrived is new.
//! A batch collapses what one gesture spreads over many events: deleting an album's
//! folder removes its files first and the folder last, and is one album deletion, not a
//! photo taken out of the album per file.
//!
//! The same rules as the Files drive on Linux: the timeline's photos go to Proton's
//! trash, an album's leave that album, a favourite stops being one, an album's folder
//! deletes the album and keeps its photos, and nothing is ever deleted for good. Nothing
//! here touches the disk or the network; it only decides.

/// Where a folder sits in the Proton Photos folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    Root,
    /// `Photos\`: the timeline.
    Photos,
    /// `Photos\Favorites\`.
    Favorites,
    /// `Albums\` itself.
    Albums,
    /// `Albums\<folder>\`, by the folder's name.
    Album(String),
    /// `Shared\` and everything in it: what others shared, read-only.
    Shared,
    /// `Trash\`: read, copied out of and restored from, never emptied from here.
    Trash,
    /// Anywhere deeper, which the library has no place for.
    Other,
}

pub const PHOTOS: &str = "Photos";
pub const FAVORITES: &str = "Favorites";
pub const ALBUMS: &str = "Albums";
pub const SHARED: &str = "Shared";
pub const TRASH: &str = "Trash";

/// The folder a path relative to the root sits in.
pub fn place_of_parent(rel: &str) -> Place {
    let parts: Vec<&str> = rel.split('\\').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 | 1 => Place::Root,
        n => place_of_dir(&parts[..n - 1]),
    }
}

/// The place a folder (given as its path parts) stands for.
pub fn place_of_dir(parts: &[&str]) -> Place {
    let eq = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    match parts {
        [] => Place::Root,
        [p] if eq(p, PHOTOS) => Place::Photos,
        [p, f] if eq(p, PHOTOS) && eq(f, FAVORITES) => Place::Favorites,
        [a] if eq(a, ALBUMS) => Place::Albums,
        [a, name] if eq(a, ALBUMS) => Place::Album(name.to_string()),
        [s, ..] if eq(s, SHARED) => Place::Shared,
        [t, ..] if eq(t, TRASH) => Place::Trash,
        _ => Place::Other,
    }
}

/// The last part of a path: a file's or a folder's own name.
pub fn name_of(rel: &str) -> &str {
    rel.rsplit('\\').next().unwrap_or(rel)
}

/// The folder part of a path, without its last part.
pub fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('\\').map(|(p, _)| p).unwrap_or("")
}

fn read_only(place: &Place) -> bool {
    matches!(place, Place::Shared | Place::Trash)
}

fn on_timeline(place: &Place) -> bool {
    matches!(place, Place::Photos | Place::Root)
}

/// One event as the folder watcher reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawKind {
    Added,
    Removed,
    RenamedOld,
    RenamedNew,
    Modified,
}

#[derive(Debug, Clone)]
pub struct RawEvent {
    pub kind: RawKind,
    pub rel: String,
    pub file_id: i64,
    pub dir: bool,
    /// A cloud placeholder, which only the app ever creates.
    pub placeholder: bool,
}

/// What a batch of events comes to, one entry per thing that happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// It left the folder and arrived nowhere in it: deleted, to the Recycle Bin or
    /// for good, or moved out of the Proton Photos folder.
    Removed { rel: String, dir: bool },
    /// It arrived from nowhere in the folder: made here, copied or moved in.
    Added { rel: String, dir: bool, placeholder: bool },
    /// It left one path and arrived at another under the same file id: a rename when
    /// the folder stayed the same, a move otherwise.
    Moved { from: String, to: String, dir: bool },
}

/// Reads a batch of watcher events as the changes they add up to.
///
/// A file id that both left and arrived moved, whichever pair of events said so. A
/// removal inside a folder that was itself removed belongs to that folder's removal.
/// An arrival of a placeholder is the app's own doing (only the app makes them) and is
/// left out, as is anything that arrived and left again within the batch.
pub fn read_batch(events: &[RawEvent]) -> Vec<Change> {
    use std::collections::HashMap;
    // Per file id, where it was first seen leaving and last seen arriving.
    let mut left: HashMap<i64, (usize, &RawEvent)> = HashMap::new();
    let mut arrived: HashMap<i64, (usize, &RawEvent)> = HashMap::new();
    for (i, e) in events.iter().enumerate() {
        match e.kind {
            RawKind::Removed | RawKind::RenamedOld => {
                // An arrival before this leaving within the batch means it came and went.
                if arrived.remove(&e.file_id).is_none() {
                    left.entry(e.file_id).or_insert((i, e));
                }
            }
            RawKind::Added | RawKind::RenamedNew => {
                arrived.insert(e.file_id, (i, e));
            }
            RawKind::Modified => {}
        }
    }

    let mut out: Vec<(usize, Change)> = Vec::new();
    for (id, (i, from)) in &left {
        if let Some((_, to)) = arrived.get(id) {
            if !from.rel.eq_ignore_ascii_case(&to.rel) {
                out.push((*i, Change::Moved { from: from.rel.clone(), to: to.rel.clone(), dir: from.dir || to.dir }));
            }
        } else {
            out.push((*i, Change::Removed { rel: from.rel.clone(), dir: from.dir }));
        }
    }
    for (id, (i, to)) in &arrived {
        if !left.contains_key(id) && !to.placeholder {
            out.push((*i, Change::Added { rel: to.rel.clone(), dir: to.dir, placeholder: to.placeholder }));
        }
    }
    out.sort_by_key(|(i, _)| *i);
    let mut changes: Vec<Change> = out.into_iter().map(|(_, c)| c).collect();

    // A file that left and a file that arrived under the same name is one file saved
    // over: an editor writes a new file and puts it in the old one's place. That is an
    // edit of the photo, not a deletion of it and a new photo beside it, so neither half
    // is acted on.
    let arrived_at: std::collections::HashSet<String> = changes
        .iter()
        .filter_map(|c| match c {
            Change::Added { rel, dir: false, .. } => Some(rel.to_lowercase()),
            _ => None,
        })
        .collect();
    let replaced: std::collections::HashSet<String> = changes
        .iter()
        .filter_map(|c| match c {
            Change::Removed { rel, dir: false } if arrived_at.contains(&rel.to_lowercase()) => Some(rel.to_lowercase()),
            _ => None,
        })
        .collect();
    changes.retain(|c| match c {
        Change::Removed { rel, dir: false } | Change::Added { rel, dir: false, .. } => {
            !replaced.contains(&rel.to_lowercase())
        }
        _ => true,
    });

    // A removed folder speaks for everything that was removed inside it.
    let removed_dirs: Vec<String> = changes
        .iter()
        .filter_map(|c| match c {
            Change::Removed { rel, dir: true } => Some(format!("{}\\", rel.to_lowercase())),
            _ => None,
        })
        .collect();
    changes
        .into_iter()
        .filter(|c| match c {
            Change::Removed { rel, .. } => {
                let lower = rel.to_lowercase();
                !removed_dirs.iter().any(|d| lower.starts_with(d.as_str()))
            }
            _ => true,
        })
        .collect()
}

/// Splits a batch that was cut short while events were still coming. What left the
/// folder with nothing yet seen arriving may be half of a move whose other half is
/// still on its way, or a file of a folder being emptied one by one before the
/// folder's own removal comes to speak for it. Those events are handed on to the next
/// batch; everything else is acted on now. Returns (now, later), each in order.
pub fn hold_departures(events: Vec<RawEvent>) -> (Vec<RawEvent>, Vec<RawEvent>) {
    use std::collections::HashSet;
    let mut arrived: HashSet<i64> = HashSet::new();
    let mut left: HashSet<i64> = HashSet::new();
    for e in &events {
        match e.kind {
            RawKind::Removed | RawKind::RenamedOld => {
                if !arrived.remove(&e.file_id) {
                    left.insert(e.file_id);
                }
            }
            RawKind::Added | RawKind::RenamedNew => {
                arrived.insert(e.file_id);
            }
            RawKind::Modified => {}
        }
    }
    let open: HashSet<i64> = left.difference(&arrived).copied().collect();
    events
        .into_iter()
        .partition(|e| !(open.contains(&e.file_id) && matches!(e.kind, RawKind::Removed | RawKind::RenamedOld)))
}

/// What the library is asked to do, by uid. `album` is an album's uid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// To Proton's trash, where it can be restored for 30 days.
    Trash { photo: String },
    /// Out of an album, still in the library.
    FromAlbum { album: String, photo: String },
    /// Into an album, out of the one it was moved from, if any.
    IntoAlbum { album: String, photo: String, leaving: Option<String> },
    Favorite { photo: String },
    Unfavorite { photo: String },
    /// Out of the trash, back on the timeline.
    Restore { photo: String },
    RenamePhoto { photo: String, name: String },
    RenameAlbum { album: String, name: String },
    /// The album goes; its photos stay in the library.
    DeleteAlbum { album: String },
    /// A file that arrived: uploaded into the album named, or onto the timeline. A
    /// favourite when it arrived in `Photos\Favorites\`. `new_album` names the album to
    /// make first, for a folder made in `Albums\` that is not one yet.
    Upload { rel: String, album: Option<String>, new_album: Option<String>, favorite: bool },
    /// A folder made in `Albums\`: an album to be, made with its first photo.
    NewFolder { rel: String },
    /// Something the library cannot take: put back as it was at the next refresh.
    PutBack { rel: String },
    /// Nothing for the library to do.
    Nothing,
}

/// What the library knows that the folder does not: the uid behind a path, and the
/// album behind an album's folder.
pub trait Library {
    fn photo_at(&self, rel: &str) -> Option<String>;
    fn album_named(&self, folder: &str) -> Option<String>;
}

/// The album a place adds its photos to: an existing album's folder, or none.
fn album_of(place: &Place, lib: &dyn Library) -> Option<String> {
    match place {
        Place::Album(folder) => lib.album_named(folder),
        _ => None,
    }
}

pub fn action_for(change: &Change, lib: &dyn Library) -> Action {
    match change {
        Change::Removed { rel, dir: true } => match place_of_dir(&rel.split('\\').collect::<Vec<_>>()) {
            Place::Album(folder) => match lib.album_named(&folder) {
                Some(album) => Action::DeleteAlbum { album },
                None => Action::Nothing,
            },
            // The folders the app keeps (Photos, Albums, Shared, Trash) come back.
            Place::Photos | Place::Favorites | Place::Albums | Place::Shared | Place::Trash => {
                Action::PutBack { rel: rel.clone() }
            }
            _ => Action::Nothing,
        },
        Change::Removed { rel, dir: false } => {
            let Some(photo) = lib.photo_at(rel) else { return Action::Nothing };
            match place_of_parent(rel) {
                place if read_only(&place) => Action::PutBack { rel: rel.clone() },
                Place::Photos => Action::Trash { photo },
                Place::Favorites => Action::Unfavorite { photo },
                Place::Album(folder) => match lib.album_named(&folder) {
                    Some(album) => Action::FromAlbum { album, photo },
                    None => Action::Nothing,
                },
                _ => Action::Nothing,
            }
        }
        // Only `Albums\` makes albums: a folder at the top stays the user's own, or its
        // photos would show twice, there and in the album made from it.
        Change::Added { rel, dir: true, .. } => match place_of_parent(rel) {
            Place::Albums => Action::NewFolder { rel: rel.clone() },
            _ => Action::Nothing,
        },
        Change::Added { rel, dir: false, .. } => match place_of_parent(rel) {
            Place::Photos => Action::Upload { rel: rel.clone(), album: None, new_album: None, favorite: false },
            Place::Favorites => Action::Upload { rel: rel.clone(), album: None, new_album: None, favorite: true },
            Place::Album(folder) => match lib.album_named(&folder) {
                Some(album) => Action::Upload { rel: rel.clone(), album: Some(album), new_album: None, favorite: false },
                None => Action::Upload { rel: rel.clone(), album: None, new_album: Some(folder), favorite: false },
            },
            _ => Action::Nothing,
        },
        Change::Moved { from, to, dir: true } => {
            let (from_place, to_place) = (place_of_dir(&from.split('\\').collect::<Vec<_>>()), place_of_dir(&to.split('\\').collect::<Vec<_>>()));
            match (from_place, to_place) {
                (Place::Album(old), Place::Album(new)) => match lib.album_named(&old) {
                    Some(album) => Action::RenameAlbum { album, name: new },
                    // A folder made here, not an album yet: only its name changed.
                    None => Action::Nothing,
                },
                _ => Action::Nothing,
            }
        }
        Change::Moved { from, to, dir: false } => {
            let Some(photo) = lib.photo_at(from) else { return Action::Nothing };
            let (from_place, to_place) = (place_of_parent(from), place_of_parent(to));
            if parent_of(from).eq_ignore_ascii_case(parent_of(to)) {
                if read_only(&from_place) {
                    return Action::PutBack { rel: to.clone() };
                }
                return Action::RenamePhoto { photo, name: name_of(to).to_string() };
            }
            match (&from_place, &to_place) {
                (Place::Trash, to) if on_timeline(to) || matches!(to, Place::Album(_) | Place::Favorites) => {
                    Action::Restore { photo }
                }
                (from, _) if read_only(from) => Action::PutBack { rel: to.clone() },
                (_, Place::Trash) => Action::Trash { photo },
                (_, Place::Favorites) => Action::Favorite { photo },
                (_, dest) if read_only(dest) => Action::PutBack { rel: to.clone() },
                (Place::Favorites, to) if on_timeline(to) => Action::Unfavorite { photo },
                (_, Place::Album(_)) => match album_of(&to_place, lib) {
                    Some(album) => {
                        let leaving = album_of(&from_place, lib).filter(|a| *a != album);
                        Action::IntoAlbum { album, photo, leaving }
                    }
                    None => Action::Nothing,
                },
                (Place::Album(_), to) if on_timeline(to) => match album_of(&from_place, lib) {
                    Some(album) => Action::FromAlbum { album, photo },
                    None => Action::Nothing,
                },
                _ => Action::Nothing,
            }
        }
    }
}

/// Whether a move or a rename inside the folder takes something from the library, which
/// the "deleting and renaming" switch holds back. `to` is None for the Recycle Bin.
/// Restoring from the trash, favouriting and adding to an album take nothing.
pub fn takes_away(from: &str, to: Option<&str>, dir: bool) -> bool {
    let Some(to) = to else { return true };
    if dir {
        let from_parts: Vec<&str> = from.split('\\').filter(|p| !p.is_empty()).collect();
        return matches!(place_of_dir(&from_parts), Place::Album(_));
    }
    let (from_place, to_place) = (place_of_parent(from), place_of_parent(to));
    if parent_of(from).eq_ignore_ascii_case(parent_of(to)) {
        return true;
    }
    match (&from_place, &to_place) {
        (Place::Trash, _) => false,
        (_, Place::Trash) => true,
        (_, Place::Favorites) => false,
        (Place::Album(a), Place::Album(b)) => !a.eq_ignore_ascii_case(b),
        (_, Place::Album(_)) => false,
        (Place::Favorites | Place::Album(_), _) => true,
        _ => false,
    }
}

/// What is left of an action with the switch off: whatever would take something from
/// the library is dropped, and the next fill puts the folder back as the library has it.
pub fn without_edits(action: Action) -> Action {
    match action {
        Action::Trash { .. }
        | Action::FromAlbum { .. }
        | Action::Unfavorite { .. }
        | Action::RenamePhoto { .. }
        | Action::RenameAlbum { .. }
        | Action::DeleteAlbum { .. } => Action::Nothing,
        Action::IntoAlbum { album, photo, .. } => Action::IntoAlbum { album, photo, leaving: None },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Lib {
        photos: HashMap<String, String>,
        albums: HashMap<String, String>,
    }

    impl Library for Lib {
        fn photo_at(&self, rel: &str) -> Option<String> {
            self.photos.get(&rel.to_lowercase()).cloned()
        }
        fn album_named(&self, folder: &str) -> Option<String> {
            self.albums.get(&folder.to_lowercase()).cloned()
        }
    }

    fn lib() -> Lib {
        let photos = [
            ("photos\\a.jpg", "p-a"),
            ("photos\\favorites\\a.jpg", "p-a"),
            ("albums\\trip\\a.jpg", "p-a"),
            ("albums\\trip\\b.jpg", "p-b"),
            ("albums\\party\\b.jpg", "p-b"),
            ("trash\\old.jpg", "p-old"),
            ("shared\\theirs.jpg", "p-theirs"),
        ];
        Lib {
            photos: photos.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            albums: [("trip", "al-trip"), ("party", "al-party")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn ev(kind: RawKind, rel: &str, id: i64, dir: bool, placeholder: bool) -> RawEvent {
        RawEvent { kind, rel: rel.into(), file_id: id, dir, placeholder }
    }

    #[test]
    fn places_by_folder() {
        assert_eq!(place_of_parent("Photos\\a.jpg"), Place::Photos);
        assert_eq!(place_of_parent("photos\\Favorites\\a.jpg"), Place::Favorites);
        assert_eq!(place_of_parent("Albums\\Trip\\a.jpg"), Place::Album("Trip".into()));
        assert_eq!(place_of_parent("Albums\\Trip"), Place::Albums);
        assert_eq!(place_of_parent("Shared\\Their album\\x.jpg"), Place::Shared);
        assert_eq!(place_of_parent("Trash\\x.jpg"), Place::Trash);
        assert_eq!(place_of_parent("Albums\\Trip\\deeper\\x.jpg"), Place::Other);
        assert_eq!(place_of_parent("loose.jpg"), Place::Root);
    }

    #[test]
    fn a_move_cut_in_two_by_a_long_batch_is_still_a_move() {
        // The batch closes between the two halves of the rename.
        let (now, later) = hold_departures(vec![
            ev(RawKind::RenamedOld, "Photos\\a.jpg", 7, false, true),
            ev(RawKind::Added, "Photos\\new.jpg", 9, false, false),
        ]);
        assert_eq!(now.len(), 1, "the unrelated arrival is acted on now");
        assert_eq!(later.len(), 1, "the half of a move is held");
        assert!(read_batch(&now).iter().all(|c| !matches!(c, Change::Removed { .. })), "nothing is deleted now");
        let mut next = later;
        next.push(ev(RawKind::RenamedNew, "Albums\\Trip\\a.jpg", 7, false, true));
        assert_eq!(
            read_batch(&next),
            vec![Change::Moved { from: "Photos\\a.jpg".into(), to: "Albums\\Trip\\a.jpg".into(), dir: false }]
        );
    }

    #[test]
    fn a_folder_emptied_over_several_batches_is_one_folder_removal() {
        let (now, later) = hold_departures(vec![
            ev(RawKind::Removed, "Photos\\a.jpg", 1, false, true),
            ev(RawKind::Removed, "Photos\\b.jpg", 2, false, true),
        ]);
        assert!(now.is_empty(), "no photo is trashed while the folder is still emptying");
        let mut next = later;
        next.push(ev(RawKind::Removed, "Photos", 3, true, true));
        assert_eq!(read_batch(&next), vec![Change::Removed { rel: "Photos".into(), dir: true }]);
    }

    #[test]
    fn a_photo_saved_over_in_place_is_neither_deleted_nor_uploaded_again() {
        let changes = read_batch(&[
            ev(RawKind::Removed, "Photos\\a.jpg", 7, false, false),
            ev(RawKind::RenamedNew, "Photos\\a.jpg", 8, false, false),
        ]);
        assert!(changes.is_empty(), "{changes:?}");
    }

    #[test]
    fn a_file_that_left_and_arrived_under_one_id_moved() {
        let changes = read_batch(&[
            ev(RawKind::Removed, "Photos\\a.jpg", 7, false, true),
            ev(RawKind::Added, "Albums\\Trip\\a.jpg", 7, false, true),
        ]);
        assert_eq!(
            changes,
            vec![Change::Moved { from: "Photos\\a.jpg".into(), to: "Albums\\Trip\\a.jpg".into(), dir: false }]
        );
    }

    #[test]
    fn a_rename_pair_is_a_move_within_the_folder() {
        let changes = read_batch(&[
            ev(RawKind::RenamedOld, "Albums\\Trip", 3, true, true),
            ev(RawKind::RenamedNew, "Albums\\Road trip", 3, true, true),
        ]);
        assert_eq!(
            changes,
            vec![Change::Moved { from: "Albums\\Trip".into(), to: "Albums\\Road trip".into(), dir: true }]
        );
    }

    #[test]
    fn deleting_an_album_folder_is_one_change_not_one_per_photo() {
        let changes = read_batch(&[
            ev(RawKind::Removed, "Albums\\Trip\\a.jpg", 1, false, true),
            ev(RawKind::Removed, "Albums\\Trip\\b.jpg", 2, false, true),
            ev(RawKind::Removed, "Albums\\Trip", 3, true, true),
        ]);
        assert_eq!(changes, vec![Change::Removed { rel: "Albums\\Trip".into(), dir: true }]);
        assert_eq!(action_for(&changes[0], &lib()), Action::DeleteAlbum { album: "al-trip".into() });
    }

    #[test]
    fn the_apps_own_placeholders_arriving_are_left_out() {
        let changes = read_batch(&[
            ev(RawKind::Added, "Photos\\new-from-cloud.jpg", 9, false, true),
            ev(RawKind::Added, "Photos\\dropped.jpg", 10, false, false),
            ev(RawKind::Modified, "Photos\\dropped.jpg", 10, false, false),
        ]);
        assert_eq!(
            changes,
            vec![Change::Added { rel: "Photos\\dropped.jpg".into(), dir: false, placeholder: false }]
        );
    }

    #[test]
    fn something_that_arrived_and_left_again_in_one_batch_is_nothing() {
        let changes = read_batch(&[
            ev(RawKind::Added, "Photos\\~tmp.jpg", 11, false, false),
            ev(RawKind::Removed, "Photos\\~tmp.jpg", 11, false, false),
        ]);
        assert_eq!(changes, vec![]);
    }

    #[test]
    fn deleting_follows_where_the_photo_was() {
        let l = lib();
        let removed = |rel: &str| action_for(&Change::Removed { rel: rel.into(), dir: false }, &l);
        assert_eq!(removed("Photos\\a.jpg"), Action::Trash { photo: "p-a".into() });
        assert_eq!(removed("Photos\\Favorites\\a.jpg"), Action::Unfavorite { photo: "p-a".into() });
        assert_eq!(
            removed("Albums\\Trip\\b.jpg"),
            Action::FromAlbum { album: "al-trip".into(), photo: "p-b".into() }
        );
        assert_eq!(removed("Trash\\old.jpg"), Action::PutBack { rel: "Trash\\old.jpg".into() });
        assert_eq!(removed("Shared\\theirs.jpg"), Action::PutBack { rel: "Shared\\theirs.jpg".into() });
        assert_eq!(removed("Photos\\unknown.jpg"), Action::Nothing);
    }

    #[test]
    fn moving_follows_where_it_went() {
        let l = lib();
        let moved = |from: &str, to: &str| {
            action_for(&Change::Moved { from: from.into(), to: to.into(), dir: false }, &l)
        };
        assert_eq!(
            moved("Photos\\a.jpg", "Albums\\Party\\a.jpg"),
            Action::IntoAlbum { album: "al-party".into(), photo: "p-a".into(), leaving: None }
        );
        assert_eq!(
            moved("Albums\\Trip\\b.jpg", "Albums\\Party\\b.jpg"),
            Action::IntoAlbum { album: "al-party".into(), photo: "p-b".into(), leaving: Some("al-trip".into()) }
        );
        assert_eq!(
            moved("Albums\\Trip\\b.jpg", "Photos\\b.jpg"),
            Action::FromAlbum { album: "al-trip".into(), photo: "p-b".into() }
        );
        assert_eq!(moved("Photos\\a.jpg", "Photos\\Favorites\\a.jpg"), Action::Favorite { photo: "p-a".into() });
        assert_eq!(moved("Photos\\Favorites\\a.jpg", "Photos\\a.jpg"), Action::Unfavorite { photo: "p-a".into() });
        assert_eq!(moved("Photos\\a.jpg", "Trash\\a.jpg"), Action::Trash { photo: "p-a".into() });
        assert_eq!(moved("Trash\\old.jpg", "Photos\\old.jpg"), Action::Restore { photo: "p-old".into() });
        assert_eq!(
            moved("Shared\\theirs.jpg", "Photos\\theirs.jpg"),
            Action::PutBack { rel: "Photos\\theirs.jpg".into() }
        );
        assert_eq!(
            moved("Photos\\a.jpg", "Photos\\Sunset.jpg"),
            Action::RenamePhoto { photo: "p-a".into(), name: "Sunset.jpg".into() }
        );
        assert_eq!(moved("Trash\\old.jpg", "Trash\\new.jpg"), Action::PutBack { rel: "Trash\\new.jpg".into() });
    }

    #[test]
    fn folders_rename_albums_and_new_ones_become_albums() {
        let l = lib();
        assert_eq!(
            action_for(&Change::Moved { from: "Albums\\Trip".into(), to: "Albums\\Road trip".into(), dir: true }, &l),
            Action::RenameAlbum { album: "al-trip".into(), name: "Road trip".into() }
        );
        assert_eq!(
            action_for(&Change::Added { rel: "Albums\\Summer".into(), dir: true, placeholder: false }, &l),
            Action::NewFolder { rel: "Albums\\Summer".into() }
        );
        assert_eq!(
            action_for(&Change::Added { rel: "Summer".into(), dir: true, placeholder: false }, &l),
            Action::Nothing
        );
        assert_eq!(
            action_for(&Change::Removed { rel: "Photos".into(), dir: true }, &l),
            Action::PutBack { rel: "Photos".into() }
        );
    }

    #[test]
    fn a_file_that_arrived_is_uploaded_where_it_landed() {
        let l = lib();
        let added = |rel: &str| action_for(&Change::Added { rel: rel.into(), dir: false, placeholder: false }, &l);
        assert_eq!(
            added("Photos\\new.jpg"),
            Action::Upload { rel: "Photos\\new.jpg".into(), album: None, new_album: None, favorite: false }
        );
        assert_eq!(
            added("Photos\\Favorites\\new.jpg"),
            Action::Upload { rel: "Photos\\Favorites\\new.jpg".into(), album: None, new_album: None, favorite: true }
        );
        assert_eq!(
            added("Albums\\Trip\\new.jpg"),
            Action::Upload {
                rel: "Albums\\Trip\\new.jpg".into(),
                album: Some("al-trip".into()),
                new_album: None,
                favorite: false
            }
        );
        assert_eq!(
            added("Albums\\Summer\\new.jpg"),
            Action::Upload {
                rel: "Albums\\Summer\\new.jpg".into(),
                album: None,
                new_album: Some("Summer".into()),
                favorite: false
            }
        );
        assert_eq!(added("loose.jpg"), Action::Nothing);
        assert_eq!(added("Shared\\new.jpg"), Action::Nothing);
        assert_eq!(added("Trash\\new.jpg"), Action::Nothing);
    }

    #[test]
    fn with_edits_off_only_what_adds_goes_through() {
        let file = |from: &str, to: Option<&str>| takes_away(from, to, false);
        assert!(file("Photos\\a.jpg", None));
        assert!(file("Photos\\a.jpg", Some("Photos\\b.jpg")));
        assert!(file("Photos\\a.jpg", Some("Trash\\a.jpg")));
        assert!(file("Photos\\Favorites\\a.jpg", Some("Photos\\a.jpg")));
        assert!(file("Albums\\Trip\\a.jpg", Some("Photos\\a.jpg")));
        assert!(file("Albums\\Trip\\a.jpg", Some("Albums\\Home\\a.jpg")));
        assert!(!file("Trash\\a.jpg", Some("Photos\\a.jpg")));
        assert!(!file("Photos\\a.jpg", Some("Photos\\Favorites\\a.jpg")));
        assert!(!file("Photos\\a.jpg", Some("Albums\\Trip\\a.jpg")));
        assert!(!file("Photos\\Favorites\\a.jpg", Some("Albums\\Trip\\a.jpg")));
        assert!(takes_away("Albums\\Trip", Some("Albums\\Road trip"), true));
        assert!(takes_away("Albums\\Trip", None, true));
        assert!(!takes_away("Albums\\New folder\\Sub", Some("Albums\\New folder\\Other"), true));

        let photo = || "p".to_string();
        assert_eq!(without_edits(Action::Trash { photo: photo() }), Action::Nothing);
        assert_eq!(without_edits(Action::RenamePhoto { photo: photo(), name: "b.jpg".into() }), Action::Nothing);
        assert_eq!(without_edits(Action::Favorite { photo: photo() }), Action::Favorite { photo: photo() });
        assert_eq!(
            without_edits(Action::IntoAlbum { album: "a".into(), photo: photo(), leaving: Some("b".into()) }),
            Action::IntoAlbum { album: "a".into(), photo: photo(), leaving: None }
        );
    }
}
