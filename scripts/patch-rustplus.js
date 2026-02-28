/**
 * Fix for Rustafied/modern servers where AppInfo.queuedPlayers may be omitted.
 * Old rustplus.proto marks queuedPlayers as required, causing protobuf decode crash:
 *   CustomError [ProtocolError]: missing required 'queuedPlayers'
 *
 * This postinstall patch changes queuedPlayers to OPTIONAL in the installed rustplus.proto.
 */
const fs = require("fs");
const path = require("path");

function patchFile(protoPath) {
  if (!fs.existsSync(protoPath)) return false;
  let s = fs.readFileSync(protoPath, "utf8");
  const re = /required\s+uint32\s+queuedPlayers\s*=\s*9\s*;/g;
  if (!re.test(s)) return false;
  s = s.replace(re, "optional uint32 queuedPlayers = 9;");
  fs.writeFileSync(protoPath, s, "utf8");
  console.log(`[patch-rustplus] Patched queuedPlayers to optional in: ${protoPath}`);
  return true;
}

const candidates = [
  path.join(process.cwd(), "node_modules", "@liamcottle", "rustplus.js", "rustplus.proto"),
];

let ok = false;
for (const p of candidates) {
  try { ok = patchFile(p) || ok; } catch (_) {}
}

if (!ok) {
  console.warn("[patch-rustplus] No patch applied (proto not found or already patched).");
}
