/**
 * Postinstall patch for @liamcottle/rustplus.js proto compatibility.
 *
 * Some servers omit fields that rustplus.proto marks as REQUIRED (proto2),
 * causing protobufjs decode crashes like:
 *   missing required 'queuedPlayers'
 *   missing required 'isOnline'
 *
 * This script makes those fields OPTIONAL in the installed rustplus.proto.
 */
const fs = require("fs");
const path = require("path");

function patchProto(protoPath) {
  if (!fs.existsSync(protoPath)) return false;
  let s = fs.readFileSync(protoPath, "utf8");
  let changed = false;

  // queuedPlayers (uint32) - make optional regardless of field number
  const reQueued = /required\s+uint32\s+queuedPlayers\s*=\s*\d+\s*;/g;
  if (reQueued.test(s)) {
    s = s.replace(reQueued, (m) => m.replace(/^required/, "optional"));
    changed = true;
  }

  // isOnline (bool) - make optional regardless of field number
  const reOnline = /required\s+bool\s+isOnline\s*=\s*\d+\s*;/g;
  if (reOnline.test(s)) {
    s = s.replace(reOnline, (m) => m.replace(/^required/, "optional"));
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(protoPath, s, "utf8");
    console.log(`[patch-rustplus] Patched required fields to optional in: ${protoPath}`);
    return true;
  }
  return false;
}

const protoPath = path.join(process.cwd(), "node_modules", "@liamcottle", "rustplus.js", "rustplus.proto");
const ok = patchProto(protoPath);

if (!ok) {
  console.warn("[patch-rustplus] No patch applied (proto not found or already compatible).");
}
