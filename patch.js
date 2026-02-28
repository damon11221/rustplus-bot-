/**
 * Postinstall patch for @liamcottle/rustplus.js proto compatibility.
 *
 * Rust servers often omit fields that rustplus.proto marks as REQUIRED (proto2),
 * causing protobufjs to crash with errors like:
 *   missing required 'spawnTime'
 *   missing required 'queuedPlayers'
 *   missing required 'isOnline'
 *
 * Fix: make ALL required fields in the proto optional.
 * This is safe — protobufjs simply uses defaults (0, false, "") for missing fields.
 */
const fs   = require('fs');
const path = require('path');

const protoPath = path.join(
  process.cwd(),
  'node_modules',
  '@liamcottle',
  'rustplus.js',
  'rustplus.proto'
);

if (!fs.existsSync(protoPath)) {
  console.warn('[patch-rustplus] Proto file not found at:', protoPath);
  console.warn('[patch-rustplus] Skipping patch — bot may crash on missing fields.');
  process.exit(0);
}

let proto = fs.readFileSync(protoPath, 'utf8');
const before = proto;

// Replace ALL "required" field declarations with "optional"
// This covers every field in every message — future-proof against new crashes
proto = proto.replace(/\brequired\b(\s+)/g, 'optional$1');

if (proto === before) {
  console.log('[patch-rustplus] Proto already patched or no required fields found — nothing to do.');
} else {
  fs.writeFileSync(protoPath, proto, 'utf8');
  const count = (before.match(/\brequired\b/g) || []).length;
  console.log(`[patch-rustplus] ✓ Patched ${count} required field(s) to optional in rustplus.proto`);
}
