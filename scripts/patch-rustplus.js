/**
 * Postinstall patch for @liamcottle/rustplus.js proto compatibility.
 * Makes required fields optional when servers omit them.
 */
const fs = require("fs");
const path = require("path");

function patchProto(protoPath) {
  if (!fs.existsSync(protoPath)) return false;
  let s = fs.readFileSync(protoPath, "utf8");
  let changed = false;

  const patterns = [
    /required\s+uint32\s+queuedPlayers\s*=\s*\d+\s*;/g,
    /required\s+bool\s+isOnline\s*=\s*\d+\s*;/g,
  ];

  for (const re of patterns) {
    if (re.test(s)) {
      s = s.replace(re, (m) => m.replace(/^required/, "optional"));
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(protoPath, s, "utf8");
    console.log(`[patch-rustplus] Patched required fields to optional in: ${protoPath}`);
    return true;
  }
  return false;
}

const protoPath = path.join(process.cwd(), "node_modules", "@liamcottle", "rustplus.js", "rustplus.proto");
if (!patchProto(protoPath)) {
  console.warn("[patch-rustplus] No patch applied (proto not found or already compatible).");
}
