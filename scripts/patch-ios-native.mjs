import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedSourceDir = resolve(root, 'app/flowix-mobile/gen/apple/Sources/flowix-mobile');
const generatedAppleDir = resolve(root, 'app/flowix-mobile/gen/apple');
const nativeSourceDir = resolve(root, 'app/flowix-mobile/ios');
const mobileConfigPath = resolve(root, 'app/flowix-mobile/tauri.conf.json');
const projectPath = resolve(generatedAppleDir, 'project.yml');
const appIconDir = resolve(generatedAppleDir, 'Assets.xcassets/AppIcon.appiconset');
const flattenAppIconsScript = resolve(root, 'scripts/flatten-ios-app-icons.swift');
const portraitOrientations = `        UISupportedInterfaceOrientations:
          - UIInterfaceOrientationPortrait
        UISupportedInterfaceOrientations~ipad:
          - UIInterfaceOrientationPortrait
          - UIInterfaceOrientationPortraitUpsideDown
          - UIInterfaceOrientationLandscapeLeft
          - UIInterfaceOrientationLandscapeRight`;

// Entitlements source-of-truth lives in app/flowix-mobile/ios/; `tauri ios init`
// (which patch runs after) regenerates gen/apple/ and resets the entitlements
// file to <dict/>, so we re-stamp it here. Without keychain-access-groups the
// tauri-plugin-keyring-store writes won't survive reinstall.
const entitlementsSource = resolve(root, 'app/flowix-mobile/ios/Flowix.entitlements');
const entitlementsTarget = resolve(root, 'app/flowix-mobile/gen/apple/flowix-mobile_iOS/flowix-mobile_iOS.entitlements');

// Inject DEVELOPMENT_TEAM + PROVISIONING_PROFILE_SPECIFIER into project.yml's
// target settings, so xcodegen writes them into pbxproj in the correct
// location. Tauri CLI 2.11.x's `ios build` injects these in the wrong place,
// so we do the injection upstream of xcodegen and skip `tauri ios build`
// entirely (calling `xcodebuild` directly from the pipeline script).
const teamId = process.env.APPLE_TEAM_ID;
const provisionPath = process.env.IOS_MOBILE_PROVISION_PATH;
if (teamId && provisionPath && existsSync(projectPath)) {
  // security cms -D -i file -o - doesn't work (security cms doesn't accept
  // "-" as a filename); write to a temp file and extract with plutil.
  const tmpPlist = resolve(generatedAppleDir, '.prov.plist.tmp');
  try {
    execFileSync('security', ['cms', '-D', '-i', provisionPath, '-o', tmpPlist], { stdio: 'pipe' });
    const provUUID = execFileSync('plutil', ['-extract', 'UUID', 'raw', tmpPlist], { encoding: 'utf8' }).trim();
    if (provUUID && /^[A-Z0-9-]{36}$/i.test(provUUID)) {
      const yml = readFileSync(projectPath, 'utf8');
      const injection = `        DEVELOPMENT_TEAM: ${teamId}\n        PROVISIONING_PROFILE_SPECIFIER: ${provUUID}\n        CODE_SIGN_STYLE: Manual\n        CODE_SIGN_IDENTITY[sdk=iphoneos*]: "Apple Distribution"\n`;
      const patched = yml.replace(
        /(targets:\n\s+flowix-mobile_iOS:[\s\S]+?settings:\n\s+base:\n)([\s\S]*?)(\n\s{4}groups:)/,
        (m, head, body, tail) => head + injection + tail
      );
      if (patched !== yml) {
        writeFileSync(projectPath, patched);
        console.log(`project.yml: injected DEVELOPMENT_TEAM=${teamId} PROVISIONING_PROFILE_SPECIFIER=${provUUID}`);
      }
    } else {
      console.warn(`[warn] could not extract UUID from ${provisionPath} (got '${provUUID}'); project.yml not patched`);
    }
  } catch (e) {
    console.warn(`[warn] failed to extract UUID from ${provisionPath}: ${e.message}`);
  } finally {
    try { execFileSync('rm', ['-f', tmpPlist]); } catch {}
  }
}

if (!existsSync(generatedSourceDir)) {
  throw new Error('iOS project is not initialized. Run tauri ios init first.');
}

mkdirSync(generatedSourceDir, { recursive: true });
const nativeSources = readdirSync(nativeSourceDir)
  .filter((name) => name.endsWith('.m'));
if (!nativeSources.length) {
  throw new Error(`Missing iOS native Objective-C sources: ${nativeSourceDir}`);
}
// Generated Apple sources are disposable. Copy every maintained bridge file
// so the build never accidentally retains an old, removed native bridge.
for (const legacyName of ['keyboard-accessory-suppressor.m']) {
  rmSync(resolve(generatedSourceDir, legacyName), { force: true });
}
for (const sourceName of nativeSources) {
  cpSync(resolve(nativeSourceDir, sourceName), resolve(generatedSourceDir, sourceName));
}
console.log(`iOS native bridge synced: ${nativeSources.join(', ')}`);
if (existsSync(projectPath)) {
  const mobileVersion = JSON.parse(readFileSync(mobileConfigPath, 'utf8')).version;
  const mobileBuildNumber = process.env.IOS_BUILD_NUMBER || mobileVersion;
  if (typeof mobileVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(mobileVersion)) {
    throw new Error(`Invalid mobile version in tauri.conf.json: ${mobileVersion}`);
  }
  if (typeof mobileBuildNumber !== 'string' || !/^\d+(\.\d+){0,2}$/.test(mobileBuildNumber)) {
    throw new Error(`Invalid IOS_BUILD_NUMBER: ${mobileBuildNumber}`);
  }
  let project = readFileSync(projectPath, 'utf8')
    .replace(
      /        UISupportedInterfaceOrientations:\n(?:          - [^\n]+\n)+        UISupportedInterfaceOrientations~ipad:\n(?:          - [^\n]+\n)+/,
      `${portraitOrientations}\n`,
    )
    .replace(/CFBundleShortVersionString:\s*[^\n]+/, `CFBundleShortVersionString: ${mobileVersion}`)
    .replace(/CFBundleVersion:\s*[^\n]+/, `CFBundleVersion: "${mobileBuildNumber}"`);

  // Remove the "Build Rust Code" preBuildScript. Tauri CLI's `tauri ios
  // xcode-script` connects to a dev server over WebSocket — useful for
  // `tauri ios dev` but incompatible with `tauri ios build` (and with our
  // pipeline, which compiles Rust directly via cargo). Without removing
  // this, xcodebuild's archive step fails with
  //   "failed to read CLI options: ... Connection refused"
  project = project.replace(
    /\n    preBuildScripts:\n(?: {6,}[^\n]*\n)*/,
    '\n    # preBuildScripts removed by patch-ios-native.mjs (cargo runs the Rust build directly)\n'
  );
  project = project.replace(
    /\n    # preBuildScripts removed by patch-ios-native\.mjs \(cargo runs the Rust build directly\)(?: {6,}[^\n]*)?\n/,
    '\n    # preBuildScripts removed by patch-ios-native.mjs (cargo runs the Rust build directly)\n',
  );

  writeFileSync(projectPath, project);
  execFileSync('xcodegen', [], { cwd: generatedAppleDir, stdio: 'inherit' });
}

// Post-xcodegen pbxproj fix: xcodegen includes `Externals/libapp.a` as both
// (a) a framework dependency and (b) a resource to copy. The latter is wrong
// — libapp.a is a static lib that the linker consumes, not a resource to
// embed in the .app. Without this fix xcodebuild dies with:
//   "duplicate output file '...Flowix.app/libapp.a'" and ARCHIVE FAILS.
if (existsSync(projectPath)) {
  const pbxprojPath = resolve(generatedAppleDir, 'flowix-mobile.xcodeproj/project.pbxproj');
  if (existsSync(pbxprojPath)) {
    let pbxproj = readFileSync(pbxprojPath, 'utf8');
    const before = pbxproj.length;

    // Drop BuildFile entries that reference libapp.a as a Resource.
    pbxproj = pbxproj.replace(
      /^\s*[0-9A-F]{24} \/\* libapp\.a in Resources \*\/ = \{isa = PBXBuildFile;[^}]+\};\n/gm,
      ''
    );
    pbxproj = pbxproj.replace(
      /^\s*[0-9A-F]{24} \/\* libapp\.a in Resources \*\/,\n/gm,
      '',
    );

    // Keep the file reference used by the Frameworks build file and remove
    // every duplicate reference from PBXFileReference and PBXGroup sections.
    // Replacing IDs with a marker leaves an invalid pbxproj; remove the full
    // declaration and group membership lines instead.
    const frameworkRef = pbxproj.match(
      /\/\* libapp\.a in Frameworks \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24}) \/\* libapp\.a \*\//,
    )?.[1];
    const fileRefIds = [...pbxproj.matchAll(
      /^\s*([0-9A-F]{24}) \/\* libapp\.a \*\/ = \{isa = PBXFileReference;[^}]+\};\n/gm,
    )].map((match) => match[1]);
    for (const id of fileRefIds.filter((value) => value !== frameworkRef)) {
      pbxproj = pbxproj.replace(
        new RegExp(`^\\s*${id} \\/\\* libapp\\.a \\*\\/ = \\{isa = PBXFileReference;[^}]+\\};\\n`, 'gm'),
        '',
      );
      pbxproj = pbxproj.replace(
        new RegExp(`^\\s*${id} \\/\\* libapp\\.a \\*\\/,\\n`, 'gm'),
        '',
      );
    }
    if (pbxproj.length !== before) {
      writeFileSync(pbxprojPath, pbxproj);
      console.log(`iOS pbxproj repair: removed libapp.a Resources entries + duplicate file refs (Tauri's xcodegen template bug)`);
    }
  }
}

if (existsSync(entitlementsSource)) {
  mkdirSync(dirname(entitlementsTarget), { recursive: true });
  cpSync(entitlementsSource, entitlementsTarget);
  console.log(`iOS entitlements patch applied: ${entitlementsTarget}`);
} else {
  console.warn(`[warn] entitlements source missing: ${entitlementsSource} - create it before the next build (TestFlight upload will fail without keychain-access-groups).`);
}

// Keep iOS aligned with the dedicated mobile icon source. Tauri regenerates
// this asset catalog on every `ios init`, so replace every generated size from
// the mobile source instead of editing the disposable gen/apple files by hand.
const mobileIconSource = resolve(root, 'app/flowix-web/assets/app-icon-mobile.png');
if (existsSync(appIconDir) && existsSync(flattenAppIconsScript)) {
  const appIconContentsPath = resolve(appIconDir, 'Contents.json');
  if (!existsSync(mobileIconSource)) {
    throw new Error(`Missing mobile icon source: ${mobileIconSource}`);
  }
  if (!existsSync(appIconContentsPath)) {
    throw new Error(`Missing iOS AppIcon contents: ${appIconContentsPath}`);
  }

  const appIconContents = JSON.parse(readFileSync(appIconContentsPath, 'utf8'));
  const appIcons = appIconContents.images
    .filter(({ filename }) => typeof filename === 'string' && filename.endsWith('.png'))
    .map(({ filename, size, scale }) => {
      const logicalSize = Number.parseFloat(size.split('x')[0]);
      const pixelSize = Math.round(logicalSize * Number.parseFloat(scale));
      const target = resolve(appIconDir, filename);
      execFileSync('sips', ['-z', String(pixelSize), String(pixelSize), mobileIconSource, '--out', target], { stdio: 'ignore' });
      return target;
    });
  if (appIcons.length > 0) {
    execFileSync('swift', [flattenAppIconsScript, ...appIcons], { stdio: 'inherit' });
    console.log(`iOS AppIcon synced with mobile source and alpha flattened: ${appIcons.length} image(s)`);
  }
}

// Fix-up: `tauri ios build` (when run with IOS_CERTIFICATE /
// IOS_MOBILE_PROVISION env vars) injects DEVELOPMENT_TEAM and
// PROVISIONING_PROFILE_SPECIFIER into project.pbxproj, but Tauri CLI 2.11.x
// inserts the lines AFTER the closing `};` of each XCBuildConfiguration's
// buildSettings block. Xcode then ignores them and the build dies with
//   "flowix-mobile_iOS requires a provisioning profile".
// We surgically move each orphaned signing-related line back INSIDE the
// preceding `buildSettings = { ... };` block. Idempotent — running twice is
// a no-op because orphaned lines are already gone.
if (existsSync(projectPath)) {
  const original = readFileSync(projectPath, 'utf8');
  const lines = original.split('\n');
  const orphanKeys = new Set([
    'DEVELOPMENT_TEAM',
    '"DEVELOPMENT_TEAM[sdk=iphoneos*]"',
    'PROVISIONING_PROFILE_SPECIFIER',
    '"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"',
    '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"',
  ]);
  const keyPattern = /^(\s*)(DEVELOPMENT_TEAM|"DEVELOPMENT_TEAM\[sdk=iphoneos\*\]"|PROVISIONING_PROFILE_SPECIFIER|"PROVISIONING_PROFILE_SPECIFIER\[sdk=iphoneos\*\]"|"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]") = .+;$/;

  const out = [];
  let moved = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(keyPattern);
    if (!m) { out.push(line); continue; }
    const stripped = line.trim();
    const key = stripped.split('=')[0].trim();
    if (!orphanKeys.has(key)) { out.push(line); continue; }

    // Walk backward through `out`, tracking `{` / `}` depth, until we find
    // a closing `};` at depth 0 — that's the end of the preceding
    // buildSettings block. Insert the orphan line JUST BEFORE that `};`.
    let depth = 0;
    let insertIdx = -1;
    for (let j = out.length - 1; j >= 0; j--) {
      const prev = out[j];
      for (const ch of prev) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0 && prev.trim() === '};') {
        insertIdx = j;
        break;
      }
    }
    if (insertIdx === -1) {
      out.push(line);  // no preceding block found; emit as-is
    } else {
      const indent = line.match(/^(\s*)/)[1];
      out.splice(insertIdx, 0, indent + stripped);
      moved++;
    }
  }
  const repaired = out.join('\n');
  if (moved > 0) {
    writeFileSync(projectPath, repaired);
    console.log(`iOS pbxproj repair: moved ${moved} orphaned signing line(s) back into their buildSettings blocks`);
  }
}

console.log('iOS native patch complete');
