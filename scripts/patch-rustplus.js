/**
 * Railway build fix:
 * @liamcottle/rustplus.js v2.5.0 ships a rustplus.proto where AppInfo.queuedPlayers is REQUIRED.
 * Some servers (incl. Rustafied) may omit this field, causing:
 *   CustomError [ProtocolError]: missing required 'queuedPlayers'
 *
 * This script makes queuedPlayers OPTIONAL in the installed rustplus.proto during postinstall.
 * It does NOT change your bot logic; it only prevents protobuf decoding from crashing.
 */
const fs = require("fs");
const path = require("path");

function tryPatch(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let s = fs.readFileSync(filePath, "utf8");

  const before = /required\s+uint32\s+queuedPlayers\s*=\s*9\s*;/g;
  if (!before.test(s)) return false;

  s = s.replace(before, "optional uint32 queuedPlayers = 9;");
  fs.writeFileSync(filePath, s, "utf8");
  console.log(`[patch-rustplus] Patched queuedPlayers to optional in: ${filePath}`);
  return true;
}

const candidates = [
  path.join(process.cwd(), "node_modules", "@liamcottle", "rustplus.js", "rustplus.proto"),
  path.join(process.cwd(), "node_modules", "@liamcottle", "rustplus.js", "rustplus.proto"),
];

let ok = false;
for (const p of candidates) {
  try { ok = tryPatch(p) || ok; } catch (e) { /* ignore */ }
}

if (!ok) {
  console.warn("[patch-rustplus] No patch applied. rustplus.proto not found or already patched.");
}
