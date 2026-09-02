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
prepared before bundling; Tauri then seals the nested CLI and outer app before
it creates the final DMG.

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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify OK` not printed at end of `gen-csr.sh` | CSR generation failed silently | Re-run with `set -x` (run `bash -x scripts/apple-signing/gen-csr.sh ...`) to see why |
| `make-p12.sh` says `devid.key not found` | You ran `gen-csr.sh` for a different user or it was cleaned out | Re-run `gen-csr.sh` |
| `sign-and-notarize.sh`: "not in the codesigning identity list" | The literal string doesn't match what's in Keychain (often a single quote / extra space) | Re-run `security find-identity -v -p codesigning` and copy the line verbatim |
| `notarytool` returns "Invalid" / Pending never completes | Usually one of the JIT entitlements is being scrutinized | The script does **not** add `--no-wait` so you can read the submission log: `xcrun notarytool log <submission-id> --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_APP_SPECIFIC_PASSWORD` |
| `stapler validate` says ticket not present | Notarization didn't complete | Re-run with `SKIP_BUILD=1` so the .dmg isn't rebuilt |
| verification says `packaged CLI is not executable` | The sidecar lost its Unix execute bit before Tauri bundled it | Rebuild through `scripts/build-cli.mjs`; it installs macOS/Linux sidecars with mode `0755` and fails if that invariant is broken |
