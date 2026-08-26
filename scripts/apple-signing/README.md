# Apple Developer ID signing for Flowix

This directory holds the three scripts that turn an Apple Developer account into a signed, notarized macOS DMG without ever leaking private keys or Apple credentials through any AI / chat / third-party service.

Everything sensitive stays on **your Mac** under `~/.flowix-signing/`. The scripts in this directory are safe to commit; the files in `~/.flowix-signing/` are not, and are excluded by the repo's `.gitignore`.

## The full pipeline, in one diagram

```
Your Mac (this script package runs here)
─────────────────────────────────────────
gen-csr.sh
   ↓ writes
   ├─ ~/.flowix-signing/devid.key          (private key, never leaves Mac)
   └─ ~/.flowix-signing/devid.csr          (CSR for Apple)
                                                       │
                                                       │ (you upload, via Apple website)
                                                       ▼
                                       developer.apple.com → Certificates → +
                                       "Developer ID Application" → upload .csr
                                                       │
                                                       │ (you download, via Apple website)
                                                       ▼
make-p12.sh
   ↓ reads
   ├─ ~/.flowix-signing/devid.key
   └─ <downloaded .cer>
   ↓ writes
   └─ ~/.flowix-signing/devid.p12         (PKCS#12 bundle, full identity)

(optional, for local dev)
   ↓
   open ~/.flowix-signing/devid.p12       (imports to Keychain; this is what
                                           dodges the "在钥匙串中找不到指定的项"
                                           error from bare-.cer import)

sign-and-notarize.sh
   ↓ reads
   ├─ $APPLE_SIGNING_IDENTITY (from `security find-identity -v -p codesigning`)
   ├─ $APPLE_TEAM_ID
   ├─ $APPLE_ID
   └─ $APPLE_APP_SPECIFIC_PASSWORD (NOT your Apple ID password)
   ↓ produces
   └─ .build/cargo-target/<target>/release/bundle/dmg/Flowix_*.dmg
                                    (signed, hardened-runtime, notarized, stapled)
```

## Step-by-step (one-time setup, ~10 min)

### 1. Generate the CSR

```bash
bash scripts/apple-signing/gen-csr.sh \
  "you@appleid.com" \
  "Your Name" \
  "Your Org Name (must match Apple Developer Account EXACTLY)" \
  "US"
```

The output tells you where the .key and .csr landed.

### 2. Upload the CSR in your browser

Open <https://developer.apple.com/account/resources/certificates/list>, click **+**, choose **Developer ID Application**, upload `~/.flowix-signing/devid.csr`. Apple issues a `.cer` within ~30s. Download it (e.g. to `~/Desktop/developerID_application.cer`).

### 3. Build a portable .p12 from .cer + private key

```bash
bash scripts/apple-signing/make-p12.sh ~/Desktop/developerID_application.cer
```

You'll be prompted for an export password — **remember it**, this same password goes into your CI secret as `APPLE_CERT_PASSWORD`.

### 4. (Local dev only) Import the .p12 into your Keychain

```bash
open ~/.flowix-signing/devid.p12
```

Then verify:

```bash
security find-identity -v -p codesigning
```

The output line that looks like `"Developer ID Application: Your Name (ABCDE12345)"` is what `APPLE_SIGNING_IDENTITY` should equal.

### 5. Sign + notarize a build

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_TEAM_ID="ABCDE12345"
export APPLE_ID="you@appleid.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"

bash scripts/apple-signing/sign-and-notarize.sh
```

The script will:
1. Build via `npm run tauri:build:prod`
2. Mount the final .dmg and verify that its CLI is executable, has the expected architecture, and that all nested signatures are valid
3. Submit that exact .dmg to Apple's notary service
4. Staple the notarization ticket back onto the .dmg and verify Gatekeeper acceptance
5. Print the SHA-256 of the verified .dmg

The app is never modified after the DMG is created. The CLI staging binary is
signed before bundling; Tauri then seals the nested CLI and outer app before it
creates the final DMG.

## What you should NEVER paste into a chat

| Item | Why |
|---|---|
| Apple ID password | Even if you trust the recipient, it's the master key to your Apple Account |
| 2FA codes | They're time-limited and intended for appleid.apple.com only |
| App-Specific Password (`APPLE_APP_SPECIFIC_PASSWORD`) | Goes in CI secrets, not chat |
| Contents of `~/.flowix-signing/devid.key` | If leaked, treat the cert as compromised and revoke it on Apple Developer Portal |
| Contents of `~/.flowix-signing/devid.p12` | Same as above plus the export password |
| `Developer ID Application: ...` full identity string | Not as sensitive but is enough to find your Team ID and Org name |

If any of the above ever appears in a transcript you share (GitHub issue, Slack thread, LLM conversation), **revoke the certificate immediately** at <https://developer.apple.com/account/resources/certificates/list> and regenerate.

## Things that intentionally do NOT happen in this directory

- We never log in to your Apple Account programmatically. The Portal still requires browser + 2FA.
- We never invoke `notarytool` with a password from a file. It comes from the env var, set per-invocation.
- We never commit the private key. The `.gitignore` excludes `*.p12`, `*.key`, `*.csr`, and the whole `~/.flowix-signing/` directory.

## iOS TestFlight (Internal Testing)

The macOS pipeline above does NOT cover iOS — `notarytool` is macOS-only. iOS ships through App Store Connect, with two Apple-issued artifacts:

1. An **Apple Distribution** certificate (Personal accounts may see it labeled **iOS Distribution** — same RSA identity) which signs the .ipa.
2. A provisioning profile (App Store type) binding that cert to the bundle id `com.flowix.app.mobile`.

Authenticating uploads happens with an **App Store Connect API key** (`.p8`), not the Apple ID / App-Specific-Password pair that notarytool uses.

```
Your Mac (this script package runs here)
─────────────────────────────────────────
gen-ios-csr.sh
   ↓ writes
   ├─ ~/.flowix-signing/devid-ios.key       (private key, never leaves Mac)
   └─ ~/.flowix-signing/devid-ios.csr       (CSR for Apple)
                                                       │
                                                       │ (you upload, via Apple website)
                                                       ▼
                                       developer.apple.com → Certificates → +
                                       "Apple Distribution" → upload .csr
                                                       │
                                                       │ (you download, via Apple website)
                                                       ▼
make-ios-p12.sh
   ↓ reads
   ├─ ~/.flowix-signing/devid-ios.key
   └─ <downloaded .cer>
   ↓ writes
   └─ ~/.flowix-signing/devid-ios.p12      (PKCS#12 bundle, full identity)

store-asc-api-key.sh
   ↓ reads
   └─ <downloaded AuthKey_XXXXXXXX.p8>
   ↓ writes
   ├─ ~/.flowix-signing/appstoreconnect/AuthKey_<KEY_ID>.p8
   ├─ ~/.flowix-signing/appstoreconnect/.keyid
   └─ ~/.flowix-signing/appstoreconnect/.issuerid

build-and-upload-testflight.sh
   ↓ reads
   ├─ $APPLE_TEAM_ID
   ├─ $IOS_CERT_P12_PATH + $IOS_CERT_P12_PASSWORD
   ├─ $IOS_MOBILE_PROVISION_PATH
   └─ $APPLE_ASC_API_KEY_ID + $APPLE_ASC_API_ISSUER_ID + $APPLE_ASC_API_KEY_PATH
   ↓ produces
   └─ app/flowix-mobile/gen/apple/build/.../Flowix.ipa
                                       (signed, ready for TestFlight)
   ↓ then uploads via xcrun altool --upload-app --type ios --apiKey ...
```

### Step-by-step (one-time setup, ~30 min wall clock)

#### 1. Register the App ID

In <https://developer.apple.com/account/resources/identifiers/list>, click **+**, choose **App IDs**, register `com.flowix.app.mobile`. Capabilities: tick **Keychain Sharing** (so `tauri-plugin-keyring-store` can persist across reinstalls). Skip Push / App Groups / Associated Domains — we don't use them.

#### 2. Generate the iOS CSR

```bash
bash scripts/apple-signing/gen-ios-csr.sh \
  "you@appleid.com" \
  "Your Name" \
  "Your Legal Name (Personal accounts: the name on your Membership Details)" \
  "US"
```

#### 3. Upload the CSR in your browser

<https://developer.apple.com/account/resources/certificates/list>, click **+**, choose **Apple Distribution** (Personal accounts may see **iOS Distribution** — both produce the same RSA identity). Upload `~/.flowix-signing/devid-ios.csr`. Apple issues a `.cer` within ~30s. Download it (e.g. to `~/Desktop/apple_distribution.cer`).

#### 4. Build a portable .p12 from .cer + private key

```bash
bash scripts/apple-signing/make-ios-p12.sh ~/Desktop/apple_distribution.cer
```

You'll be prompted for an export password — **remember it**, this same password goes into your CI secret as `IOS_CERT_P12_PASSWORD`.

#### 5. Create the App Store provisioning profile

<https://developer.apple.com/account/resources/profiles/list>, click **+**, choose **App Store** (NOT "Ad Hoc"). Bind: cert from step 3 + App ID `com.flowix.app.mobile` from step 1. App Store profiles ignore the Devices field — TestFlight handles distribution server-side. Download the `.mobileprovision` (e.g. to `~/Downloads/Flowix iOS AppStore.mobileprovision`).

#### 6. Create the App record on App Store Connect

<https://appstoreconnect.apple.com> → **My Apps** → **+** → **New App**. Name `Flowix`, primary language English, bundle id `com.flowix.app.mobile`, SKU `flowix-ios-001` (internal, never shown), user access Full Access.

#### 7. Generate an App Store Connect API key

<https://appstoreconnect.apple.com/access/api> → **Keys** → **App Store Connect API** → **+**. Name `flowix-testflight-upload`, access **App Manager** or **Admin** (Developer can't upload builds). **Download the `.p8` immediately — Apple will not let you download it again.** Note the **Key ID** (10 chars) and **Issuer ID** (UUID).

```bash
bash scripts/apple-signing/store-asc-api-key.sh \
  ~/Downloads/AuthKey_XXXXXXXX.p8 \
  XXXXXXXX \
  12345678-1234-1234-1234-123456789012
```

### Build + upload every time

```bash
export APPLE_TEAM_ID="9FJ9ZD86C2"
export IOS_CERT_P12_PATH="$HOME/.flowix-signing/devid-ios.p12"
export IOS_CERT_P12_PASSWORD="<step 4 password>"
export IOS_MOBILE_PROVISION_PATH="$HOME/Downloads/Flowix iOS AppStore.mobileprovision"
export APPLE_ASC_API_KEY_ID="<step 7 key id>"
export APPLE_ASC_API_ISSUER_ID="<step 7 issuer id>"
export APPLE_ASC_API_KEY_PATH="$HOME/.flowix-signing/appstoreconnect/AuthKey_<KEY_ID>.p8"

npm run tauri:ios:build:testflight
```

(`npm run tauri:ios:build:testflight` is a thin wrapper for `bash scripts/build-and-upload-testflight.sh`.)

The script will:

1. Refresh the Xcode project (`tauri ios init --ci`) and re-apply the iOS native patch (`scripts/patch-ios-native.mjs` — this also writes `Flowix.entitlements` into `gen/apple/.../flowix-mobile_iOS.entitlements`, since `tauri ios init` regenerates that file with an empty `<dict/>`)
2. Run `tauri ios build --export-method release-testing`, feeding the .p12 / .mobileprovision / ASC API key through `IOS_CERTIFICATE` / `IOS_MOBILE_PROVISION` / `APPLE_API_KEY*` env vars (Tauri CLI 2.x translates these to xcodebuild arguments internally)
3. Locate the .ipa under `app/flowix-mobile/gen/apple/build/`
4. Run `scripts/verify-ios-release.sh` — `codesign --verify --strict --deep`, TeamIdentifier cross-check against `APPLE_TEAM_ID`, embedded.mobileprovision decoded and compared, expiration warning if <30 days
5. Upload via `xcrun altool --upload-app --type ios --apiKey ... --apiIssuer ... -f Flowix.ipa --output-format xml`
6. Print SHA-256 + the App Store Connect URL to assign the build to an internal testing group

The IPA is never modified after xcodebuild exports it.

### Tester invitation (browser, ~10 min)

After upload the build shows up in **App Store Connect → Flowix → TestFlight → Builds** as "Processing" for ~5-10 minutes, then transitions to "Ready to Submit" / "Invalid Binary". Once Ready, click **Internal Testing** → **+** next to the default "App Store Connect Users" group → pick the build → invite testers by email.

Internal testing does NOT need Apple beta review. Each tester receives an Apple email; they open it on their iPhone, install the free TestFlight app from the App Store if missing, accept the invitation, and Flowix becomes installable. First launch requires accepting the developer trust prompt: **Settings → General → VPN & Device Management** → tap the developer's name ("Yin Liao") → **Trust**.

### What you should NEVER paste into a chat (iOS additions)

| Item | Why |
|---|---|
| Contents of `~/.flowix-signing/devid-ios.key` / `devid-ios.p12` | Same as macOS — revoke + regenerate |
| Contents of `~/.flowix-signing/appstoreconnect/AuthKey_<KEY_ID>.p8` | Lets anyone with the matching Key ID + Issuer ID upload builds to your ASC — revoke immediately via <https://appstoreconnect.apple.com/access/api> |
| `.mobileprovision` for `com.flowix.app.mobile` | Includes your team id + cert SHA-1; less sensitive but enough to impersonate your build chain |

## Things that intentionally do NOT happen in this directory (iOS additions)

- We never invoke `xcrun altool` with the Apple ID password on the command line — only with the API key triple or an App-Specific Password piped via env var, never inlined in a script body
- We never commit the iOS provisioning profile, the .p12, or the .p8. `.gitignore` covers `*.p8`, `*.mobileprovision`, and the `appstoreconnect/` dir under `~/.flowix-signing/`
- The Tauri pipeline does NOT write a custom `ExportOptions.plist` — Tauri CLI generates one internally for each `--export-method` value. The native Swift pipeline writes its own temporary export plist because it calls `xcodebuild` directly.

### Native Swift iOS TestFlight

The native SwiftUI client has an independent target and App Store Connect app:

- Project: `app/flowix-ios-native/FlowixIOS.xcodeproj`
- Scheme: `FlowixIOS`
- Bundle ID: `com.flowix.app.mobile` (same as the existing Tauri TestFlight app)
- Marketing version: `1.2.0`
- Provisioning variable: `IOS_NATIVE_MOBILE_PROVISION_PATH`

Reuse the existing `com.flowix.app.mobile` App ID and App Store provisioning profile. The native binary is uploaded as an update to the existing Tauri TestFlight app. Then run:

```bash
export APPLE_TEAM_ID="9FJ9ZD86C2"
export IOS_CERT_P12_PATH="$HOME/.flowix-signing/devid-ios.p12"
export IOS_CERT_P12_PASSWORD="<p12 password>"
export IOS_NATIVE_MOBILE_PROVISION_PATH="$HOME/.flowix-signing/Flowix_iOS_AppStore.mobileprovision"
export APPLE_ASC_API_KEY_ID="<key id>"
export APPLE_ASC_API_ISSUER_ID="<issuer uuid>"
export APPLE_ASC_API_KEY_PATH="$HOME/.flowix-signing/appstoreconnect/AuthKey_<KEY_ID>.p8"

npm run ios-native:build:testflight
```

This builds the editor bundle, Rust native API, signed `FlowixIOS` archive, and App Store IPA, then verifies and uploads it. `SKIP_UPLOAD=1` builds and verifies without uploading; `IOS_BUILD_NUMBER` overrides the default timestamp build number.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify OK` not printed at end of `gen-csr.sh` | CSR generation failed silently | Re-run with `set -x` (run `bash -x scripts/apple-signing/gen-csr.sh ...`) to see why |
| `make-p12.sh` says `devid.key not found` | You ran `gen-csr.sh` for a different user or it was cleaned out | Re-run `gen-csr.sh` |
| `sign-and-notarize.sh`: "not in the codesigning identity list" | The literal string doesn't match what's in Keychain (often a single quote / extra space) | Re-run `security find-identity -v -p codesigning` and copy the line verbatim |
| `notarytool` returns "Invalid" / Pending never completes | Usually one of the JIT entitlements is being scrutinized | The script does **not** add `--no-wait` so you can read the submission log: `xcrun notarytool log <submission-id> --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_APP_SPECIFIC_PASSWORD` |
| `stapler validate` says ticket not present | Notarization didn't complete | Re-run with `SKIP_BUILD=1` so the .dmg isn't rebuilt |
| verification says `packaged CLI is not executable` | The sidecar lost its Unix execute bit before Tauri bundled it | Rebuild through `scripts/build-cli.mjs`; it installs macOS/Linux sidecars with mode `0755` and fails if that invariant is broken |
