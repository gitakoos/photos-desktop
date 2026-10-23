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

import { Confirm } from "./Confirm";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";

/**
 * The question before signing out, which says what goes and what stays: signing out
 * empties everything the app keeps on this PC, and nothing of it can be brought back
 * except by downloading it again.
 */
export function SignOutConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <Confirm
      title={t("signOut.title")}
      message={t(isWindows ? "signOut.message" : "signOut.messageLinux")}
      confirmLabel={t("profile.signOut")}
      danger
      irreversible
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
