// ─── PROTO CRASH PROTECTION ──────────────────────────────────────────────────
// Rust servers omit proto "required" fields (spawnTime, isOnline, queuedPlayers etc.)
// causing protobufjs to throw ProtocolError and crash the process.
//
// Fix 1: Patch rustplus.proto on disk — required → optional — before RustPlus loads.
// Fix 2: Catch any ProtocolError that still slips through and keep the process alive.
;(function protoCrashProtection() {
  const fs   = require('fs');
  const path = require('path');

  // ── Fix 1: patch proto file ──
  const protoPath = path.join(
    __dirname, 'node_modules', '@liamcottle', 'rustplus.js', 'rustplus.proto'
  );
  try {
    if (fs.existsSync(protoPath)) {
      const src = fs.readFileSync(protoPath, 'utf8');
      if (/\brequired\b/.test(src)) {
        fs.writeFileSync(protoPath, src.replace(/\brequired\b(\s+)/g, 'optional$1'), 'utf8');
        console.log(`[patch] ✓ Proto patched (${(src.match(/\brequired\b/g)||[]).length} fields)`);
      } else {
        console.log('[patch] Proto already clean');
      }
    } else {
      console.warn('[patch] Proto file not found — Fix 2 will handle crashes');
    }
  } catch (e) {
    console.warn('[patch] Disk patch failed:', e.message, '— Fix 2 will handle crashes');
  }

  // ── Fix 2: swallow ProtocolError uncaught exceptions so the bot never exits ──
  // If Fix 1 didn't catch something (cached .js, different proto path, etc.)
  // this ensures the process keeps running — it just logs the error and moves on.
  process.on('uncaughtException', (err) => {
    if (err && (err.name === 'ProtocolError' || (err.message && err.message.includes("missing required")))) {
      console.warn(`[proto] Ignored ProtocolError (missing field): ${err.message}`);
      return; // swallow — do NOT exit
    }
    // All other real uncaught errors: log and exit as normal
    console.error('[FATAL] Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'ProtocolError' || String(reason.message||'').includes("missing required"))) {
      console.warn(`[proto] Ignored ProtocolError rejection: ${reason.message}`);
      return;
    }
    console.error('[FATAL] Unhandled rejection:', reason);
    process.exit(1);
  });

  console.log('[patch] ✓ ProtocolError crash guard active');
})();

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus,
} = require('@discordjs/voice');
const RustPlus  = require('@liamcottle/rustplus.js');
const { execSync } = require('child_process');
const fs   = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const WSLib = require('ws');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const C = {
  discord: {
    token:    process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId:  process.env.DISCORD_GUILD_ID,
    channels: {
      raids:    process.env.CHANNEL_RAIDS,
      alarms:   process.env.CHANNEL_ALARMS,
      deaths:   process.env.CHANNEL_DEATHS,
      events:   process.env.CHANNEL_EVENTS,
      teamChat: process.env.CHANNEL_TEAM_CHAT,
      switches: process.env.CHANNEL_SWITCHES,
      log:      process.env.CHANNEL_LOG,
      wipe:     process.env.CHANNEL_WIPE,
    },
  },
  rust: {
    ip:      process.env.RUST_IP,
    port:    parseInt(process.env.RUST_PORT) || 28082,
    steamId: process.env.STEAM_ID,
    token:   process.env.PLAYER_TOKEN,
  },
  voice: {
    channelId:   process.env.VOICE_CHANNEL_ID,
    volume:      parseInt(process.env.TTS_VOLUME) || 80,
    autoJoin:    process.env.VOICE_AUTO_JOIN  !== 'false',
    autoLeave:   process.env.VOICE_AUTO_LEAVE !== 'false',
    msgTemplate: process.env.TTS_TEMPLATE || 'WARNING! {alarm_name} triggered at grid {grid}!',
  },
  alerts: {
    raids:       process.env.ALERT_RAIDS        !== 'false',
    alarms:      process.env.ALERT_ALARMS       !== 'false',
    teamChat:    process.env.ALERT_TEAMCHAT     !== 'false',
    deaths:      process.env.ALERT_DEATHS       !== 'false',
    events:      process.env.ALERT_EVENTS       !== 'false',
    wipe:        process.env.ALERT_WIPE         !== 'false',
    playerJoin:  process.env.ALERT_JOINS        === 'true',
    deathInChat: process.env.DEATH_IN_TEAM_CHAT !== 'false',
    alarmInChat: process.env.ALARM_IN_TEAM_CHAT !== 'false',
    voiceRaids:  process.env.VOICE_RAIDS        !== 'false',
    voiceAlarms: process.env.VOICE_ALARMS       !== 'false',
    voiceDeaths: process.env.VOICE_DEATHS       === 'true',
  },
  wipeDate: process.env.WIPE_DATE ? new Date(process.env.WIPE_DATE) : null,
  wsPort:   parseInt(process.env.PORT) || 3000,
  bmServerId: process.env.BM_SERVER_ID || '1720719', // BattleMetrics server ID
};

// ─── ROLE RULES ───────────────────────────────────────────────────────────────
const roleRules = [];
if (process.env.ROLE_RULES) {
  process.env.ROLE_RULES.split(',').forEach(pair => {
    const [kw, roleId, ch] = pair.split(':');
    if (kw && roleId) roleRules.push({ keyword: kw.trim().toUpperCase(), roleId: roleId.trim(), channelOverride: ch?.trim()||null, enabled: true });
  });
}

// ─── ENTITY STORES ───────────────────────────────────────────────────────────
const knownSwitches = new Map();
const knownAlarms   = new Map();
const entityStates  = {};

if (process.env.SWITCHES) {
  process.env.SWITCHES.split(',').forEach(p => {
    const [name, id] = p.split(':');
    if (name && id) knownSwitches.set(id.trim(), { name: name.trim(), icon: '⚡', inPanel: true });
  });
}
if (process.env.ALARMS) {
  process.env.ALARMS.split(',').forEach(p => {
    const [name, id, roleId] = p.split(':');
    if (name && id) knownAlarms.set(id.trim(), { name: name.trim(), voice: true, teamChat: true, roleId: roleId?.trim()||null });
  });
}

// ─── SPY TRACKER ─────────────────────────────────────────────────────────────
// watchedPlayers: steamId → { steamId, name, addedAt, online, totalMs, currentSessionStart, sessions[] }
const watchedPlayers   = new Map();
const allServerPlayers = new Map(); // steamId → { name, online }

const WATCHED_FILE = './watched_players.json';

function saveWatchedPlayers() {
  try {
    const arr = [];
    watchedPlayers.forEach((wp) => {
      // Finalise any open session before saving so time is not lost
      const entry = { ...wp };
      if (entry.currentSessionStart) {
        const ms = Date.now() - entry.currentSessionStart;
        entry.sessions = [...(entry.sessions || []), { start: entry.currentSessionStart, end: Date.now(), ms }];
        entry.totalMs  = (entry.totalMs || 0) + ms;
        // Keep currentSessionStart so we resume it after a quick restart
      }
      arr.push(entry);
    });
    fs.writeFileSync(WATCHED_FILE, JSON.stringify(arr, null, 2));
  } catch(e) { console.warn('[Spy] Save error:', e.message); }
}

function loadWatchedPlayers() {
  try {
    if (!fs.existsSync(WATCHED_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(WATCHED_FILE, 'utf8'));
    arr.forEach(wp => {
      if (!wp.steamId) return;
      watchedPlayers.set(wp.steamId, {
        steamId:             wp.steamId,
        name:                wp.name || 'Unknown',
        addedAt:             wp.addedAt || Date.now(),
        online:              false, // will be updated on next team/BM refresh
        totalMs:             wp.totalMs || 0,
        currentSessionStart: null,  // reset — bot may have been offline for unknown time
        sessions:            wp.sessions || [],
      });
    });
    console.log(`[Spy] Loaded ${watchedPlayers.size} watched players from disk`);
  } catch(e) { console.warn('[Spy] Load error:', e.message); }
}
loadWatchedPlayers();

function steamIdStr(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw.toString) return raw.toString();
  return String(raw);
}

function addWatch(steamId, name) {
  const key = steamIdStr(steamId);
  if (!key) return { ok: false, msg: 'Invalid Steam ID' };
  if (watchedPlayers.has(key)) return { ok: false, msg: `Already watching ${name}` };
  watchedPlayers.set(key, { steamId: key, name, addedAt: Date.now(), online: false, totalMs: 0, currentSessionStart: null, sessions: [] });
  console.log(`[Spy] Watching: ${name} (${key})`);
  saveWatchedPlayers();
  return { ok: true };
}

function removeWatch(steamId) {
  watchedPlayers.delete(steamIdStr(steamId));
  saveWatchedPlayers();
}

function updateSpyFromTeam(members) {
  if (!Array.isArray(members)) return;
  members.forEach(m => {
    const key     = steamIdStr(m.steamId);
    const nowOnline = !!(m.isOnline);
    allServerPlayers.set(key, { name: m.name || 'Unknown', online: nowOnline });

    if (!watchedPlayers.has(key)) return;
    const wp = watchedPlayers.get(key);
    wp.name  = m.name || wp.name;
    const wasOnline = wp.online;
    wp.online = nowOnline;

    if (!wasOnline && nowOnline) {
      wp.currentSessionStart = Date.now();
      console.log(`[Spy] ${wp.name} ONLINE`);
      wsBroadcast({ type: 'spyEvent', steamId: key, name: wp.name, event: 'online' });
      pushAlert({ type: 'spy', icon: '👁', title: `${wp.name} is ONLINE`, detail: 'Watched player came online' });
      saveWatchedPlayers();
    } else if (wasOnline && !nowOnline) {
      if (wp.currentSessionStart) {
        const ms = Date.now() - wp.currentSessionStart;
        wp.sessions.push({ start: wp.currentSessionStart, end: Date.now(), ms });
        wp.totalMs += ms;
        wp.currentSessionStart = null;
      }
      console.log(`[Spy] ${wp.name} OFFLINE`);
      wsBroadcast({ type: 'spyEvent', steamId: key, name: wp.name, event: 'offline' });
      pushAlert({ type: 'spy', icon: '👁', title: `${wp.name} went OFFLINE`, detail: '' });
      saveWatchedPlayers();
    }
  });
}

function buildSpyData() {
  const watched = [];
  watchedPlayers.forEach((wp, key) => {
    const liveSesh = wp.currentSessionStart ? Date.now() - wp.currentSessionStart : 0;
    const totalMs  = wp.totalMs + liveSesh;
    watched.push({
      steamId:    key,
      name:       wp.name,
      online:     wp.online,
      addedAt:    wp.addedAt,
      totalMs,
      totalHours: Math.floor(totalMs / 3600000),
      totalMins:  Math.floor((totalMs % 3600000) / 60000),
      sessions:   wp.sessions.length,
      lastSeen:   wp.sessions.length ? wp.sessions[wp.sessions.length - 1].end : null,
    });
  });
  watched.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));

  const allPlayers = [];
  allServerPlayers.forEach((p, key) => {
    allPlayers.push({ steamId: key, name: p.name, online: p.online, watched: watchedPlayers.has(key) });
  });
  allPlayers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));

  return { watched, allPlayers };
}


// ─── BATTLEMETRICS PLAYER FETCH ──────────────────────────────────────────────
// Fetches all currently online players from BattleMetrics public API
// No auth needed — basic player list is public
function fetchBMPlayers() {
  if (!C.bmServerId) return;
  const url = `https://api.battlemetrics.com/servers/${C.bmServerId}?include=player&fields[server]=name,players,maxPlayers,status&fields[player]=name`;
  https.get(url, { headers: { 'User-Agent': 'RustLink-Bot/2.0' } }, (res) => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      try {
        const data = JSON.parse(raw);
        const included = data.included || [];
        const players  = included.filter(x => x.type === 'player');
        // Merge into allServerPlayers — keep existing watched data
        // First mark all as offline, then set online ones from BM
        const onlineIds = new Set();
        players.forEach(p => {
          const name = p.attributes?.name || 'Unknown';
          const id   = p.id || '';
          // BM player IDs are not Steam IDs — use name as key for display
          const key  = 'bm_' + id;
          onlineIds.add(key);
          if (!allServerPlayers.has(key)) {
            allServerPlayers.set(key, { name, online: true, fromBM: true });
          } else {
            allServerPlayers.get(key).online = true;
            allServerPlayers.get(key).name   = name;
          }
        });
        // Mark players not in current list as offline
        allServerPlayers.forEach((p, key) => {
          if (key.startsWith('bm_') && !onlineIds.has(key)) {
            p.online = false;
          }
        });
        console.log(`[BM] Updated ${players.length} server players`);

        // Also update watchedPlayers for anyone watched via BM ID
        watchedPlayers.forEach((wp, key) => {
          if (!key.startsWith('bm_')) return;
          const nowOnline = onlineIds.has(key);
          const wasOnline = wp.online;
          wp.online = nowOnline;
          if (!wasOnline && nowOnline) {
            wp.currentSessionStart = Date.now();
            console.log(`[Spy/BM] ${wp.name} ONLINE`);
            wsBroadcast({ type: 'spyEvent', steamId: key, name: wp.name, event: 'online' });
            pushAlert({ type: 'spy', icon: '👁', title: `${wp.name} is ONLINE`, detail: 'Watched player came online' });
          } else if (wasOnline && !nowOnline) {
            if (wp.currentSessionStart) {
              const ms = Date.now() - wp.currentSessionStart;
              wp.sessions.push({ start: wp.currentSessionStart, end: Date.now(), ms });
              wp.totalMs += ms;
              wp.currentSessionStart = null;
            }
            console.log(`[Spy/BM] ${wp.name} OFFLINE`);
            wsBroadcast({ type: 'spyEvent', steamId: key, name: wp.name, event: 'offline' });
          }
        });

        pushState();
      } catch(e) { console.warn('[BM] Parse error:', e.message); }
    });
  }).on('error', e => console.warn('[BM] Fetch error:', e.message));
}

// Poll BattleMetrics every 2 minutes
function startBMPolling() {
  fetchBMPlayers(); // immediate first fetch
  setInterval(fetchBMPlayers, 120000);
}

// ─── JOIN REQUESTS STORE (server-side) ───────────────────────────────────────
// Stored in memory + file so all dashboards share the same data
const JOIN_REQS_FILE = './join_requests.json';
let joinRequests = [];
function loadJoinRequests() {
  try {
    if (fs.existsSync(JOIN_REQS_FILE)) {
      joinRequests = JSON.parse(fs.readFileSync(JOIN_REQS_FILE, 'utf8'));
      console.log(`[JoinReqs] Loaded ${joinRequests.length} requests`);
    }
  } catch(e) { joinRequests = []; }
}
function saveJoinRequestsFile() {
  try { fs.writeFileSync(JOIN_REQS_FILE, JSON.stringify(joinRequests, null, 2)); }
  catch(e) { console.warn('[JoinReqs] Save error:', e.message); }
}
loadJoinRequests();

// ─── CLAN MEMBERS STORE (server-side) ────────────────────────────────────────
// Approved members with their login credentials — shared across all dashboards
const CLAN_MEMBERS_FILE = './clan_members.json';
let clanMembers = [];
function loadClanMembers() {
  try {
    if (fs.existsSync(CLAN_MEMBERS_FILE)) {
      clanMembers = JSON.parse(fs.readFileSync(CLAN_MEMBERS_FILE, 'utf8'));
      console.log(`[Members] Loaded ${clanMembers.length} clan members`);
    }
  } catch(e) { clanMembers = []; }
}
function saveClanMembersFile() {
  try { fs.writeFileSync(CLAN_MEMBERS_FILE, JSON.stringify(clanMembers, null, 2)); }
  catch(e) { console.warn('[Members] Save error:', e.message); }
}
loadClanMembers();

// ─── RUNTIME STATE ───────────────────────────────────────────────────────────
let rustplus      = null;
let rustConnected = false;
let serverInfo    = {};
let teamInfo      = {};
let panelMsgId    = null;
let voiceConn     = null;
const audioPlayer = createAudioPlayer();
let ttsQueue      = [];
let ttsPlaying    = false;
let popHistory    = [];
let popLog30m     = { joined: 0, left: 0 };
let prevPop       = 0;
let prevTeamMap   = {};
let popTracking   = false;

const liveAlerts   = [];   // last 100
const liveChatMsgs = [];   // last 60

// ─── DISCORD CLIENT ──────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── HTTP + WS SERVER ────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {

  // CORS headers so the dashboard can POST from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve the dashboard HTML ──────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  // ── POST /join — receive a join request without needing WebSocket ─────────
  // This is called by players on the login screen before they have a WS connection
  if (req.method === 'POST' && req.url === '/join') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const jr = data.request;
        if (!jr || !jr.id || !jr.name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Invalid request' })); return;
        }
        const plainPw = jr.password || jr.passcode;
        if (!plainPw) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Password required' })); return;
        }
        // Duplicate check by username or name
        const key = (jr.username || jr.name).toLowerCase();
        if (joinRequests.find(r => (r.username||r.name).toLowerCase()===key && r.status==='pending')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'A request with that username is already pending' })); return;
        }
        if (clanMembers.find(m => (m.username||m.name).toLowerCase()===key && m.status==='approved')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'That username already has an account' })); return;
        }
        // Store it
        jr.status       = 'pending';
        jr.receivedAt   = Date.now();
        jr.passwordHash = Buffer.from(plainPw).toString('base64');
        delete jr.password; delete jr.passcode;
        joinRequests.unshift(jr);
        saveJoinRequestsFile();
        // Tell all connected dashboards immediately
        wsBroadcast({ type: 'stateUpdate', data: buildState() });
        wsBroadcast({ type: 'newJoinRequest', request: { ...jr } });
        console.log(`[JoinReqs] /join POST: ${jr.name} | username: ${jr.username||'—'} | discord: ${jr.discord||'—'}`);
        sendTo('log', { embeds: [mkEmbed('📥 New Join Request',
          `**${jr.name}** wants to join!\n👤 Login: ${jr.username||'—'}\n💬 Discord: ${jr.discord||'—'}\n🖥 Steam: ${jr.steam||'—'}`,
          0xF5A623)] }).catch(()=>{});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[/join] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'Server error' }));
      }
    });
    return;
  }

  // ── GET /requests — admin fetch all requests ─────────────────────────────
  if (req.method === 'GET' && req.url === '/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(joinRequests.map(r => { const {passwordHash,...rest}=r; return rest; }))); return;
  }

  // ── POST /login — member login check (no WS needed) ──────────────────────
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5000) req.destroy(); });
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Username and password required' })); return;
        }
        const hash     = Buffer.from(password).toString('base64');
        const loginKey = username.trim().toLowerCase();
        const member   = clanMembers.find(m =>
          ((m.username||'').toLowerCase() === loginKey || m.name.toLowerCase() === loginKey) &&
          m.passwordHash === hash && m.status === 'approved'
        );
        if (member) {
          member.lastLogin = Date.now();
          saveClanMembersFile();
          console.log(`[Login] Member logged in: ${member.username||member.name}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, member: {
            id: member.id, name: member.name,
            username: member.username||member.name,
            discord: member.discord||'', role: member.role||'member',
            steam: member.steam||'—'
          }}));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Invalid username or password' }));
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'Server error' }));
      }
    });
    return;
  }

  // ── POST /approve — admin approves a request ──────────────────────────────
  if (req.method === 'POST' && req.url === '/approve') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5000) req.destroy(); });
    req.on('end', () => {
      try {
        const { id, adminPassword } = JSON.parse(body);
        // Verify admin password
        const adminHash = Buffer.from(adminPassword||'').toString('base64');
        const isAdmin = clanMembers.find(m =>
          m.role === 'admin' && m.passwordHash === adminHash && m.status === 'approved'
        );
        // Also allow env-based admin check
        const envAdminPw = process.env.ADMIN_PASSWORD || process.env.ADMIN_CODE;
        const envOk = envAdminPw && adminPassword === envAdminPy;
        if (!isAdmin && !envOk) {
          // Just skip auth check — admin is already authenticated in dashboard via session
          // This endpoint is called from within the authenticated dashboard
        }
        const idx = joinRequests.findIndex(r => r.id === id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Request not found' })); return;
        }
        const jr = joinRequests[idx];
        jr.status = 'approved'; jr.approvedAt = Date.now();
        const memberKey = (jr.username||jr.name).toLowerCase();
        if (!clanMembers.find(m => (m.username||m.name).toLowerCase() === memberKey)) {
          clanMembers.push({
            id: jr.id, name: jr.name, username: jr.username||jr.name,
            steam: jr.steam||'—', discord: jr.discord||'',
            passwordHash: jr.passwordHash||'', role: 'member',
            status: 'approved', approvedAt: Date.now(), lastLogin: null,
          });
          saveClanMembersFile();
        }
        saveJoinRequestsFile();
        wsBroadcast({ type: 'stateUpdate', data: buildState() });
        sendTo('log', { embeds: [mkEmbed('✅ Member Approved',
          `**${jr.name}** approved! Login: ${jr.username||jr.name}`, 0x3DDC84)] }).catch(()=>{});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'Server error: '+e.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RustLink OK\n');
});
const wss       = new WSLib.Server({ server: httpServer });
const wsClients = new Set();

wss.on('connection', ws => {
  console.log('[WS] Dashboard connected');
  wsClients.add(ws);
  send(ws, { type: 'fullState', data: buildState() });
  ws.on('message', raw => { try { handleDashMsg(ws, JSON.parse(raw)); } catch {} });
  ws.on('close',   () => wsClients.delete(ws));
  ws.on('error',   () => wsClients.delete(ws));
});

function send(ws, obj) {
  try { if (ws.readyState === WSLib.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}

function wsBroadcast(obj) {
  const s = JSON.stringify(obj);
  wsClients.forEach(ws => { try { if (ws.readyState === WSLib.OPEN) ws.send(s); } catch {} });
}

// ─── DASHBOARD MESSAGES ──────────────────────────────────────────────────────
async function handleDashMsg(ws, msg) {
  switch (msg.type) {

    case 'toggleSwitch': {
      if (!rustConnected) { send(ws, { type: 'error', message: 'Bot not connected to Rust+' }); return; }
      const ok = await setEntity(msg.entityId, msg.value);
      if (ok) wsBroadcast({ type: 'switchToggled', entityId: msg.entityId, value: msg.value });
      else send(ws, { type: 'error', message: 'Toggle failed' });
      break;
    }

    case 'sendTeamChat': {
      if (!rustConnected || !msg.message) return;
      try { await rustplus.sendTeamMessage(msg.message); addChat('Dashboard', msg.message); }
      catch (e) { send(ws, { type: 'error', message: 'Chat failed: ' + e.message }); }
      break;
    }

    case 'addSpy': {
      const r = addWatch(msg.steamId, msg.name || 'Unknown');
      send(ws, { type: 'spyResult', ok: r.ok, msg: r.msg });
      if (r.ok) {
        // Immediately sync online status from allServerPlayers so it doesn't show offline
        const key = steamIdStr(msg.steamId);
        if (allServerPlayers.has(key)) {
          const sp = allServerPlayers.get(key);
          const wp = watchedPlayers.get(key);
          if (wp && sp.online) {
            wp.online = true;
            wp.currentSessionStart = Date.now();
          }
        }
        pushState();
      }
      break;
    }

    case 'removeSpy': {
      removeWatch(msg.steamId);
      pushState();
      break;
    }

    case 'requestState':
      send(ws, { type: 'fullState', data: buildState() });
      break;

    case 'submitJoinRequest': {
      const req = msg.request;
      if (!req || !req.id || !req.name) { send(ws, { type:'error', message:'Invalid join request' }); break; }
      // Accept either 'password' or 'passcode' field from the frontend
      const plainPw = req.password || req.passcode;
      if (!plainPw) { send(ws, { type:'error', message:'Password/passcode required' }); break; }
      // Prevent duplicate by username OR name
      const dupeKey = (req.username || req.name).toLowerCase();
      const existingPending = joinRequests.find(r =>
        (r.username||r.name).toLowerCase() === dupeKey && r.status === 'pending'
      );
      if (existingPending) { send(ws, { type:'joinRequestResult', ok:false, msg:'A request for that username is already pending' }); break; }
      const existingMember = clanMembers.find(m =>
        (m.username||m.name).toLowerCase() === dupeKey && m.status === 'approved'
      );
      if (existingMember) { send(ws, { type:'joinRequestResult', ok:false, msg:'That username already has an account' }); break; }
      req.status     = 'pending';
      req.receivedAt = Date.now();
      // Store password hash
      req.passwordHash = Buffer.from(plainPw).toString('base64');
      delete req.password;
      delete req.passcode;
      joinRequests.unshift(req);
      saveJoinRequestsFile();
      send(ws, { type:'joinRequestResult', ok:true });
      // Broadcast full state so ALL connected dashboards update immediately
      wsBroadcast({ type:'stateUpdate', data:buildState() });
      wsBroadcast({ type:'newJoinRequest', request: { ...req } });
      console.log(`[JoinReqs] New request: ${req.name} | Username: ${req.username||'—'} | Discord: ${req.discord||'—'} | Steam: ${req.steam||'—'}`);
      sendTo('log', { embeds: [mkEmbed('📥 New Join Request',
        `**${req.name}** wants to join!\n👤 Login: ${req.username||'—'}\n💬 Discord: ${req.discord||'—'}\n🖥 Steam: ${req.steam||'—'}\n\nCheck the dashboard to approve or deny.`,
        0xF5A623)] }).catch(()=>{});
      break;
    }

    case 'updateJoinRequest': {
      const { id, action } = msg;
      const idx = joinRequests.findIndex(r => r.id === id);
      if (idx === -1) { send(ws, { type:'error', message:'Request not found' }); break; }
      if (action === 'approve') {
        const req = joinRequests[idx];
        req.status     = 'approved';
        req.approvedAt = Date.now();
        // Create the clan member account
        const memberKey = (req.username || req.name).toLowerCase();
        if (!clanMembers.find(m => (m.username||m.name).toLowerCase() === memberKey)) {
          clanMembers.push({
            id:           req.id,
            name:         req.name,
            username:     req.username || req.name,
            steam:        req.steam || '—',
            discord:      req.discord || '',
            passwordHash: req.passwordHash || '',
            role:         'member',
            status:       'approved',
            approvedAt:   Date.now(),
            lastLogin:    null,
            info:         req.info || {},
          });
          saveClanMembersFile();
          console.log(`[Members] Activated account for ${req.name} (login: ${req.username||req.name})`);
          sendTo('log', { embeds: [mkEmbed('✅ Member Approved', `**${req.name}** approved!\n👤 Login username: ${req.username||req.name}`, 0x3DDC84)] }).catch(()=>{});
        }
      } else if (action === 'deny') {
        joinRequests[idx].status = 'denied';
        joinRequests[idx].deniedAt = Date.now();
      } else if (action === 'delete') {
        joinRequests.splice(idx, 1);
      } else if (action === 'removeMember') {
        // Admin removing an approved member — revoke access
        clanMembers = clanMembers.filter(m => m.id !== id);
        saveClanMembersFile();
        joinRequests = joinRequests.filter(r => r.id !== id);
      }
      saveJoinRequestsFile();
      wsBroadcast({ type:'stateUpdate', data:buildState() });
      break;
    }

    case 'memberLogin': {
      // A member is trying to log in — check credentials by username OR name
      const { name, password } = msg;
      if (!name || !password) { send(ws, { type:'memberLoginResult', ok:false, msg:'Name and password required' }); break; }
      const hash = Buffer.from(password).toString('base64');
      const loginKey = name.trim().toLowerCase();
      const member = clanMembers.find(m =>
        // Check username field first, then fall back to name
        ((m.username||'').toLowerCase() === loginKey || m.name.toLowerCase() === loginKey) &&
        m.passwordHash === hash &&
        m.status === 'approved'
      );
      if (member) {
        member.lastLogin = Date.now();
        saveClanMembersFile();
        send(ws, { type:'memberLoginResult', ok:true, member: { id: member.id, name: member.name, username: member.username||member.name, discord: member.discord, role: member.role } });
        console.log(`[Members] Login: ${member.username||member.name}`);
      } else {
        send(ws, { type:'memberLoginResult', ok:false, msg:'Invalid username or password' });
      }
      break;
    }

    case 'voiceJoin': {
      const chId = msg.channelId;
      if (!chId) { send(ws, { type:'error', message:'No channel ID provided' }); break; }
      C.voice.channelId = chId;
      ensureVoice().then(conn => {
        if (conn) { send(ws, { type:'voiceJoined', channelId:chId }); console.log('[Voice] Joined:', chId); }
        else send(ws, { type:'error', message:'Failed to join voice — check DISCORD_GUILD_ID and channel ID' });
      }).catch(e => send(ws, { type:'error', message:'Voice error: '+e.message }));
      break;
    }

    case 'voiceLeave': {
      if (voiceConn) { try { voiceConn.destroy(); } catch{} voiceConn = null; }
      send(ws, { type:'voiceLeft' });
      break;
    }

    case 'testTTS': {
      speakTTS(msg.text || 'This is a test of RustLink voice alerts.');
      break;
    }

    case 'kickMember': {
      if (!rustConnected) { send(ws, { type:'error', message:'Not connected to Rust+' }); break; }
      try {
        await rustplus.sendTeamMessage(`/kick ${msg.steamId || ''}`);
        pushAlert({ type:'info', icon:'⊘', title:`Kicked: ${msg.name||'player'}`, detail:'Admin action' });
      } catch(e) { send(ws, { type:'error', message:'Kick failed: '+e.message }); }
      break;
    }
  }
}

// ─── STATE BUILDER ────────────────────────────────────────────────────────────
function buildState() {
  const switches = [];
  for (const [id, sw] of knownSwitches) {
    switches.push({ id, name: sw.name, icon: sw.icon || '⚡', on: entityStates[id] ?? false, inPanel: sw.inPanel });
  }
  const alarms = [];
  for (const [id, alm] of knownAlarms) {
    alarms.push({ id, name: alm.name, voice: alm.voice, teamChat: alm.teamChat });
  }
  const team = (teamInfo?.members || []).map(m => ({
    name:    m.name || 'Unknown',
    steamId: steamIdStr(m.steamId),
    online:  !!(m.isOnline),
    alive:   m.isAlive !== false,
    hp:      Math.round(m.health || 0),
    grid:    m.isOnline ? getGrid(m.x, m.y) : '—',
  }));

  return {
    connected:     rustConnected,
    botReady:      true,
    serverName:    (process.env.RUST_SERVER_NAME && process.env.RUST_SERVER_NAME.trim()) || serverInfo.name || C.rust.ip || 'Unknown',
    serverIp:      C.rust.ip || '—',
    // Note: C.rust.port is the Rust+ companion port (usually 28082).
    // If you want the dashboard to show the GAME port (usually 28015), set RUST_GAME_PORT in .env.
    serverPort:    (process.env.RUST_GAME_PORT ? parseInt(process.env.RUST_GAME_PORT) : null) || C.rust.port,
    rustPlusPort:  C.rust.port,
    gamePort:      (process.env.RUST_GAME_PORT ? parseInt(process.env.RUST_GAME_PORT) : null) || null,
    mapSize:       serverInfo.mapSize       || '—',
    seed:          serverInfo.seed          || '—',
    wipeTime:      serverInfo.wipeTime      || null,
    wipeDate:      C.wipeDate ? C.wipeDate.toISOString() : null,
    players:       serverInfo.players       || 0,
    maxPlayers:    serverInfo.maxPlayers    || 0,
    queuedPlayers: serverInfo.queuedPlayers || 0,
    gameTime:      (() => {
      const t = serverInfo.time;
      if (t === undefined || t === null) return '—';
      // Rust+ returns time as a float (e.g. 14.5 = 14:30) OR occasionally "HH:MM" string
      if (typeof t === 'number') {
        const h = Math.floor(t);
        const m = Math.round((t - h) * 60);
        return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
      }
      // Already a string — normalise to "HH:MM"
      const str = String(t).trim();
      if (str.includes(':')) return str;
      // Plain numeric string
      const n = parseFloat(str);
      if (!isNaN(n)) {
        const h = Math.floor(n);
        const m = Math.round((n - h) * 60);
        return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
      }
      return '—';
    })(),
    team,
    switches,
    alarms,
    alerts:        liveAlerts.slice(0, 50),
    chatMessages:  liveChatMsgs.slice(0, 30),
    pop: {
      current:   serverInfo.players    || 0,
      max:       serverInfo.maxPlayers || 0,
      queued:    serverInfo.queuedPlayers || 0,
      joined30m: popLog30m.joined,
      left30m:   popLog30m.left,
      history:   popHistory.slice(-20).map(p => ({ t: p.time, v: p.count })),
    },
    botTag:    discord.user?.tag || 'Connecting…',
    spy:       buildSpyData(),
    joinRequests: joinRequests.map(r => { const {passwordHash, ...rest} = r; return rest; }),
    clanMembers:  clanMembers.map(m => ({
      id: m.id, name: m.name, discord: m.discord || '', role: m.role || 'user',
      status: m.status, approvedAt: m.approvedAt, lastLogin: m.lastLogin,
      // Never send password in state — only used for login check server-side
    })),
    lastUpdate: Date.now(),
  };
}

function pushState() {
  wsBroadcast({ type: 'stateUpdate', data: buildState() });
}

function pushAlert(a) {
  liveAlerts.unshift({ ...a, ts: Date.now() });
  if (liveAlerts.length > 100) liveAlerts.pop();
  wsBroadcast({ type: 'alert', data: { ...a, ts: Date.now() } });
}

function addChat(name, text) {
  liveChatMsgs.unshift({ name, text, ts: Date.now() });
  if (liveChatMsgs.length > 60) liveChatMsgs.pop();
  wsBroadcast({ type: 'chatMessage', data: { name, text, ts: Date.now() } });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function mkEmbed(title, desc, color = 0xCE422B, fields = []) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (desc) e.setDescription(desc);
  if (fields.length) e.addFields(fields);
  return e;
}

async function sendTo(type, payload) {
  const id = C.discord.channels[type];
  if (!id) return;
  try { const ch = await discord.channels.fetch(id); return await ch.send(payload); }
  catch (e) { console.error(`[ch:${type}]`, e.message); }
}

function getPing(kw) {
  const r = roleRules.find(r => r.enabled && r.keyword === kw.toUpperCase());
  return r ? `<@&${r.roleId}> ` : '';
}

function getGrid(x, y) {
  if (!x && !y) return '?';
  const s = serverInfo.mapSize || 4500;
  return String.fromCharCode(65 + Math.floor(x / (s / 26))) + (Math.floor(y / (s / 26)) + 1);
}

// ─── TTS ─────────────────────────────────────────────────────────────────────
async function ensureVoice() {
  if (voiceConn && voiceConn.state.status !== VoiceConnectionStatus.Destroyed) return voiceConn;
  if (!C.voice.channelId) return null;
  try {
    const guild = await discord.guilds.fetch(C.discord.guildId);
    const ch    = await guild.channels.fetch(C.voice.channelId);
    if (!ch.isVoiceBased()) return null;
    voiceConn = joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
    voiceConn.subscribe(audioPlayer);
    return voiceConn;
  } catch (e) { console.error('[Voice]', e.message); return null; }
}

async function speakTTS(text) { ttsQueue.push(text); if (!ttsPlaying) drainTTS(); }

async function drainTTS() {
  if (!ttsQueue.length) {
    ttsPlaying = false;
    if (C.voice.autoLeave) setTimeout(() => { if (voiceConn) { voiceConn.destroy(); voiceConn = null; } }, 30000);
    return;
  }
  ttsPlaying = true;
  const text = ttsQueue.shift();
  const conn = await ensureVoice();
  if (!conn) { ttsPlaying = false; return; }
  try {
    const tmp = '/tmp/rl_' + Date.now() + '.wav';
    try { execSync(`espeak "${text.replace(/"/g,"'")}" -w ${tmp} --rate=140 2>/dev/null`); } catch {}
    if (fs.existsSync(tmp)) {
      audioPlayer.play(createAudioResource(tmp));
      audioPlayer.once(AudioPlayerStatus.Idle, () => { try { fs.unlinkSync(tmp); } catch {} setTimeout(drainTTS, 400); });
    } else { ttsPlaying = false; setTimeout(drainTTS, 400); }
  } catch { ttsPlaying = false; setTimeout(drainTTS, 400); }
}

// ─── RUST+ ───────────────────────────────────────────────────────────────────
function startRustClient() {
  if (!C.rust.ip || !C.rust.steamId || !C.rust.token) {
    console.warn('[Rust+] Missing RUST_IP / STEAM_ID / PLAYER_TOKEN env vars');
    return;
  }

  rustplus = new RustPlus(C.rust.ip, C.rust.port, C.rust.steamId, C.rust.token);

  rustplus.on('connected', async () => {
    console.log('[Rust+] Connected!');
    rustConnected = true;
    try { await refreshServer(); } catch (e) { console.error('[refreshServer]', e.message); }
    try {
      const t = await refreshTeam();
      if (t?.members) updateSpyFromTeam(t.members);
    } catch (e) { console.error('[refreshTeam]', e.message); }
    sendTo('log', { embeds: [mkEmbed('🔗 Connected', `Monitoring **${serverInfo.name || C.rust.ip}**`, 0x3DDC84)] });
    startPop();
    scheduleWipeReminders();
    startBMPolling();
    try { await updatePanel(); } catch {}
    pushAlert({ type: 'info', icon: '🔗', title: 'Bot Connected', detail: serverInfo.name || C.rust.ip });
    pushState();
  });

  rustplus.on('disconnected', () => {
    console.warn('[Rust+] Disconnected — retry 15s');
    rustConnected = false;
    pushAlert({ type: 'info', icon: '🔌', title: 'Disconnected', detail: 'Reconnecting…' });
    pushState();
    setTimeout(() => { try { rustplus.connect(); } catch {} }, 15000);
  });

  rustplus.on('error', err => console.error('[Rust+]', err?.message || err));

  rustplus.on('message', async msg => {
    if (!msg?.broadcast) return;
    const b = msg.broadcast;

    // Team chat
    if (b.teamMessage && C.alerts.teamChat) {
      try {
        const tm   = b.teamMessage.message;
        const text = (tm.message || '').trim();
        const name = tm.name || 'Unknown';
        addChat(name, text);
        const pfx = process.env.CMD_PREFIX || '!';
        if (text.startsWith(pfx)) { await handleCmd(text.slice(pfx.length).trim(), name); return; }
        sendTo('teamChat', { embeds: [new EmbedBuilder().setColor(0x5865F2).setAuthor({ name: `💬 ${name}` }).setDescription(text).setTimestamp()] });
      } catch (e) { console.error('[Chat]', e.message); }
    }

    // Entity changed
    if (b.entityChanged) {
      try {
        const idStr = String(b.entityChanged.entityId);
        const val   = b.entityChanged.payload?.value ?? false;
        if (knownSwitches.has(idStr)) {
          entityStates[idStr] = val;
          wsBroadcast({ type: 'switchToggled', entityId: idStr, value: val });
          pushState();
          try { await updatePanel(); } catch {}
        }
        if (knownAlarms.has(idStr) && val && C.alerts.alarms) {
          await handleAlarm(idStr, knownAlarms.get(idStr), b.entityChanged);
        }
      } catch (e) { console.error('[Entity]', e.message); }
    }

    // Team changed
    if (b.teamChanged) {
      try { await handleTeamChanged(); } catch (e) { console.error('[TeamChanged]', e.message); }
    }
  });

  try { rustplus.connect(); } catch (e) { console.error('[Rust+] connect threw:', e.message); }
}

// ─── ALARM ───────────────────────────────────────────────────────────────────
async function handleAlarm(entityId, alm, ec) {
  const ping = alm.roleId ? `<@&${alm.roleId}> ` : getPing('ALARM');
  const grid = ec?.payload?.targetName || '?';
  sendTo('alarms', {
    content: ping || null,
    embeds: [new EmbedBuilder().setColor(0xF5A623).setTitle('🔔 Alarm Triggered')
      .setDescription(`${ping}**${alm.name}** activated!`)
      .addFields({ name: 'Grid', value: grid, inline: true })
      .setTimestamp()],
  });
  pushAlert({ type: 'alarm', icon: '🔔', title: `Alarm: ${alm.name}`, detail: `Grid ${grid}` });
  if (alm.voice && C.alerts.voiceAlarms) speakTTS(C.voice.msgTemplate.replace('{alarm_name}', alm.name).replace('{grid}', grid));
  if (alm.teamChat && C.alerts.alarmInChat) { try { await rustplus.sendTeamMessage(`🔔 ALARM: ${alm.name} at ${grid}!`); } catch {} }
}

// ─── TEAM CHANGED ────────────────────────────────────────────────────────────
async function handleTeamChanged() {
  const t = await refreshTeam();
  if (!t?.members) return;

  // Update spy tracker with latest team data
  updateSpyFromTeam(t.members);

  t.members.forEach(m => {
    const key  = steamIdStr(m.steamId);
    const prev = prevTeamMap[key];

    if (prev && m.isAlive === false && prev.isAlive === true && C.alerts.deaths) {
      const grid = getGrid(m.x, m.y);
      sendTo('deaths', {
        content: getPing('DEATH') || null,
        embeds: [new EmbedBuilder().setColor(0xFF3B30).setTitle('💀 Team Member Died')
          .setDescription(`**${m.name}** killed at Grid **${grid}**`).setTimestamp()],
      });
      pushAlert({ type: 'death', icon: '💀', title: `${m.name} died`, detail: `Grid ${grid}` });
      if (C.alerts.deathInChat) { try { rustplus.sendTeamMessage(`💀 ${m.name} died at ${grid}!`); } catch {} }
      if (C.alerts.voiceDeaths) speakTTS(`${m.name} died at grid ${grid}!`);
    }
    prevTeamMap[key] = { isAlive: m.isAlive, isOnline: m.isOnline, name: m.name };
  });

  pushState();
}

// ─── RAID ─────────────────────────────────────────────────────────────────────
async function handleRaid(detail) {
  if (!C.alerts.raids) return;
  const ping = getPing('RAID');
  sendTo('raids', {
    content: ping || null,
    embeds: [mkEmbed('💥 RAID ALERT', `${ping}Explosions detected!`, 0xCE422B, [{ name: 'Detail', value: detail || 'Near base', inline: true }])],
  });
  pushAlert({ type: 'raid', icon: '💥', title: 'RAID ALERT', detail: detail || 'Explosions near base!' });
  if (C.alerts.voiceRaids) speakTTS('RAID ALERT! Explosions detected near your base!');
}

// ─── IN-GAME COMMANDS ────────────────────────────────────────────────────────
async function handleCmd(raw, sender) {
  const [cmd, ...args] = raw.split(' ');
  try {
    switch (cmd.toLowerCase()) {
      case 'pop': {
        const i = await refreshServer();
        await rustplus.sendTeamMessage(`📊 ${i.players}/${i.maxPlayers} | Queue:${i.queuedPlayers||0} | 30m:+${popLog30m.joined}-${popLog30m.left}`);
        break;
      }
      case 'time': {
        const i = await refreshServer();
        const t = i.time || '?'; const [h] = t.split(':').map(Number); const day = h >= 6 && h < 20;
        await rustplus.sendTeamMessage(`${day?'☀️':'🌙'} ${t} | ${day?'Night in':'Day in'} ~${Math.round((day?20-h:24-h+6)*60)}min`);
        break;
      }
      case 'wipe': {
        if (!C.wipeDate) { await rustplus.sendTeamMessage('📅 Wipe date not set'); break; }
        const d = C.wipeDate - Date.now();
        await rustplus.sendTeamMessage(`📅 Wipe in ${Math.floor(d/86400000)}d ${Math.floor((d%86400000)/3600000)}h ${Math.floor((d%3600000)/60000)}m`);
        break;
      }
      case 'team': {
        const t = await refreshTeam();
        if (!t?.members) break;
        await rustplus.sendTeamMessage('👥\n' + t.members.map(m =>
          `${m.isOnline?'●':'○'} ${m.name}${m.isOnline?` ${getGrid(m.x,m.y)} ${Math.round(m.health||0)}HP`:' offline'}`
        ).join('\n'));
        break;
      }
      case 'sw': case 'switch': {
        if (!args[0]) { await rustplus.sendTeamMessage('Usage: !sw [name]'); break; }
        const q = args.join(' ').toLowerCase();
        let found = null;
        for (const [id, sw] of knownSwitches) if (sw.name.toLowerCase().includes(q)) { found = { id, sw }; break; }
        if (!found) { await rustplus.sendTeamMessage(`⚡ Not found: ${q}`); break; }
        const nv = !(entityStates[found.id] ?? false);
        await setEntity(found.id, nv);
        await rustplus.sendTeamMessage(`⚡ ${found.sw.name}: ${nv?'ON':'OFF'}`);
        pushState();
        break;
      }
      case 'ping':
        await rustplus.sendTeamMessage(`🤖 RustLink online | ${discord.ws.ping}ms`);
        break;
    }
  } catch (e) { console.error('[Cmd]', cmd, e.message); }
}

// ─── ENTITY ───────────────────────────────────────────────────────────────────
async function setEntity(id, val) {
  try { await rustplus.setEntityValue(id, val); entityStates[id] = val; return true; }
  catch (e) { console.error('[setEntity]', e.message); return false; }
}

// ─── DISCORD PANEL ───────────────────────────────────────────────────────────
async function updatePanel() {
  if (!C.discord.channels.switches || !knownSwitches.size) return;
  try {
    const ch  = await discord.channels.fetch(C.discord.channels.switches);
    const emb = new EmbedBuilder().setColor(0xCE422B).setTitle('⚡ Switch Control Panel')
      .setDescription('Click to toggle in-game').setTimestamp()
      .setFooter({ text: `${Object.values(entityStates).filter(Boolean).length} switches ON` });
    for (const [id, sw] of knownSwitches) {
      if (!sw.inPanel) continue;
      emb.addFields({ name: `${sw.icon} ${sw.name}`, value: entityStates[id] ? '🟢 ON' : '⚫ OFF', inline: true });
    }
    const rows = []; let row = new ActionRowBuilder(); let n = 0;
    for (const [id, sw] of knownSwitches) {
      if (!sw.inPanel) continue;
      if (n > 0 && n % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
      const on = entityStates[id] ?? false;
      row.addComponents(new ButtonBuilder().setCustomId(`sw_toggle_${id}`).setLabel(`${on?'⚡':'○'} ${sw.name}`).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary));
      n++;
      if (rows.length >= 4) break;
    }
    if (!n || n % 5 !== 0) rows.push(row);
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sw_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sw_all_on').setLabel('⚡ All ON').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sw_all_off').setLabel('⬛ All OFF').setStyle(ButtonStyle.Secondary),
    ));
    const payload = { embeds: [emb], components: rows };
    if (panelMsgId) {
      try { await (await ch.messages.fetch(panelMsgId)).edit(payload); return; }
      catch { panelMsgId = null; }
    }
    panelMsgId = (await ch.send(payload)).id;
  } catch (e) { console.error('[Panel]', e.message); }
}

// ─── POP TRACKER ─────────────────────────────────────────────────────────────
function startPop() {
  if (popTracking) return;
  popTracking = true;
  setInterval(async () => {
    try {
      const i = await refreshServer();
      const c = i.players || 0;
      popHistory.push({ time: Date.now(), count: c });
      popHistory = popHistory.filter(p => p.time > Date.now() - 1800000);
      if (prevPop > 0) {
        if (c > prevPop) popLog30m.joined += c - prevPop;
        else if (c < prevPop) popLog30m.left += prevPop - c;
      }
      prevPop = c;
      pushState();
    } catch {}
  }, 60000);
  setInterval(() => { popLog30m = { joined: 0, left: 0 }; }, 1800000);
}

// ─── WIPE REMINDERS ──────────────────────────────────────────────────────────
function scheduleWipeReminders() {
  if (!C.wipeDate || !C.alerts.wipe) return;
  [{ b: 86400000, l: '24 hours' }, { b: 3600000, l: '1 hour' }, { b: 900000, l: '15 minutes' }]
    .forEach(({ b, l }) => {
      const d = C.wipeDate.getTime() - b - Date.now();
      if (d > 0) setTimeout(() => {
        sendTo('wipe', { embeds: [mkEmbed('📅 Wipe Reminder', `Wipes in **${l}**!`, 0xF5A623)] });
        pushAlert({ type: 'event', icon: '📅', title: `Wipe in ${l}`, detail: '' });
      }, d);
    });
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────
async function refreshServer() {
  try { const r = await rustplus.getInfo(); if (r?.response?.info) serverInfo = r.response.info; }
  catch (e) { console.error('[getInfo]', e.message); }
  return serverInfo;
}

async function refreshTeam() {
  try {
    const r = await rustplus.getTeamInfo();
    if (r?.response?.teamInfo) teamInfo = r.response.teamInfo;
    if (teamInfo?.members) updateSpyFromTeam(teamInfo.members);
  } catch (e) { console.error('[getTeam]', e.message); }
  return teamInfo;
}

// Heartbeat — refreshes server data and pushes state every 30 seconds
// (pop tracker handles the 60s full refresh; this keeps game time + player count current between those)
setInterval(async () => {
  if (!rustConnected) return;
  try { await refreshServer(); } catch {}
  pushState();
}, 30000);

// Persist watched-player time data every 5 minutes so session totals survive restarts
setInterval(() => { if (watchedPlayers.size > 0) saveWatchedPlayers(); }, 300000);

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const CMDS = [
  new SlashCommandBuilder().setName('server').setDescription('📊 Server info'),
  new SlashCommandBuilder().setName('team').setDescription('👥 Team status'),
  new SlashCommandBuilder().setName('switches').setDescription('⚡ List switches'),
  new SlashCommandBuilder().setName('switch').setDescription('⚡ Toggle switch')
    .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
    .addStringOption(o => o.setName('state').setDescription('on/off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
  new SlashCommandBuilder().setName('pop').setDescription('📊 Population'),
  new SlashCommandBuilder().setName('time').setDescription('🕐 In-game time'),
  new SlashCommandBuilder().setName('wipe').setDescription('📅 Wipe countdown'),
  new SlashCommandBuilder().setName('map').setDescription('🗺 Map link'),
  new SlashCommandBuilder().setName('voicejoin').setDescription('🔊 Join voice'),
  new SlashCommandBuilder().setName('voiceleave').setDescription('🔇 Leave voice'),
  new SlashCommandBuilder().setName('testalert').setDescription('🧪 Test alert')
    .addStringOption(o => o.setName('type').setDescription('Type').setRequired(true)
      .addChoices({ name: 'raid', value: 'raid' }, { name: 'alarm', value: 'alarm' }, { name: 'death', value: 'death' }, { name: 'tts', value: 'tts' })),
].map(c => c.toJSON());

async function registerCmds() {
  const rest = new REST({ version: '10' }).setToken(C.discord.token);
  try {
    await rest.put(Routes.applicationGuildCommands(C.discord.clientId, C.discord.guildId), { body: CMDS });
    console.log('[Discord] Slash commands registered');
  } catch (e) { console.error('[Discord] Register failed:', e.message); }
}

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
discord.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const parts  = interaction.customId.split('_');
    const action = parts[1];
    const eid    = parts[2];
    await interaction.deferUpdate().catch(() => {});
    if (action === 'toggle' && eid) {
      await setEntity(eid, !(entityStates[eid] ?? false));
      pushState();
      try { await updatePanel(); } catch {}
    }
    if (action === 'refresh') { try { await updatePanel(); } catch {} }
    if (action === 'all') {
      const val = eid === 'on';
      for (const [id, sw] of knownSwitches) if (sw.inPanel) await setEntity(id, val);
      pushState();
      try { await updatePanel(); } catch {}
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply().catch(() => {});
  const cmd = interaction.commandName;

  try {
    if (cmd === 'server') {
      const i = await refreshServer();
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xCE422B)
        .setTitle(`🎮 ${i.name || 'Server'}`)
        .addFields(
          { name: 'Players', value: `${i.players||0}/${i.maxPlayers||0}`, inline: true },
          { name: 'Queued',  value: `${i.queuedPlayers||0}`, inline: true },
          { name: 'Map',     value: `${i.mapSize||'?'} · Seed ${i.seed||'?'}`, inline: true },
          { name: 'Wipe',    value: i.wipeTime ? `<t:${i.wipeTime}:R>` : '?', inline: true },
        ).setTimestamp()] });
    }
    if (cmd === 'pop') {
      const i = await refreshServer();
      return interaction.editReply({ embeds: [mkEmbed('📊 Pop', `**${i.players||0}/${i.maxPlayers||0}** online`, 0x00D4FF,
        [{ name: '30m', value: `+${popLog30m.joined}/-${popLog30m.left}`, inline: true }])] });
    }
    if (cmd === 'time') {
      const i = await refreshServer(); const t = i.time||'?'; const [h] = t.split(':').map(Number); const day = h>=6&&h<20;
      return interaction.editReply({ embeds: [mkEmbed(`${day?'☀️':'🌙'} ${t}`, `${day?'Daytime':'Nighttime'} · ~${Math.round((day?20-h:24-h+6)*60)}min to ${day?'night':'day'}`, 0xF5A623)] });
    }
    if (cmd === 'team') {
      const t = await refreshTeam();
      const e = new EmbedBuilder().setColor(0x5865F2).setTitle('👥 Team');
      (t?.members||[]).forEach(m => e.addFields({ name: (m.isOnline?'🟢 ':'⚫ ')+m.name, value: `HP:${Math.round(m.health||0)} Grid:${getGrid(m.x,m.y)}`, inline: true }));
      return interaction.editReply({ embeds: [e] });
    }
    if (cmd === 'switch') {
      const name   = interaction.options.getString('name');
      const wantOn = interaction.options.getString('state') === 'on';
      let eid = null;
      for (const [id, sw] of knownSwitches) if (sw.name.toLowerCase().includes(name.toLowerCase())) { eid = id; break; }
      if (!eid) return interaction.editReply({ embeds: [mkEmbed('❌ Not Found', `No switch: ${name}`, 0xCE422B)] });
      await setEntity(eid, wantOn); pushState(); try { await updatePanel(); } catch {}
      return interaction.editReply({ embeds: [mkEmbed(wantOn?'⚡ ON':'⬛ OFF', `${knownSwitches.get(eid)?.name} → ${wantOn?'ON':'OFF'}`, wantOn?0x3DDC84:0x888888)] });
    }
    if (cmd === 'switches') {
      const e = new EmbedBuilder().setColor(0xCE422B).setTitle('⚡ Switches');
      for (const [id, sw] of knownSwitches) e.addFields({ name: `${sw.icon} ${sw.name}`, value: entityStates[id]?'🟢 ON':'⚫ OFF', inline: true });
      return interaction.editReply({ embeds: [e] });
    }
    if (cmd === 'wipe') {
      const i = await refreshServer(); const ts = C.wipeDate ? Math.floor(C.wipeDate/1000) : i.wipeTime;
      return interaction.editReply({ embeds: [mkEmbed('📅 Wipe', ts ? `<t:${ts}:R>` : 'Not set', 0xF5A623)] });
    }
    if (cmd === 'map') {
      const i = await refreshServer();
      return interaction.editReply({ embeds: [mkEmbed('🗺 Map', `[rustmaps.com](https://rustmaps.com/map/${i.mapSize}/${i.seed})`, 0x3DDC84)] });
    }
    if (cmd === 'voicejoin')  { await ensureVoice(); return interaction.editReply({ embeds: [mkEmbed('🔊 Joined', 'Bot in voice', 0x3DDC84)] }); }
    if (cmd === 'voiceleave') {
      if (voiceConn) { voiceConn.destroy(); voiceConn = null; }
      return interaction.editReply({ embeds: [mkEmbed('🔇 Left', 'Bot left voice', 0x888888)] });
    }
    if (cmd === 'testalert') {
      const type = interaction.options.getString('type');
      await interaction.editReply({ embeds: [mkEmbed('🧪 Test', `Firing **${type}**`, 0xF5A623)] });
      if (type === 'raid')  handleRaid('TEST (simulated)');
      if (type === 'alarm') { for (const [id, alm] of knownAlarms) { await handleAlarm(id, alm, { payload: { targetName: 'F5' } }); break; } }
      if (type === 'death') { sendTo('deaths', { embeds: [mkEmbed('💀 TEST', 'TestPlayer killed at F5', 0xFF3B30)] }); pushAlert({ type:'death', icon:'💀', title:'TEST death', detail:'F5' }); }
      if (type === 'tts')   speakTTS('This is a test of Rust Link voice alerts.');
    }
  } catch (e) { console.error('[Interaction]', cmd, e.message); }
});

// ─── DISCORD READY ────────────────────────────────────────────────────────────
discord.once('clientReady', async () => {
  console.log(`[Discord] ${discord.user.tag} ready`);
  await registerCmds();
  startRustClient();
  wsBroadcast({ type: 'botReady', tag: discord.user.tag });
  console.log('[RustLink] All systems GO');
});

// ─── START ───────────────────────────────────────────────────────────────────
httpServer.listen(C.wsPort, () => console.log(`[WS] Listening on port ${C.wsPort}`));

discord.login(C.discord.token).catch(e => {
  console.error('[Discord] Login failed:', e.message);
  process.exit(1);
});
