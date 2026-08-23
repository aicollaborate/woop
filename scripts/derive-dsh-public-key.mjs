import fs from "node:fs";
import path from "node:path";

// Tauri's updater config stores the public key in its updater-compatible
// representation. DSH uses minisign-verify::PublicKey::decode, which expects
// the complete two-line minisign.pub text. Keep one source of truth: the
// updater public key in tauri.conf.production.json.
const repoRoot = path.resolve(import.meta.dirname, "..");
const configPath = path.join(
  repoRoot,
  "app",
  "flowix-desktop",
  "tauri.conf.production.json",
);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const configured = config.plugins?.updater?.pubkey?.trim();

if (!configured) {
  throw new Error("plugins.updater.pubkey is missing from tauri.conf.production.json");
}

const decodedBytes = tryDecodeBase64(configured);
const decodedText = decodedBytes?.toString("utf8");
if (
  decodedText?.startsWith("untrusted comment: minisign public key: ") ||
  decodedText?.startsWith("untrusted comment: minisign public key ")
) {
  process.stdout.write(
    decodedText.endsWith("\n") ? decodedText : `${decodedText}\n`,
  );
  process.exit(0);
}

// Some Tauri configurations store only the 42-byte public-key payload as
// Base64. Reconstruct the standard minisign comment and key-id in that case.
const payload = decodedBytes ?? Buffer.from(configured, "utf8");
if (payload.length !== 42) {
  throw new Error(
    "plugins.updater.pubkey is neither full minisign text nor a 42-byte Base64 public key",
  );
}

const algorithm = payload.subarray(0, 2).toString("ascii");
if (algorithm !== "Ed" && algorithm !== "ED") {
  throw new Error(`unsupported minisign algorithm: ${algorithm}`);
}

const keyId = payload.subarray(2, 10).toString("hex").toUpperCase();
process.stdout.write(
  `untrusted comment: minisign public key: ${keyId}\n${configured}\n`,
);

function tryDecodeBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}
