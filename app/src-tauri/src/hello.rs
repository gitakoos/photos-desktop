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

//! The lock on the Hidden page and the app lock: Windows Hello, the PIN, face or fingerprint
//! this Windows account already signs in with, as the phone asks for the device lock there.
//! On a Mac the same check is Touch ID, with the Mac's own password where there is no Touch
//! ID or it is locked out.
//!
//! On Windows the prompt is parented to the window that asked, so it opens over it rather
//! than behind it. Where neither is set up the answer says so, and the page opens with a line
//! saying it is not protected, as the phone does on a device without a lock.

// The check answers only on Windows and macOS; on Linux it is always unavailable.
#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]

/// What the check came to.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Verification {
    Verified,
    Canceled,
    Failed,
    /// No Hello on this account or device: nothing to check against.
    Unavailable,
}

#[cfg(windows)]
pub fn verify(hwnd: isize, message: &str) -> Verification {
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    let available = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join());
    match available {
        Ok(UserConsentVerifierAvailability::Available) => {}
        Ok(_) => return Verification::Unavailable,
        Err(_) => return Verification::Failed,
    }
    let answer = (|| -> windows::core::Result<UserConsentVerificationResult> {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        let op: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(HWND(hwnd as _), &HSTRING::from(message))?
        };
        op.join()
    })();
    match answer {
        Ok(UserConsentVerificationResult::Verified) => Verification::Verified,
        Ok(UserConsentVerificationResult::Canceled) => Verification::Canceled,
        Ok(UserConsentVerificationResult::DeviceNotPresent)
        | Ok(UserConsentVerificationResult::NotConfiguredForUser)
        | Ok(UserConsentVerificationResult::DisabledByPolicy) => Verification::Unavailable,
        _ => Verification::Failed,
    }
}

/// Touch ID or the Mac's password. The prompt is the system's own and answers on a queue of
/// its own, so this thread waits for that answer; it is never the main thread (see the caller).
#[cfg(target_os = "macos")]
pub fn verify(_hwnd: isize, message: &str) -> Verification {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::{mpsc, Mutex};

    let policy = LAPolicy::DeviceOwnerAuthentication;
    let context = unsafe { LAContext::new() };
    if let Err(e) = unsafe { context.canEvaluatePolicy_error(policy) } {
        return match la_answer(e.code()) {
            Verification::Unavailable => Verification::Unavailable,
            _ => Verification::Failed,
        };
    }
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(Some(tx));
    let reply = RcBlock::new(move |ok: Bool, error: *mut NSError| {
        let answer = if ok.as_bool() {
            Verification::Verified
        } else {
            unsafe { error.as_ref() }.map_or(Verification::Failed, |e| la_answer(e.code()))
        };
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(answer);
        }
    });
    // The system refuses an empty reason outright.
    let reason = NSString::from_str(if message.trim().is_empty() { "Photos for Proton" } else { message });
    unsafe { context.evaluatePolicy_localizedReason_reply(policy, &reason, &reply) };
    // The context stays alive until the answer is in: dropping it would cancel the prompt.
    let answer = rx.recv().unwrap_or(Verification::Failed);
    drop(context);
    answer
}

/// What a LocalAuthentication error code comes to. Only a Mac with no password at all is
/// unavailable, since that answer lets the lock open; every other refusal keeps it shut.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn la_answer(code: isize) -> Verification {
    const USER_CANCEL: isize = -2;
    const USER_FALLBACK: isize = -3;
    const SYSTEM_CANCEL: isize = -4;
    const PASSCODE_NOT_SET: isize = -5;
    const APP_CANCEL: isize = -9;
    match code {
        USER_CANCEL | USER_FALLBACK | SYSTEM_CANCEL | APP_CANCEL => Verification::Canceled,
        PASSCODE_NOT_SET => Verification::Unavailable,
        _ => Verification::Failed,
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn verify(_hwnd: isize, _message: &str) -> Verification {
    Verification::Unavailable
}

/// Whether Hello can answer here at all, asked without a prompt.
#[cfg(windows)]
pub fn available() -> bool {
    use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
    matches!(
        UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()),
        Ok(UserConsentVerifierAvailability::Available)
    )
}

#[cfg(target_os = "macos")]
pub fn available() -> bool {
    use objc2_local_authentication::{LAContext, LAPolicy};
    let context = unsafe { LAContext::new() };
    unsafe { context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_ok()
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn available() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{la_answer, Verification};

    #[test]
    fn only_a_mac_without_a_password_leaves_the_lock_open() {
        assert_eq!(la_answer(-5), Verification::Unavailable);
        for canceled in [-2, -3, -4, -9] {
            assert_eq!(la_answer(canceled), Verification::Canceled, "{canceled}");
        }
        // Failed, a lockout, no biometry, a context gone stale, not interactive: all stay locked.
        for failed in [-1, -6, -7, -8, -10, -1004, 0] {
            assert_eq!(la_answer(failed), Verification::Failed, "{failed}");
        }
    }
}
