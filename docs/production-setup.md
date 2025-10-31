# Appium Device Farm Production Setup

This guide captures the minimum steps required to restore proprietary assets, build the project, and verify iOS real-device readiness (including GO_IOS, WDA selection, and dashboard availability).

## 1. Prerequisites

- **Node.js 18+** and **npm 8+**
- **Appium 3.x** CLI
- **SQLite** (bundled via Prisma migrations)
- **macOS host with Xcode & Command Line Tools** for iOS/tvOS dynamic WebDriverAgent builds
- **go-ios** binary (optional, required only for GO_IOS mode)
- Network access to download the private/proprietary `appium-device-farm` npm package that includes the obfuscated dashboard modules

## 2. Restore Proprietary Assets

1. Install dependencies and proprietary package (do not save to `package.json`):

   ```bash
   npm install
   npm install appium-device-farm --no-save
   ```

   The second command pulls the latest published build that contains the obfuscated dashboard bundle and server-side modules.

2. Build the TypeScript sources **and** copy proprietary UI assets:

   ```bash
   npm run build
   ```

   Internally this runs `scripts/copy-proprietary-ui.js`, which copies:

   - `node_modules/appium-device-farm/lib/src/public` (or `lib/public`) -> `lib/src/public`
   - `node_modules/appium-device-farm/lib/src/modules` (or `lib/modules`) -> `lib/src/modules`

   If the licensed package is missing the proprietary folders, the script exits with an actionable error. Reinstall the private package or validate npm auth scopes.

## 3. iOS WDA Setup Logic

The updated `src/CapabilityManager.ts` applies the following order of precedence when configuring real iOS or tvOS devices:

1. **GO_IOS Path Validation**
   - Read from `process.env.GO_IOS`
   - Validate that the binary exists; invalid paths trigger an error and fall back to dynamic/DB lookup
   - When valid and no `appium:webDriverAgentUrl` was already supplied, the code sets the URL automatically and removes conflicting WDA capabilities

2. **Database Lookup (prebuilt WDA)**
   - Only runs when GO_IOS is not active
   - Searches Prisma `appInformation` for `wda-resign.ipa` (or `wda-resign_tvos.ipa`)
   - Sets `usePreinstalledWDA`, `updatedWDABundleId`, and `updatedWDABundleIdSuffix` when present

3. **Dynamic Build (xcuitest)**
   - Executes when neither GO_IOS nor DB entries are available
   - Logs derived data path (if provided), checks Xcode availability (`xcode-select -p`), and warns when the host is not macOS or Xcode is missing
   - Leaves capabilities untouched so the xcuitest driver can perform an on-demand WebDriverAgent build

All paths emit detailed logging prefixed with `[WDA Setup]` to simplify troubleshooting.

## 4. Runtime Environment Variables

```bash
export GO_IOS="/usr/local/bin/ios"   # optional, enables go-ios transport
export APPIUM_HOME="/path/to/appium/home"  # optional, keeps plugin artifacts isolated
```

When GO_IOS is set, ensure its executable bit is preserved and the binary version is compatible with the connected devices. If GO_IOS is not set, confirm Xcode is installed and that the host can build WebDriverAgent (logs will point out missing prerequisites).

## 5. Verification Workflow

1. **Build output** - after `npm run build`, ensure `lib/src/public` and `lib/src/modules` exist and contain files.
2. **Install the plugin locally**:

   ```bash
   appium plugin install --source=local .
   ```

3. **Launch Appium with the plugin**:

   ```bash
   appium server --use-plugins=device-farm
   ```

4. **Dashboard smoke test** - open `http://localhost:4723` in a browser and confirm the UI loads without 404s or blank sections.
5. **iOS real device session** - with GO_IOS set (or prebuilt WDA available):
   - Click **Use Device** in the dashboard
   - Confirm the log contains `Using GO_IOS mode` or `Using prebuilt WDA` messages and no `installiOSWDA 400 error`
6. **Dynamic build fallback** - unset GO_IOS, clear WDA entries from the database, and start another session. Logs should indicate dynamic build mode and reference the derived data path / Xcode status.

## 6. Frequently Asked Questions

| Question | Answer |
| --- | --- |
| **Where does WDA get built when GO_IOS is not set?** | In Xcode's derived data directory (`appium:derivedDataPath` when provided; otherwise the default path returned by `xcode-select -p`). |
| **How can I verify WDA is building correctly?** | Watch the `[WDA Setup]` log messages for derived data info and monitor Xcode build logs in the default derived data folder. Sessions that proceed past `createSession` confirm success. |
| **What are the exact steps after `npm install`?** | Run `npm install appium-device-farm --no-save` and then `npm run build`. Install the plugin (`appium plugin install --source=local .`) and start Appium (`appium server --use-plugins=device-farm`). |
| **How do I set `GO_IOS` correctly?** | Export the full path to the `ios` binary (for example, `export GO_IOS="$(which ios)"`). Ensure the file exists and is executable. |
| **What Xcode tooling is required?** | Xcode plus Command Line Tools on macOS. The helper checks `xcode-select -p` and warns if the tools are missing. |
| **What happens if Xcode is not installed?** | Dynamic builds log a warning instructing you to install Xcode or configure GO_IOS; sessions may fail without one of these paths. |
| **Can I customize the WDA build location?** | Yes. Set `appium:derivedDataPath` in capabilities; the path is logged and stored on the device object for reference. |

## 7. Troubleshooting Tips

- **`installiOSWDA 400 error` on fresh database** - usually indicates GO_IOS was not detected and no prebuilt WDA exists. Set `GO_IOS` or upload a resigned WDA from the dashboard so the database lookup succeeds.
- **Copy script fails** - reinstall `appium-device-farm` with credentials that include the proprietary components. The script prints all attempted locations to simplify debugging.
- **Dashboard 404 / blank screen** - verify `lib/src/public` exists post-build and that Appium serves static assets from that location.
- **Derived data permission errors** - ensure the Appium process has write access to the provided `derivedDataPath` or leave it unset to use the default.

Stick to these steps for consistent, production-ready deployments of the Appium Device Farm plugin.
