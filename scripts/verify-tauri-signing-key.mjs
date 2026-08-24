import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Tauri writes updater signatures as one outer Base64 layer containing the
// normal minisign text. The key-id bytes inside a minisign signature are
// little-endian; minisign displays the ID in the reverse byte order.
const repoRoot = path.resolve(import.meta.dirname, "..");
const configPath = path.join(
  repoRoot,
  "app",
  "flowix-desktop",
  "tauri.conf.production.json",
);

if (process.env.FLOWIX_ALLOW_UNSIGNED === "1") {
  console.log("[signing] unsigned build allowed; updater key check skipped");
  process.exit(0);
}

if (
  !process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() &&
  !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()
) {
  throw new Error(
    "TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required.",
  );
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const configuredPubkey = config.plugins?.updater?.pubkey?.trim();
const configuredKeyId = extractPublicKeyId(configuredPubkey);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowix-tauri-signing-"));
const probePath = path.join(tempDir, "probe");
try {
  fs.writeFileSync(probePath, "flowix updater signing key probe\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    ["exec", "--", "tauri", "signer", "sign", probePath],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`Tauri signing-key probe failed${detail ? `: ${detail}` : "."}`);
  }

  const signatureText = fs.readFileSync(`${probePath}.sig`, "utf8").trim();
  const minisignText = Buffer.from(signatureText, "base64").toString("utf8");
  const signatureLines = minisignText.trim().split(/\r?\n/u);
  if (signatureLines.length < 2) {
    throw new Error("Tauri signing-key probe produced an invalid minisign signature.");
  }

  const signaturePayload = Buffer.from(signatureLines[1], "base64");
  if (signaturePayload.length < 10) {
    throw new Error("Tauri signing-key probe produced a truncated signature.");
  }
  const derivedKeyId = Buffer.from(signaturePayload.subarray(2, 10))
    .reverse()
    .toString("hex")
    .toUpperCase();

  if (derivedKeyId !== configuredKeyId) {
    throw new Error(
      `Updater key mismatch: private key derives ${derivedKeyId}, ` +
        `but tauri.conf.production.json configures ${configuredKeyId}.`,
    );
  }

  console.log(`[signing] verified updater key ${derivedKeyId}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function extractPublicKeyId(value) {
  if (!value) {
    throw new Error("plugins.updater.pubkey is missing from tauri.conf.production.json.");
  }

  const decoded = Buffer.from(value, "base64").toString("utf8");
  const match = decoded.match(/public key:?\s+([0-9A-F]{16})/iu);
  if (!match) {
    throw new Error("Could not read the updater public-key ID from tauri.conf.production.json.");
  }
  return match[1].toUpperCase();
}
