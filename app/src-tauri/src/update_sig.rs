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

//! The updater's own check of the installer it is about to run.
//!
//! The release's sha256 digest only says the file arrived as GitHub holds it, so anyone
//! able to publish a release could publish an installer with a matching digest. What
//! this checks instead is a signature made with a key that never leaves the
//! maintainer's machine (`setup/sign-update.mjs`), in the minisign format, over the
//! file's BLAKE2b-512 hash. The version sits in the signed comment, so an older signed
//! installer cannot be replayed as an update either: it has to be newer than this app.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use minisign_verify::{PublicKey, Signature};
use semver::Version;

/// The public half of the update signing key.
const UPDATE_KEY: &str = "RWSwAiqujmDd0nLz1I4pZntgpQAwmiU7zLI37NrHQ76aG2aYH8ChtkL5";

/// A minisign signature is four short lines; anything much longer is not one.
const MAX_SIGNATURE_BYTES: u64 = 4096;

/// Checks `installer` against its signature file and returns the version it was signed
/// as, which must be newer than `current`. Any failure is a refusal.
pub fn verify_installer(installer: &Path, signature: &Path, current: &Version) -> Result<Version, String> {
    verify_with(UPDATE_KEY, installer, signature, current)
}

fn verify_with(key: &str, installer: &Path, signature: &Path, current: &Version) -> Result<Version, String> {
    let key = PublicKey::from_base64(key).map_err(|e| format!("update key: {e}"))?;
    let mut text = String::new();
    File::open(signature)
        .and_then(|f| f.take(MAX_SIGNATURE_BYTES).read_to_string(&mut text))
        .map_err(|_| "the installer has no signature".to_string())?;
    let sig = Signature::decode(&text).map_err(|_| "the installer's signature is unreadable".to_string())?;
    let mut verifier = key
        .verify_stream(&sig)
        .map_err(|_| "the installer is not signed with the update key".to_string())?;
    let mut file = File::open(installer).map_err(|e| format!("installer: {e}"))?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("installer: {e}"))?;
        if n == 0 {
            break;
        }
        verifier.update(&buf[..n]);
    }
    verifier
        .finalize()
        .map_err(|_| "the installer's signature does not match it".to_string())?;
    // Read only now: the comment is covered by the signature that just checked out.
    let field = |name: &str| {
        sig.trusted_comment()
            .split('\t')
            .find_map(|f| f.strip_prefix(name))
            .map(str::to_string)
    };
    let version = field("version:")
        .and_then(|v| Version::parse(&v).ok())
        .ok_or_else(|| "the signature names no version".to_string())?;
    if version <= *current {
        return Err(format!("the installer is version {version}, not newer than {current}"));
    }
    // An update installer carries only what changed since one version, so over any
    // other it would leave out files that version needs.
    if let Some(from) = field("from:") {
        if Version::parse(&from).ok().as_ref() != Some(current) {
            return Err(format!("the installer updates only {from}, this is {current}"));
        }
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway key, made with `sign-update.mjs generate`, and a file it signed as 1.2.0.
    const TEST_KEY: &str = "RWQeJbkgahsNY6Afuv/WyPCr7crNcLKfnGqq1X5WnvHSPpgOU3+P5gsG";
    const SIGNED: &[u8] = b"installer bytes for the test\n";
    const SIGNATURE: &str = "untrusted comment: Photos for Proton installer signature
RUQeJbkgahsNY1rSYFbxRc94JmWDCJ9njXg2UHl11QVI2AdCjgq3UgX9SjoXC6ujjRB0GSOmeUMozDhhOovTW499Rt8wPpToow4=
trusted comment: timestamp:1792708619	file:fixture.exe	version:1.2.0
oyE7Fap3182ytzsPvkUYxWqAUB6+zazRnrv/QLsKUrwlh2Hrff3W9Ry/Df6tTSn9us6JUwJPyycri3VtCppODA==
";

    /// The same file signed as an update installer: 1.2.0, only over 1.1.0.
    const PATCH_SIGNATURE: &str = "untrusted comment: Photos for Proton installer signature
RUQeJbkgahsNY1rSYFbxRc94JmWDCJ9njXg2UHl11QVI2AdCjgq3UgX9SjoXC6ujjRB0GSOmeUMozDhhOovTW499Rt8wPpToow4=
trusted comment: timestamp:1792710244	file:patch.exe	version:1.2.0	from:1.1.0
OA3egpVQxsizklSPjXDxLp22rYJja6Bj1rzLkY1a4NLuTAduYgt6x4RRCSC2uVPew0TxyPfAr63jeqi75/6eDg==
";

    /// An installer and its signature in a folder of their own, removed when dropped.
    struct Staged {
        dir: std::path::PathBuf,
        exe: std::path::PathBuf,
        sig: std::path::PathBuf,
    }

    impl Drop for Staged {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn staged(bytes: &[u8], signature: &str) -> Staged {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "pfp-sig-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("pfp-update.exe");
        let sig = dir.join("pfp-update.exe.minisig");
        std::fs::write(&exe, bytes).unwrap();
        std::fs::write(&sig, signature).unwrap();
        Staged { dir, exe, sig }
    }

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn a_signed_newer_installer_is_accepted() {
        let t = staged(SIGNED, SIGNATURE);
        assert_eq!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.1.0")), Ok(v("1.2.0")));
    }

    #[test]
    fn a_changed_installer_is_refused() {
        let t = staged(b"installer bytes for the test!\n", SIGNATURE);
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.1.0")).is_err());
    }

    #[test]
    fn a_changed_version_is_refused() {
        let t = staged(SIGNED, &SIGNATURE.replace("version:1.2.0", "version:9.9.9"));
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.1.0")).is_err());
    }

    #[test]
    fn the_same_or_an_older_version_is_refused() {
        let t = staged(SIGNED, SIGNATURE);
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.2.0")).is_err());
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.3.0")).is_err());
    }

    #[test]
    fn another_key_and_no_signature_are_refused() {
        let t = staged(SIGNED, SIGNATURE);
        assert!(verify_installer(&t.exe, &t.sig, &v("1.1.0")).is_err());
        std::fs::remove_file(&t.sig).unwrap();
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.1.0")).is_err());
    }

    #[test]
    fn an_update_installer_runs_only_over_its_own_version() {
        let t = staged(SIGNED, PATCH_SIGNATURE);
        assert_eq!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.1.0")), Ok(v("1.2.0")));
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.0.0")).is_err());
        assert!(verify_with(TEST_KEY, &t.exe, &t.sig, &v("1.1.1")).is_err());
    }

    #[test]
    fn the_update_key_reads() {
        assert!(PublicKey::from_base64(UPDATE_KEY).is_ok());
    }
}
