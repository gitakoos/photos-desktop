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

// Encrypted, app-owned storage for non-secret preferences.
//
// Every byte lives inside the app's own directory. A random AES-256-GCM data key is
// generated on first use and sealed at rest by the platform keystore: user-scope DPAPI
// on Windows (so only the same Windows user on the same machine can unseal it, and
// nothing is registered anywhere the system can enumerate), and the Secret Service on
// Linux (gnome-keyring / kwallet), which encrypts it against the login session.
//
// This key backs what must be readable before login: the `settings` blob (theme,
// language, toggles) and the mount's own uid lists. The session and thumbnail cache
// are owned by the sidecar and encrypted with a stronger, password-derived vault key
// instead.

use std::fs;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, Generate, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use windows_dpapi::{decrypt_data, encrypt_data, Scope};

/// Bound into the DPAPI seal, which ties the blob to this purpose: a blob sealed with
/// other entropy, or with none, does not unseal as this key, and this one does not
/// unseal without it. It is not a secret (the value is right here), so it does not stop
/// a process running as the same user from unsealing the key; DPAPI's user scope is
/// what keeps other users and other machines out.
const DPAPI_ENTROPY: &[u8] = b"eu.akoos.photos.desktop/store/v1";
const KEY_FILE: &str = "key.bin";
const NONCE_LEN: usize = 12;

/// Separate entropy and a separate file for the vault-metadata key, so it is not
/// interchangeable with the store key above. That key opens the settings blob and
/// the mount's uid lists; this one is handed to the sidecar, and a single key doing
/// both jobs would widen what a leak on either side costs.
const VAULT_KEY_ENTROPY: &[u8] = b"eu.akoos.photos.desktop/vaultmeta/v1";
const VAULT_KEY_FILE: &str = "vaultmeta.bin";

/// The installer lays the app out as the app's exe + `<install>\resources\`
/// (the runtime) + a runtime `<install>\data\`. When that layout is present
/// (the runtime sits under `resources\` next to us), keep ALL data in
/// `<install>\data` so everything lives in ONE install folder and the uninstaller
/// wipes it together. Returns None in dev / any other layout, where the OS
/// app-data dir is used instead.
///
/// That layout is the Windows installer's alone. A Linux install is read-only (a
/// Flatpak's `/app`), and there `resources/sidecar` is the directory holding
/// server.mjs, which would pass the check and send every write to a folder that
/// cannot take one: no log, no store, and a sidecar that never starts.
pub fn install_data_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    dir.join("resources")
        .join("sidecar.exe")
        .exists()
        .then(|| dir.join("data"))
}

pub fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match install_data_dir() {
        Some(d) => d,
        None => app.path().app_local_data_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A fresh 32-byte key from the OS CSPRNG.
fn rand_key() -> [u8; 32] {
    let key = Key::<Aes256Gcm>::generate();
    let mut out = [0u8; 32];
    out.copy_from_slice(key.as_slice());
    out
}

/// Load a 32-byte at-rest key by logical id, creating and sealing it on first use.
///
/// On Windows it is sealed to `<data>/<file>` with user-scope DPAPI, bound to
/// `entropy`, so only the same user on the same machine can unseal it and a stolen
/// file cannot. `file` and `entropy` identify the key, so the store key and the
/// vault-meta key stay distinct.
#[cfg(windows)]
fn keystore_get_or_create(
    app: &AppHandle,
    file: &str,
    entropy: &[u8],
) -> Result<[u8; 32], String> {
    let path = app_dir(app)?.join(file);
    if path.exists() {
        let sealed = fs::read(&path).map_err(|e| e.to_string())?;
        let raw = decrypt_data(&sealed, Scope::User, Some(entropy))
            .map_err(|e| format!("could not unseal a key: {e}"))?;
        return raw.try_into().map_err(|_| "stored key is corrupt".to_string());
    }
    let key = rand_key();
    let sealed = encrypt_data(&key, Scope::User, Some(entropy))
        .map_err(|e| format!("could not seal a key: {e}"))?;
    write_atomic(&path, &sealed)?;
    Ok(key)
}

/// The non-Windows path stores the key in the OS keyring, which on a Linux desktop is
/// the Secret Service (gnome-keyring / kwallet) and on macOS the login Keychain. It
/// encrypts the key at rest, so the key never sits on disk in the clear, the same
/// guarantee DPAPI gives above. The `file`
/// id names the keyring entry so the two keys stay distinct; `entropy` is unused here,
/// because the keyring, not this app, binds the secret to the login session.
///
/// The key goes in as hex text. The Secret Service is handed every secret as text, and
/// KWallet keeps it as text, so 32 raw bytes came back from it altered and the key was
/// lost. Raw keys an earlier build stored in gnome-keyring, which keeps bytes as given,
/// still open as they are.
#[cfg(not(windows))]
fn keystore_get_or_create(
    _app: &AppHandle,
    file: &str,
    _entropy: &[u8],
) -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new("eu.akoos.photos.desktop", file)
        .map_err(|e| format!("keyring entry: {e}"))?;
    match entry.get_secret() {
        Ok(raw) => match decode_stored_key(&raw) {
            Some(key) => Ok(key),
            // The keyring altered the key it was given, so it cannot be had back. What was
            // sealed under it reads as absent from here on: the settings start over and the
            // vault starts clean, as after a sign-out.
            None => {
                eprintln!("[secure_store] the keyring entry {file} came back altered; a new key replaces it");
                store_new_key(&entry)
            }
        },
        Err(keyring::Error::NoEntry) => store_new_key(&entry),
        Err(e) => Err(format!("could not read a key from the keyring: {e}")),
    }
}

#[cfg(not(windows))]
fn store_new_key(entry: &keyring::Entry) -> Result<[u8; 32], String> {
    let key = rand_key();
    entry
        .set_password(&to_hex(&key))
        .map_err(|e| format!("could not store a key in the keyring: {e}"))?;
    Ok(key)
}

/// The key as the Linux keyring hands it back: the 64 hex characters this build stores,
/// or the 32 raw bytes an earlier one stored. None for anything else, which is what a
/// keyring that keeps secrets as text makes of 32 raw bytes.
#[cfg(any(test, not(windows)))]
fn decode_stored_key(raw: &[u8]) -> Option<[u8; 32]> {
    if let Ok(key) = <[u8; 32]>::try_from(raw) {
        return Some(key);
    }
    if raw.len() != 64 || !raw.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let mut key = [0u8; 32];
    for (byte, pair) in key.iter_mut().zip(raw.chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(key)
}

/// Lower-case hex, the text form a key takes in the keyring and on its way to the sidecar.
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A key from the platform keystore, kept in `slot` once it has loaded.
///
/// Unsealing is a DPAPI call, a Secret Service round trip or a Keychain read that a Mac may
/// put to its owner as a prompt, so it happens once per run rather than at every caller. A
/// failed read is not kept, so the next caller tries again. The lock also keeps two first
/// callers from each creating a different key.
fn cached_key(
    slot: &std::sync::Mutex<Option<[u8; 32]>>,
    app: &AppHandle,
    file: &str,
    entropy: &[u8],
) -> Result<[u8; 32], String> {
    let mut cached = slot.lock().unwrap_or_else(|e| e.into_inner());
    match *cached {
        Some(raw) => Ok(raw),
        None => Ok(*cached.insert(keystore_get_or_create(app, file, entropy)?)),
    }
}

/// The AES data key, created on first use and sealed at rest by the platform keystore.
fn data_key(app: &AppHandle) -> Result<Key<Aes256Gcm>, String> {
    static KEY: std::sync::Mutex<Option<[u8; 32]>> = std::sync::Mutex::new(None);
    let raw = cached_key(&KEY, app, KEY_FILE, DPAPI_ENTROPY)?;
    Key::<Aes256Gcm>::try_from(raw.as_slice()).map_err(|_| "bad key length".to_string())
}

fn seal(key: &Key<Aes256Gcm>, plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::generate();
    let mut out = nonce.to_vec();
    out.extend_from_slice(
        &cipher
            .encrypt(&nonce, plain)
            .map_err(|_| "encryption failed".to_string())?,
    );
    Ok(out)
}

fn unseal(key: &Key<Aes256Gcm>, blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() <= NONCE_LEN {
        return Err("stored blob is truncated".into());
    }
    let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
    Aes256Gcm::new(key)
        .decrypt(&Nonce::try_from(nonce).map_err(|_| "bad nonce length".to_string())?, ciphertext)
        .map_err(|_| "decryption failed".to_string())
}

/// Names come from the WebView, so they must never be able to escape app_dir.
fn safe_name(name: &str) -> Result<String, String> {
    // The one entry the interface keeps here. The same directory holds the sealed keys
    // (`key.bin`, `vaultmeta.bin`) under names of exactly this shape, and overwriting or
    // deleting either would lock the vault away for good, so the renderer may name
    // nothing else.
    if !RENDERER_ENTRIES.contains(&name) {
        return Err("invalid store name".into());
    }
    Ok(format!("{name}.bin"))
}

/// The settings that act on an account's own photos or Drive: scanning its faces, indexing it
/// for search, saving to its Drive, reading its My files. They are the account's choices, so
/// the next account to sign in starts with them off and turns on what it wants itself.
const ACCOUNT_SWITCHES: &[&str] = &["localFaces", "localSearch", "semanticSearch", "sharedBackup", "myFilesAccess"];

/// Turns the account's own switches off in the window's settings. True when one was on.
fn account_switches_off(settings: &mut serde_json::Value) -> bool {
    let Some(map) = settings.as_object_mut() else { return false };
    let mut changed = false;
    for key in ACCOUNT_SWITCHES {
        if map.get(*key).and_then(serde_json::Value::as_bool) == Some(true) {
            map.insert((*key).to_string(), serde_json::Value::Bool(false));
            changed = true;
        }
    }
    changed
}

/// On sign-out, and when another account takes a lapsed one's place.
pub(crate) fn turn_off_account_switches(app: &AppHandle) {
    let Ok(Some(raw)) = read_sealed(app, "settings.bin") else { return };
    let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    if account_switches_off(&mut settings) {
        let _ = write_sealed(app, "settings.bin", &settings.to_string());
    }
}

#[cfg(test)]
mod account_switch_tests {
    use super::account_switches_off;
    use serde_json::json;

    #[test]
    fn only_the_accounts_own_switches_go_off() {
        let mut s = json!({ "localFaces": true, "sharedBackup": true, "localSearch": false, "theme": "dark", "compressPhotos": true });
        assert!(account_switches_off(&mut s));
        assert_eq!(s, json!({ "localFaces": false, "sharedBackup": false, "localSearch": false, "theme": "dark", "compressPhotos": true }));
        assert!(!account_switches_off(&mut s), "nothing left on, nothing written");
    }
}

/// What the WebView may read, write and delete through the `store_*` commands.
const RENDERER_ENTRIES: &[&str] = &["settings"];

/// Seal one text file into the app directory. Named directly, so callers inside the
/// app (the mount's uid lists) can share this key without going through the
/// WebView-facing name check, which exists to constrain what the renderer may name.
///
/// Written aside, flushed and renamed over the old file, so a reader never meets a half-written
/// one and takes it for a file its key does not open.
pub(crate) fn write_sealed(app: &AppHandle, file: &str, value: &str) -> Result<(), String> {
    let path = app_dir(app)?.join(file);
    let blob = seal(&data_key(app)?, value.as_bytes())?;
    write_atomic(&path, &blob)
}

fn write_atomic(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    let written = (|| {
        let mut f = fs::File::create(&part)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&part, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&part);
    }
    written.map_err(|e| e.to_string())
}

/// Read one sealed text file back. A blob that cannot be opened (tampered, or
/// written under a different key) is reported as absent rather than as an error, so
/// every caller falls back to its own empty state instead of failing: the app falls
/// back to sign-in, and the mount to "nothing recorded yet". A key that cannot be had
/// (the keyring did not answer) is an error, and nothing is touched.
pub(crate) fn read_sealed(app: &AppHandle, file: &str) -> Result<Option<String>, String> {
    let path = app_dir(app)?.join(file);
    if !path.exists() {
        return Ok(None);
    }
    let key = data_key(app)?;
    open_or_set_aside(&path, &key)
}

/// Opens a sealed file with `key`. One that will not open is moved aside under a name that says
/// so and kept, never deleted, so the next write does not land on it: the key it was sealed
/// under (a keyring entry that comes back) may still open it.
fn open_or_set_aside(path: &std::path::Path, key: &Key<Aes256Gcm>) -> Result<Option<String>, String> {
    let blob = fs::read(path).map_err(|e| e.to_string())?;
    match unseal(key, &blob) {
        Ok(plain) => Ok(Some(String::from_utf8_lossy(&plain).into_owned())),
        Err(_) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let mut aside = path.as_os_str().to_owned();
            aside.push(format!(".unreadable-{stamp}"));
            if fs::rename(path, &aside).is_ok() {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                eprintln!("[secure_store] set aside a sealed file that would not open: {name}");
            }
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn store_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    write_sealed(&app, &safe_name(&name)?, &value)
}

/// Read on a worker thread: the first read of a start asks the system keyring for the key (on
/// Linux and macOS a round trip to another process, which can wait on a prompt), and a command
/// that is not async runs on the main thread, where it would hold up the window. The writes stay
/// on the main thread, so they keep the order the window sent them in and a read sent after a
/// write always sees it.
#[tauri::command]
pub async fn store_get(app: AppHandle, name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_sealed(&app, &safe_name(&name)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn store_del(app: AppHandle, name: String) -> Result<(), String> {
    let path = app_dir(&app)?.join(safe_name(&name)?);
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A random key, sealed at rest with DPAPI, that exists purely so the vault's own
/// metadata does not sit on disk in the clear.
///
/// The vault derives the sidecar's data key from the user's Proton password and a
/// random salt. Left readable, that salt is enough to mount an offline attack on the
/// password itself: guess, derive, compare, with no server to rate-limit it. And the
/// password is the Proton ACCOUNT password, so what is at stake is not the photo
/// cache but Mail, Calendar and account recovery.
///
/// Sealing the salt removes the attack from anyone holding only the files (a stolen
/// laptop, a backup image, a resold drive), because DPAPI will not unseal this key
/// for them. It does not defend against code already running as this Windows user;
/// only breaking the password-to-key binding would, and that would cost the vault's
/// ability to verify a password locally at all.
///
/// Every sidecar start hands it over, and a replaced sidecar starts again, so it is kept in
/// memory once loaded as the store key is.
fn vault_meta_key(app: &AppHandle) -> Result<String, String> {
    static KEY: std::sync::Mutex<Option<[u8; 32]>> = std::sync::Mutex::new(None);
    let raw = cached_key(&KEY, app, VAULT_KEY_FILE, VAULT_KEY_ENTROPY)?;
    // Hex rather than base64: the JSON hop needs some text form, and hex costs no
    // dependency and cannot be confused with the base64 uids elsewhere in the logs.
    Ok(to_hex(&raw))
}

/// Handed to the sidecar over stdin at spawn: the app directory, and the key that
/// seals the vault's metadata. The sidecar still derives its own AES data key from
/// the user's password, so the caches and the session stay shut until unlock; this
/// key only keeps the salt and verifier that guard that derivation off the disk in
/// readable form.
pub fn sidecar_init_params(app: &AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "dataDir": app_dir(app)?.to_string_lossy(),
        "vaultKey": vault_meta_key(app)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::{rand_key, seal, unseal};
    use aes_gcm::aead::Generate;
    use aes_gcm::{Aes256Gcm, Key};

    #[test]
    fn seal_unseal_round_trips() {
        let key = Key::<Aes256Gcm>::generate();
        let plain = b"session tokens + key passphrases";
        let blob = seal(&key, plain).unwrap();
        assert_eq!(unseal(&key, &blob).unwrap(), plain);
    }

    #[test]
    fn tampered_blob_is_rejected() {
        let key = Key::<Aes256Gcm>::generate();
        let mut blob = seal(&key, b"secret").unwrap();
        let n = blob.len();
        blob[n - 1] ^= 0xff; // flip a tag byte
        assert!(unseal(&key, &blob).is_err());
    }

    #[test]
    fn wrong_key_fails_closed() {
        let a = Key::<Aes256Gcm>::generate();
        let b = Key::<Aes256Gcm>::generate();
        let blob = seal(&a, b"data").unwrap();
        assert!(unseal(&b, &blob).is_err());
    }

    #[test]
    fn a_file_that_will_not_open_is_set_aside_not_deleted() {
        let dir = std::env::temp_dir().join(format!("pfp-sealed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings");
        let old = rand_key();
        let new = rand_key();
        let old = Key::<Aes256Gcm>::try_from(old.as_slice()).unwrap();
        let new = Key::<Aes256Gcm>::try_from(new.as_slice()).unwrap();
        let blob = seal(&old, b"{\"theme\":\"dark\"}").unwrap();
        std::fs::write(&path, &blob).unwrap();
        assert_eq!(super::open_or_set_aside(&path, &old).unwrap().as_deref(), Some("{\"theme\":\"dark\"}"));
        assert!(path.exists());
        assert_eq!(super::open_or_set_aside(&path, &new).unwrap(), None);
        assert!(!path.exists());
        let aside: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(&aside[0]).unwrap(), blob);
        assert_eq!(super::open_or_set_aside(&aside[0], &old).unwrap().as_deref(), Some("{\"theme\":\"dark\"}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sealed_write_replaces_the_file_whole_and_leaves_nothing_aside() {
        let dir = std::env::temp_dir().join(format!("pfp-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.bin");
        super::write_atomic(&path, b"first").unwrap();
        super::write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_blob_is_rejected() {
        let key = Key::<Aes256Gcm>::generate();
        assert!(unseal(&key, &[0u8; 5]).is_err());
    }
}

#[cfg(test)]
mod stored_key_tests {
    use super::{decode_stored_key, rand_key, to_hex};

    #[test]
    fn a_key_stored_as_hex_reads_back() {
        let key = rand_key();
        assert_eq!(decode_stored_key(to_hex(&key).as_bytes()), Some(key));
        assert_eq!(decode_stored_key(to_hex(&key).to_uppercase().as_bytes()), Some(key));
    }

    #[test]
    fn a_raw_key_an_earlier_build_stored_still_opens() {
        let key = rand_key();
        assert_eq!(decode_stored_key(&key), Some(key));
    }

    #[test]
    fn a_key_the_keyring_kept_as_text_is_refused() {
        // 32 raw bytes read as text: every byte that is not valid UTF-8 turns into U+FFFD.
        let key: [u8; 32] = std::array::from_fn(|i| 0x80 + i as u8);
        let altered = String::from_utf8_lossy(&key).into_owned();
        assert_ne!(altered.len(), 32);
        assert_eq!(decode_stored_key(altered.as_bytes()), None);
    }

    #[test]
    fn anything_else_is_refused() {
        assert_eq!(decode_stored_key(b""), None);
        assert_eq!(decode_stored_key(&[7u8; 31]), None);
        assert_eq!(decode_stored_key(&[b'a'; 63]), None);
        assert_eq!(decode_stored_key(format!("+{}", "a".repeat(63)).as_bytes()), None);
        assert_eq!(decode_stored_key("z".repeat(64).as_bytes()), None);
    }
}
