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

// Proton's crypto packages ship TypeScript sources rather than built JavaScript,
// and Node will not strip types under node_modules. Vite transforms them instead,
// which is what lets a test import anything that reaches them.
//
// The openpgp alias is the build's, for the same reason `build.mjs` carries it:
// `@protontech/crypto` imports `openpgp/lightweight`, a subpath that only
// exports a browser build. Pointing it at openpgp's own entry keeps the tests
// on the Node build the sidecar actually ships.
//
// The SDK is taken from its source rather than its published build for the same
// reason: the build is CommonJS and keeps `.ts` in its own import paths, which
// Node refuses to load from node_modules. Its source is what `tsc` checks anyway.

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "openpgp/lightweight": "openpgp",
      "@protontech/drive-sdk": "@protontech/drive-sdk/src/index.ts",
    },
  },
  test: {
    server: { deps: { inline: [/@protontech/] } },
    setupFiles: ["./vitest.setup.ts"],
  },
});
