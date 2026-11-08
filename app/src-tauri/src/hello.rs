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
//!
//! The prompt is parented to the window that asked, so it opens over it rather than behind
//! it. Where Hello is not set up the answer says so, and the page opens with a line saying
//! it is not protected, as the phone does on a device without a lock.

// Windows Hello answers only on Windows; elsewhere it is always unavailable.
#![cfg_attr(not(windows), allow(dead_code))]

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

    let available = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get());
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
        op.get()
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

#[cfg(not(windows))]
pub fn verify(_hwnd: isize, _message: &str) -> Verification {
    Verification::Unavailable
}

/// Whether Hello can answer here at all, asked without a prompt.
#[cfg(windows)]
pub fn available() -> bool {
    use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
    matches!(
        UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()),
        Ok(UserConsentVerifierAvailability::Available)
    )
}

#[cfg(not(windows))]
pub fn available() -> bool {
    false
}
