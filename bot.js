require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionsBitField
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const RustPlus = require('@liamcottle/rustplus.js');
const { execSync } = require('child_process');
const fs = require('fs');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const C = {
  discord: {
    token:     process.env.DISCORD_TOKEN,
    clientId:  process.env.DISCORD_CLIENT_ID,
    guildId:   process.env.DISCORD_GUILD_ID,
    channels: {
      raids:     process.env.CHANNEL_RAIDS,
      alarms:    process.env.CHANNEL_ALARMS,
      deaths:    process.env.CHANNEL_DEATHS,
      events:    process.env.CHANNEL_EVENTS,
      teamChat:  process.env.CHANNEL_TEAM_CHAT,
      switches:  process.env.CHANNEL_SWITCHES,
      log:       process.env.CHANNEL_LOG,
      wipe:      process.env.CHANNEL_WIPE,
    }
  },
  rust: {
    ip:      process.env.RUST_IP,
    port:    parseInt(process.env.RUST_PORT) || 28082,
    steamId: process.env.STEAM_ID,
    token:   process.env.PLAYER_TOKEN,
  },
  voice: {
    channelId: process.env.VOICE_CHANNEL_ID,
    volume:    parseInt(process.env.TTS_VOLUME) || 80,
    autoJoin:  process.env.VOICE_AUTO_JOIN !== 'false',
    autoLeave: process.env.VOICE_AUTO_LEAVE !== 'false',
    msgTemplate: process.env.TTS_TEMPLATE || 'WARNING! {alarm_name} has been triggered at grid {grid}!',
  },
  alerts: {
    raids:      process.env.ALERT_RAIDS     !== 'false',
    alarms:     process.env.ALERT_ALARMS    !== 'false',
    teamChat:   process.env.ALERT_TEAMCHAT  !== 'false',
    deaths:     process.env.ALERT_DEATHS    !== 'false',
    events:     process.env.ALERT_EVENTS    !== 'false',
    wipe:       process.env.ALERT_WIPE      !== 'false',
    playerJoin: process.env.ALERT_JOINS     === 'true',
    deathInChat:  process.env.DEATH_IN_TEAM_CHAT  !== 'false',
    alarmInChat:  process.env.ALARM_IN_TEAM_CHAT  !== 'false',
    voiceRaids:   process.env.VOICE_RAIDS   !== 'false',
    voiceAlarms:  process.env.VOICE_ALARMS  !== 'false',
    voiceDeaths:  process.env.VOICE_DEATHS  === 'true',
    voiceEvents:  process.env.VOICE_EVENTS  !== 'false',
  },
  wipeDate: process.env.WIPE_DATE ? new Date(process.env.WIPE_DATE) : null,
};

// ─── ROLE RULES ─────────────────────────────────────────────────────────────
// Format: KEYWORD:roleId,KEYWORD:roleId
const roleRules = [];
if (process.env.ROLE_RULES) {
  process.env.ROLE_RULES.split(',').forEach(pair => {
    const [kw, roleId, channelOverride] = pair.split(':');
    if (kw && roleId) roleRules.push({ keyword: kw.trim().toUpperCase(), roleId: roleId.trim(), channelOverride: channelOverride?.trim() || null, enabled: true });
  });
}

// ─── ENTITY STORES ──────────────────────────────────────────────────────────
const knownSwitches = new Map(); // entityId -> { name, icon, inPanel }
const knownAlarms   = new Map(); // entityId -> { name, voice, teamChat, roleId }
const entityStates  = {};
const popHistory    = []; // { time, count } last 30 min
let   popLog30m     = { joined: 0, left: 0, snapshots: [] };

if (process.env.SWITCHES) {
  process.env.SWITCHES.split(',').forEach(p => {
    const [name, id] = p.split(':');
    if (name && id) knownSwitches.set(id.trim(), { name: name.trim(), icon: '⚡', inPanel: true });
  });
}
if (process.env.ALARMS) {
  process.env.ALARMS.split(',').forEach(p => {
    const [name, id, roleId] = p.split(':');
    if (name && id) knownAlarms.set(id.trim(), { name: name.trim(), voice: true, teamChat: true, roleId: roleId?.trim() || null });
  });
}

// ─── STATE ──────────────────────────────────────────────────────────────────
// ─── DASHBOARD HTTP + WEBSOCKET SERVER (Railway) ───────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);

// Simple HTTP server so Railway has something to route to (and for health checks)
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('RustLink OK');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

function wsSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function getFullState() {
  // Convert Maps to arrays for JSON
  const switches = Array.from(knownSwitches.entries()).map(([entityId, v]) => ({
    entityId,
    name: v.name,
    icon: v.icon || '⚡',
    value: !!entityStates[entityId],
    inPanel: v.inPanel !== false
  }));

  const alarms = Array.from(knownAlarms.entries()).map(([entityId, v]) => ({
    entityId,
    name: v.name,
    enabled: v.enabled !== false,
    voice: v.voice !== false
  }));

  const members = (teamInfo && teamInfo.members) ? teamInfo.members.map(m => ({
    steamId: String(m.steamId),
    name: m.name,
    isOnline: m.isOnline ?? null,
    x: m.x ?? null,
    y: m.y ?? null,
    hp: m.health ?? null
  })) : [];

  return {
    serverInfo,
    team: { leaderSteamId: teamInfo.leaderSteamId ? String(teamInfo.leaderSteamId) : null, members },
    switches,
    alarms,
    popHistory,
    alerts: C.alerts
  };
}

function broadcastWS(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const c of wsClients) {
    if (c.readyState === 1) {
      try { c.send(msg); } catch {}
    }
  }
}

httpServer.on('upgrade', (req, socket, head) => {
  // Accept WS on / or /ws
  const url = req.url || '/';
  if (url !== '/' && !url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  wsClients.add(ws);
  wsSend(ws, { type: 'botReady', tag: client?.user?.tag || 'RustLink Bot' });
  wsSend(ws, { type: 'fullState', data: getFullState() });

  ws.on('message', async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    try {
      if (msg.type === 'toggleSwitch') {
        const entityId = String(msg.entityId || '');
        const value = !!msg.value;
        const ok = await setEntityValue(entityId, value);
        wsSend(ws, { type: ok ? 'switchToggled' : 'error', entityId, value, message: ok ? undefined : 'Failed to toggle switch' });
        if (ok) broadcastWS('stateUpdate', getFullState());
      }

      if (msg.type === 'sendTeamChat') {
        const text = String(msg.message || '').trim();
        if (text) await rustplus.sendTeamMessage(text);
      }

      // Spy feature placeholders (dashboard-only list)
      if (msg.type === 'addSpy' || msg.type === 'removeSpy') {
        // You can wire this into real tracking later; dashboard expects an ack only.
        wsSend(ws, { type: 'spyEvent', action: msg.type, data: msg });
      }
    } catch (e) {
      wsSend(ws, { type: 'error', message: e?.message || 'Unknown error' });
    }
  });

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

httpServer.listen(PORT, () => console.log(`[Dashboard] HTTP/WS listening on :${PORT}`));

let rustplus      = null;
let serverInfo    = {};
let teamInfo      = {};
let switchPanelMsgId = null;
let voiceConn     = null;
const audioPlayer = createAudioPlayer();
let   ttsQueue    = [];
let   ttsPlaying  = false;
let   prevPlayerList = [];

// ─── DISCORD CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent]
});

// ─── EMBED BUILDER ───────────────────────────────────────────────────────────
function embed(title, desc, color = 0xCE422B, fields = []) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (desc) e.setDescription(desc);
  if (fields.length) e.addFields(fields);
  return e;
}

// ─── CHANNEL SENDER ──────────────────────────────────────────────────────────
async function sendTo(type, payload) {
  const id = C.discord.channels[type];
  if (!id) return;
  try {
    const ch = await client.channels.fetch(id);
    return await ch.send(payload);
  } catch (e) { console.error(`[sendTo:${type}]`, e.message); }
}

// ─── ROLE PING ───────────────────────────────────────────────────────────────
function getPingForKeyword(keyword) {
  const rule = roleRules.find(r => r.enabled && r.keyword === keyword.toUpperCase());
  return rule ? `<@&${rule.roleId}> ` : '';
}

// ─── TTS VOICE ───────────────────────────────────────────────────────────────
async function ensureVoiceJoined() {
  if (voiceConn && voiceConn.state.status !== VoiceConnectionStatus.Destroyed) return voiceConn;
  if (!C.voice.channelId) return null;
  try {
    const guild = await client.guilds.fetch(C.discord.guildId);
    const channel = await guild.channels.fetch(C.voice.channelId);
    if (!channel.isVoiceBased()) return null;
    voiceConn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
    voiceConn.subscribe(audioPlayer);
    console.log(`[Voice] Joined channel: ${channel.name}`);
    return voiceConn;
  } catch (e) { console.error('[Voice] Join failed:', e.message); return null; }
}

async function speakTTS(text) {
  ttsQueue.push(text);
  if (!ttsPlaying) processTTSQueue();
}

async function processTTSQueue() {
  if (ttsQueue.length === 0) {
    ttsPlaying = false;
    if (C.voice.autoLeave) {
      setTimeout(() => { if (voiceConn) { voiceConn.destroy(); voiceConn = null; } }, 30000);
    }
    return;
  }
  ttsPlaying = true;
  const text = ttsQueue.shift();
  const conn = await ensureVoiceJoined();
  if (!conn) { ttsPlaying = false; return; }

  try {
    // Generate TTS audio using espeak or system TTS
    const tmpFile = '/tmp/rustlink_tts_' + Date.now() + '.wav';
    try {
      execSync(`espeak "${text.replace(/"/g, "'")}" -w ${tmpFile} --rate=140 2>/dev/null`);
    } catch {
      // Fallback: use say (macOS) or festival
      try { execSync(`echo "${text.replace(/"/g, "'")}" | festival --tts 2>/dev/null`); } catch {}
    }

    if (fs.existsSync(tmpFile)) {
      const resource = createAudioResource(tmpFile);
      audioPlayer.play(resource);
      audioPlayer.once(AudioPlayerStatus.Idle, () => {
        fs.unlinkSync(tmpFile);
        setTimeout(processTTSQueue, 500);
      });
    } else {
      ttsPlaying = false;
    }
  } catch (e) {
    console.error('[TTS] Error:', e.message);
    ttsPlaying = false;
    setTimeout(processTTSQueue, 500);
  }
}

function buildTTSMsg(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] || k);
}

// ─── RUST+ CLIENT ────────────────────────────────────────────────────────────
function createRustClient() {
  if (!C.rust.ip || !C.rust.steamId || !C.rust.token) {
    console.warn('[Rust+] Missing credentials — set RUST_IP, STEAM_ID, PLAYER_TOKEN');
    return;
  }

  rustplus = new RustPlus(C.rust.ip, C.rust.port, C.rust.steamId, C.rust.token);

  rustplus.on('connected', async () => {
    console.log('[Rust+] Connected!');
    await refreshServerInfo();
    await refreshTeamInfo();
    sendTo('log', { embeds: [embed('🔗 Rust Link Connected', `Now monitoring **${serverInfo.name || C.rust.ip}**`, 0x3DDC84)] });
    startPopTracker();
    scheduleWipeReminders();
    await updateSwitchPanel();
  });

  rustplus.on('disconnected', () => {
    console.warn('[Rust+] Disconnected — retrying in 15s');
    sendTo('log', { embeds: [embed('🔌 Disconnected', 'Reconnecting in 15 seconds…', 0xCE422B)] });
    setTimeout(() => rustplus.connect(), 15000);
  });

  rustplus.on('message', async (msg) => {
    if (!msg.broadcast) return;
    const b = msg.broadcast;

    // ── TEAM MESSAGE (team chat relay + in-game command handler)
    if (b.teamMessage && C.alerts.teamChat) {
      const tm = b.teamMessage.message;
      const text = tm.message.trim();
      const name = tm.name;

      // In-game chat commands
      const prefix = process.env.CMD_PREFIX || '!';
      if (text.startsWith(prefix)) {
        await handleIngameCommand(text.slice(prefix.length).trim(), name);
        return;
      }

      // Relay to Discord
      sendTo('teamChat', {
        embeds: [new EmbedBuilder().setColor(0x5865F2)
          .setAuthor({ name: `💬 ${name}` })
          .setDescription(text)
          .setFooter({ text: `Grid: ${tm.targetName || '?'} · In-game Team Chat` })
          .setTimestamp()]
      });
    }

    // ── ENTITY CHANGED (switch toggled or alarm triggered)
    if (b.entityChanged) {
      const ec = b.entityChanged;
      const idStr = String(ec.entityId);
      const val = ec.payload?.value;

      // Switch state update
      if (knownSwitches.has(idStr)) {
        entityStates[idStr] = val;
        await updateSwitchPanel();
      }

      // Alarm triggered
      if (knownAlarms.has(idStr) && val && C.alerts.alarms) {
        const alm = knownAlarms.get(idStr);
        await handleAlarmAlert(idStr, alm, ec);
      }
    }

    // ── TEAM INFO (deaths, online/offline)
    if (b.teamChanged) {
      await handleTeamChanged(b.teamChanged);
    }
  });

  rustplus.connect();
}

// ─── ALARM ALERT ────────────────────────────────────────────────────────────
async function handleAlarmAlert(entityId, alm, ec) {
  const ping = alm.roleId ? `<@&${alm.roleId}> ` : getPingForKeyword('ALARM');
  const grid = ec.payload?.targetName || 'Unknown Grid';

  // Discord embed
  const almEmbed = new EmbedBuilder()
    .setColor(0xF5A623)
    .setTitle('🔔 Smart Alarm Triggered')
    .setDescription(`${ping}**${alm.name}** has been activated!`)
    .addFields(
      { name: 'Grid', value: grid, inline: true },
      { name: 'Entity ID', value: entityId, inline: true },
      { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:T>`, inline: true }
    )
    .setTimestamp();

  sendTo('alarms', { content: ping || null, embeds: [almEmbed] });

  // Voice TTS
  if (alm.voice && C.alerts.voiceAlarms) {
    const msg = buildTTSMsg(C.voice.msgTemplate, { alarm_name: alm.name, grid, time: new Date().toLocaleTimeString(), server: serverInfo.name || C.rust.ip });
    await speakTTS(msg);
  }

  // In-game team chat
  if (alm.teamChat && C.alerts.alarmInChat) {
    try {
      await rustplus.sendTeamMessage(`🔔 ALARM: ${alm.name} triggered at ${grid}!`);
    } catch (e) { console.error('[Chat] Alarm send failed:', e.message); }
  }

  // Log
  console.log(`[Alarm] ${alm.name} triggered — Grid: ${grid}`);
}

// ─── TEAM CHANGED (deaths, joins/leaves) ────────────────────────────────────
let lastTeamMembers = {};

async function handleTeamChanged(tc) {
  const newTeam = await refreshTeamInfo();
  if (!newTeam?.members) return;

  newTeam.members.forEach(member => {
    const prev = lastTeamMembers[member.steamId];

    // Death detection
    if (prev && member.isAlive === false && prev.isAlive === true && C.alerts.deaths) {
      const grid = getGrid(member.x, member.y);
      const deathEmbed = new EmbedBuilder()
        .setColor(0xFF3B30)
        .setTitle('💀 Team Member Died')
        .setDescription(`${getPingForKeyword('DEATH')}**${member.name}** was killed!`)
        .addFields(
          { name: 'Grid', value: grid, inline: true },
          { name: 'Player', value: member.name, inline: true },
        )
        .setTimestamp();

      sendTo('deaths', { content: getPingForKeyword('DEATH') || null, embeds: [deathEmbed] });

      // Death in team chat
      if (C.alerts.deathInChat) {
        try { rustplus.sendTeamMessage(`💀 ${member.name} died at ${grid}!`); } catch {}
      }

      // Voice
      if (C.alerts.voiceDeaths) {
        speakTTS(`${member.name} has been killed at grid ${grid}!`);
      }
    }

    // Online/offline
    if (prev && member.isOnline !== prev.isOnline && C.alerts.playerJoin) {
      const action = member.isOnline ? 'came online' : 'went offline';
      sendTo('log', { embeds: [embed(
        member.isOnline ? '🟢 Teammate Online' : '⚫ Teammate Offline',
        `**${member.name}** ${action}`,
        member.isOnline ? 0x3DDC84 : 0x666666
      )] });
    }

    lastTeamMembers[member.steamId] = member;
  });
}

function getGrid(x, y) {
  if (!x && !y) return 'Unknown';
  const mapSize = serverInfo.mapSize || 4500;
  const col = String.fromCharCode(65 + Math.floor(x / (mapSize / 26)));
  const row = Math.floor(y / (mapSize / 26)) + 1;
  return `${col}${row}`;
}

// ─── RAID DETECTION ──────────────────────────────────────────────────────────
// rustplus.js fires a 'teamMessage' or you can use server-level explosion detection
// This is the explosion message pattern from Rust+
const RAID_KEYWORDS = ['explosion', 'rocket', 'c4', 'satchel', 'grenade'];

async function handleRaidAlert(detail) {
  if (!C.alerts.raids) return;
  const ping = getPingForKeyword('RAID');
  const raidEmbed = new EmbedBuilder()
    .setColor(0xCE422B)
    .setTitle('💥 RAID ALERT')
    .setDescription(`${ping}Explosions detected near your base!`)
    .addFields({ name: 'Detail', value: detail || 'Explosion detected', inline: true })
    .setTimestamp()
    .setFooter({ text: serverInfo.name || C.rust.ip });

  sendTo('raids', { content: ping || null, embeds: [raidEmbed] });

  if (C.alerts.voiceRaids) speakTTS('RAID ALERT! Explosions detected near your base!');
}

// ─── IN-GAME COMMANDS ────────────────────────────────────────────────────────
async function handleIngameCommand(cmd, senderName) {
  const parts = cmd.split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  try {
    switch (command) {
      case 'pop': {
        const info = await refreshServerInfo();
        const { joined, left } = popLog30m;
        await rustplus.sendTeamMessage(
          `📊 Players: ${info.players}/${info.maxPlayers} | Queue: ${info.queuedPlayers || 0} | Last 30m: +${joined} joined · -${left} left`
        );
        break;
      }

      case 'time': {
        const info = await refreshServerInfo();
        const gameTime = info.time || '??:??';
        const [gh] = (gameTime.split(':').map(Number));
        const isDay = gh >= 6 && gh < 20;
        const toNext = isDay ? 20 - gh : (24 - gh + 6);
        await rustplus.sendTeamMessage(
          `${isDay ? '☀️' : '🌙'} In-game: ${gameTime} | ${isDay ? 'Day' : 'Night'} | ${isDay ? 'Night' : 'Day'} in: ~${Math.floor(toNext * 60)}min`
        );
        break;
      }

      case 'wipe': {
        if (C.wipeDate) {
          const diff = C.wipeDate - Date.now();
          const d = Math.floor(diff / 86400000);
          const h = Math.floor((diff % 86400000) / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          await rustplus.sendTeamMessage(`📅 Next wipe: ${d}d ${h}h ${m}m`);
        } else {
          await rustplus.sendTeamMessage('📅 Wipe date not set. Configure WIPE_DATE in settings.');
        }
        break;
      }

      case 'map': {
        const info = await refreshServerInfo();
        await rustplus.sendTeamMessage(`🗺 Map: https://rustmaps.com/map/${info.mapSize}/${info.seed}`);
        break;
      }

      case 'team': {
        const team = await refreshTeamInfo();
        if (!team?.members) break;
        const lines = team.members.map(m => {
          const status = m.isOnline ? '●' : '○';
          const grid = m.isOnline ? getGrid(m.x, m.y) : 'offline';
          const hp = m.isOnline && m.isAlive ? ` ${Math.round(m.health || 0)}HP` : '';
          return `${status} ${m.name} ${grid}${hp}`;
        });
        await rustplus.sendTeamMessage('👥 Team:\n' + lines.join('\n'));
        break;
      }

      case 'events': {
        // This would pull from active server event tracking
        await rustplus.sendTeamMessage('📡 Events: Check #events channel in Discord for live updates.');
        break;
      }

      case 'sw':
      case 'switch': {
        if (!args[0]) {
          await rustplus.sendTeamMessage('Usage: !sw [name]');
          break;
        }
        const target = args.join(' ').toLowerCase();
        let found = null;
        for (const [id, sw] of knownSwitches) {
          if (sw.name.toLowerCase().includes(target)) { found = { id, sw }; break; }
        }
        if (!found) { await rustplus.sendTeamMessage(`⚡ Switch not found: ${args.join(' ')}`); break; }
        const currentState = entityStates[found.id] ?? false;
        await setEntityValue(found.id, !currentState);
        await rustplus.sendTeamMessage(`⚡ ${found.sw.name}: ${!currentState ? 'ON' : 'OFF'}`);
        break;
      }

      case 'switches': {
        const lines = [];
        for (const [id, sw] of knownSwitches) {
          const on = entityStates[id] ?? false;
          lines.push(`${on ? '⚡' : '○'} ${sw.name}: ${on ? 'ON' : 'OFF'}`);
        }
        await rustplus.sendTeamMessage('⚡ Switches:\n' + (lines.join('\n') || 'None configured'));
        break;
      }

      case 'alarms': {
        const lines = [];
        for (const [id, alm] of knownAlarms) {
          lines.push(`${alm.enabled !== false ? '🔔' : '○'} ${alm.name}`);
        }
        await rustplus.sendTeamMessage('🔔 Alarms:\n' + (lines.join('\n') || 'None configured'));
        break;
      }

      case 'ping': {
        await rustplus.sendTeamMessage(`🤖 Rust Link: Online | Discord: Connected | Latency: ${client.ws.ping}ms`);
        break;
      }
    }
  } catch (e) { console.error('[Cmd]', command, e.message); }
}

// ─── ENTITY VALUE ────────────────────────────────────────────────────────────
async function setEntityValue(entityId, value) {
  try { await rustplus.setEntityValue(entityId, value); entityStates[entityId] = value; try { broadcastWS && broadcastWS('stateUpdate', getFullState()); } catch {} return true; }
  catch (e) { console.error('[setEntity]', e.message); return false; }
}

// ─── SWITCH PANEL (Discord) ──────────────────────────────────────────────────
async function updateSwitchPanel() {
  if (!C.discord.channels.switches) return;
  try {
    const ch = await client.channels.fetch(C.discord.channels.switches);
    const panelEmbed = new EmbedBuilder()
      .setColor(0xCE422B)
      .setTitle('⚡ Smart Switch Control Panel')
      .setDescription('Click buttons below to toggle switches in-game. Changes apply instantly.')
      .setTimestamp()
      .setFooter({ text: `${Object.values(entityStates).filter(Boolean).length} switches ON · Updated` });

    // List switch states in embed fields
    for (const [id, sw] of knownSwitches) {
      if (!sw.inPanel) continue;
      panelEmbed.addFields({ name: `${sw.icon || '⚡'} ${sw.name}`, value: entityStates[id] ? '🟢 ON' : '⚫ OFF', inline: true });
    }

    // Build button rows (max 5 buttons per row, max 5 rows = 25 buttons)
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let count = 0;
    for (const [id, sw] of knownSwitches) {
      if (!sw.inPanel) continue;
      if (count > 0 && count % 5 === 0) { rows.push(currentRow); currentRow = new ActionRowBuilder(); }
      const on = entityStates[id] ?? false;
      currentRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`sw_toggle_${id}`)
          .setLabel(`${on ? '⚡' : '○'} ${sw.name}`)
          .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
      count++;
      if (rows.length >= 4) break; // Max 4 rows for switches
    }
    if (count % 5 !== 0 || count === 0) rows.push(currentRow);

    // Add a refresh button in its own row
    const refreshRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sw_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sw_all_on').setLabel('⚡ All ON').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sw_all_off').setLabel('⬛ All OFF').setStyle(ButtonStyle.Secondary),
    );
    rows.push(refreshRow);

    const payload = { embeds: [panelEmbed], components: rows };

    // Update existing message or post new one
    if (switchPanelMsgId) {
      try {
        const msg = await ch.messages.fetch(switchPanelMsgId);
        await msg.edit(payload);
        return;
      } catch { switchPanelMsgId = null; }
    }

    const msg = await ch.send(payload);
    switchPanelMsgId = msg.id;
  } catch (e) { console.error('[Panel]', e.message); }
}

// ─── POP TRACKER ─────────────────────────────────────────────────────────────
function startPopTracker() {
  setInterval(async () => {
    try {
      const info = await refreshServerInfo();
      const now = Date.now();
      const count = info.players || 0;
      popHistory.push({ time: now, count });

      // Keep 30 minutes of history
      const cutoff = now - 30 * 60 * 1000;
      while (popHistory.length > 1 && popHistory[0].time < cutoff) popHistory.shift();

      // Track joined/left
      if (prevPlayerList.length > 0 && prevPlayerList.length !== count) {
        if (count > prevPlayerList.length) popLog30m.joined += count - prevPlayerList.length;
        else popLog30m.left += prevPlayerList.length - count;
      }
      prevPlayerList = Array(count).fill(null); // approximate

      // Reset 30m counters every 30 minutes
    } catch {}
  }, 60000); // every minute

  // Reset 30m stats every 30 minutes
  setInterval(() => { popLog30m = { joined: 0, left: 0, snapshots: [] }; }, 30 * 60 * 1000);
}

// ─── WIPE REMINDERS ──────────────────────────────────────────────────────────
function scheduleWipeReminders() {
  if (!C.wipeDate || !C.alerts.wipe) return;
  const reminders = [
    { before: 24 * 60 * 60 * 1000, label: '24 hours' },
    { before: 60 * 60 * 1000,      label: '1 hour' },
    { before: 15 * 60 * 1000,      label: '15 minutes' },
  ];
  reminders.forEach(({ before, label }) => {
    const fireAt = C.wipeDate.getTime() - before;
    const delay = fireAt - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        sendTo('wipe', {
          content: getPingForKeyword('WIPE') || null,
          embeds: [embed(
            '📅 Wipe Reminder',
            `**Server wipes in ${label}!**\nTime: <t:${Math.floor(C.wipeDate.getTime()/1000)}:F>`,
            0xF5A623,
            [{ name: 'Server', value: serverInfo.name || C.rust.ip, inline: true }]
          )]
        });
      }, delay);
    }
  });
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────
async function refreshServerInfo() {
  try { const r = await rustplus.getInfo(); serverInfo = r?.response?.info || {}; try { broadcastWS && broadcastWS('stateUpdate', getFullState()); } catch {} return serverInfo; }
  catch { return serverInfo; }
}

async function refreshTeamInfo() {
  try { const r = await rustplus.getTeamInfo(); teamInfo = r?.response?.teamInfo || {}; try { broadcastWS && broadcastWS('stateUpdate', getFullState()); } catch {} return teamInfo; }
  catch { return teamInfo; }
}

// ─── SLASH COMMANDS ──────────────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder().setName('server').setDescription('📊 Server info & population'),
  new SlashCommandBuilder().setName('team').setDescription('👥 Team members + HP + grid'),
  new SlashCommandBuilder().setName('switches').setDescription('⚡ List all smart switches'),
  new SlashCommandBuilder().setName('switch')
    .setDescription('⚡ Toggle a smart switch')
    .addStringOption(o => o.setName('name').setDescription('Switch name or entity ID').setRequired(true))
    .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('alarms').setDescription('🔔 List smart alarms'),
  new SlashCommandBuilder().setName('wipe').setDescription('📅 Time until next wipe'),
  new SlashCommandBuilder().setName('events').setDescription('🗺 Active server events'),
  new SlashCommandBuilder().setName('map').setDescription('🗺 Server map link'),
  new SlashCommandBuilder().setName('pop').setDescription('📊 Current population + 30m trend'),
  new SlashCommandBuilder().setName('time').setDescription('🕐 In-game time + day/night'),
  new SlashCommandBuilder().setName('voicejoin').setDescription('🔊 Bot joins voice channel for TTS alerts'),
  new SlashCommandBuilder().setName('voiceleave').setDescription('🔇 Bot leaves voice channel'),
  new SlashCommandBuilder().setName('testalert')
    .setDescription('🧪 Test an alert type')
    .addStringOption(o => o.setName('type').setDescription('Alert type').setRequired(true).addChoices(
      {name:'raid',value:'raid'},{name:'alarm',value:'alarm'},{name:'death',value:'death'},{name:'tts',value:'tts'}
    )),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(C.discord.token);
  try {
    await rest.put(Routes.applicationGuildCommands(C.discord.clientId, C.discord.guildId), { body: slashCommands });
    console.log('[Discord] Slash commands registered');
  } catch (e) { console.error('[Discord] Command register failed:', e); }
}

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── BUTTONS (switch panel)
  if (interaction.isButton()) {
    const [, action, entityId] = interaction.customId.split('_');
    await interaction.deferUpdate();

    if (action === 'toggle' && entityId) {
      const current = entityStates[entityId] ?? false;
      const ok = await setEntityValue(entityId, !current);
      const sw = knownSwitches.get(entityId);
      if (ok) {
        sendTo('log', { embeds: [embed(
          `⚡ Switch ${!current ? 'ON' : 'OFF'}`,
          `**${sw?.name || entityId}** turned ${!current ? 'ON' : 'OFF'} by **${interaction.user.username}**`,
          !current ? 0x3DDC84 : 0x888888
        )] });
      }
      await updateSwitchPanel();
    }

    if (action === 'refresh') await updateSwitchPanel();
    if (action === 'all' && entityId === 'on') {
      for (const [id] of knownSwitches) { if (knownSwitches.get(id).inPanel) await setEntityValue(id, true); }
      await updateSwitchPanel();
    }
    if (action === 'all' && entityId === 'off') {
      for (const [id] of knownSwitches) { if (knownSwitches.get(id).inPanel) await setEntityValue(id, false); }
      await updateSwitchPanel();
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: false });
  const { commandName } = interaction;

  // ── /server
  if (commandName === 'server') {
    const info = await refreshServerInfo();
    return interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0xCE422B).setTitle(`🎮 ${info.name || 'Unknown Server'}`)
        .addFields(
          { name: 'Players', value: `${info.players}/${info.maxPlayers}`, inline: true },
          { name: 'Queued', value: `${info.queuedPlayers || 0}`, inline: true },
          { name: 'Map Size', value: `${info.mapSize || '?'}`, inline: true },
          { name: 'Seed', value: `${info.seed || '?'}`, inline: true },
          { name: 'Wipe', value: info.wipeTime ? `<t:${info.wipeTime}:R>` : 'Unknown', inline: true },
        ).setTimestamp()
    ] });
  }

  // ── /pop
  if (commandName === 'pop') {
    const info = await refreshServerInfo();
    const { joined, left } = popLog30m;
    const last = popHistory.slice(-1)[0]?.count || info.players;
    return interaction.editReply({ embeds: [
      embed('📊 Server Population',
        `**${info.players}/${info.maxPlayers}** online · **${info.queuedPlayers || 0}** queued`,
        0x00D4FF,
        [
          { name: '30m Trend', value: `+${joined} joined · -${left} left`, inline: true },
          { name: 'Map', value: `${info.mapSize} · Seed: ${info.seed}`, inline: true },
        ]
      )
    ] });
  }

  // ── /time
  if (commandName === 'time') {
    const info = await refreshServerInfo();
    const t = info.time || '??:??';
    const [h] = t.split(':').map(Number);
    const isDay = h >= 6 && h < 20;
    const toNext = Math.round((isDay ? (20 - h) : (24 - h + 6)) * 60);
    return interaction.editReply({ embeds: [
      embed(`${isDay ? '☀️' : '🌙'} In-Game Time: ${t}`,
        `Currently **${isDay ? 'Daytime' : 'Nighttime'}**\n${isDay ? 'Night' : 'Day'} in approximately **${toNext} minutes**`,
        0xF5A623
      )
    ] });
  }

  // ── /team
  if (commandName === 'team') {
    const team = await refreshTeamInfo();
    if (!team?.members) return interaction.editReply({ embeds: [embed('❌ Error', 'Could not fetch team info', 0xCE422B)] });
    const e = new EmbedBuilder().setColor(0x5865F2).setTitle('👥 Team Members').setTimestamp();
    team.members.forEach(m => {
      const grid = m.isOnline ? getGrid(m.x, m.y) : '—';
      const hp = m.isOnline && m.isAlive ? `${Math.round(m.health)}HP` : m.isOnline ? 'Dead' : '—';
      e.addFields({ name: (m.isOnline ? '🟢 ' : '⚫ ') + m.name, value: `HP: ${hp}\nGrid: ${grid}`, inline: true });
    });
    return interaction.editReply({ embeds: [e] });
  }

  // ── /switch
  if (commandName === 'switch') {
    const nameOrId = interaction.options.getString('name');
    const wantOn = interaction.options.getString('state') === 'on';
    let entityId = null;
    for (const [id, sw] of knownSwitches) {
      if (sw.name.toLowerCase().includes(nameOrId.toLowerCase()) || id === nameOrId) { entityId = id; break; }
    }
    if (!entityId && /^\d+$/.test(nameOrId)) entityId = nameOrId;
    if (!entityId) return interaction.editReply({ embeds: [embed('❌ Not Found', `No switch matching "${nameOrId}"`, 0xCE422B)] });
    const ok = await setEntityValue(entityId, wantOn);
    const swName = knownSwitches.get(entityId)?.name || entityId;
    await updateSwitchPanel();
    return interaction.editReply({ embeds: [embed(
      wantOn ? '⚡ Switch ON' : '⬛ Switch OFF',
      `**${swName}** turned ${wantOn ? 'ON' : 'OFF'}`,
      wantOn ? 0x3DDC84 : 0x888888
    )] });
  }

  // ── /switches
  if (commandName === 'switches') {
    const e = new EmbedBuilder().setColor(0xCE422B).setTitle('⚡ Smart Switches');
    for (const [id, sw] of knownSwitches) {
      e.addFields({ name: `${sw.icon||'⚡'} ${sw.name}`, value: `${entityStates[id] ? '🟢 ON' : '⚫ OFF'}\nID: \`${id}\``, inline: true });
    }
    if (knownSwitches.size === 0) e.setDescription('No switches configured. Add them in Settings.');
    return interaction.editReply({ embeds: [e] });
  }

  // ── /alarms
  if (commandName === 'alarms') {
    const e = new EmbedBuilder().setColor(0xF5A623).setTitle('🔔 Smart Alarms');
    for (const [id, alm] of knownAlarms) {
      e.addFields({ name: alm.name, value: `ID: \`${id}\`\nVoice: ${alm.voice?'✅':'❌'} · Chat: ${alm.teamChat?'✅':'❌'}`, inline: true });
    }
    if (knownAlarms.size === 0) e.setDescription('No alarms configured.');
    return interaction.editReply({ embeds: [e] });
  }

  // ── /wipe
  if (commandName === 'wipe') {
    const info = await refreshServerInfo();
    const wipeTs = C.wipeDate ? Math.floor(C.wipeDate.getTime()/1000) : info.wipeTime;
    if (!wipeTs) return interaction.editReply({ embeds: [embed('📅 Wipe', 'No wipe date configured.', 0xF5A623)] });
    return interaction.editReply({ embeds: [embed('📅 Next Wipe', `Wipe is <t:${wipeTs}:R> (<t:${wipeTs}:F>)`, 0xF5A623)] });
  }

  // ── /map
  if (commandName === 'map') {
    const info = await refreshServerInfo();
    return interaction.editReply({ embeds: [embed('🗺 Server Map',
      `[View on rustmaps.com](https://rustmaps.com/map/${info.mapSize}/${info.seed})\nSeed: \`${info.seed}\` · Size: \`${info.mapSize}\``,
      0x3DDC84
    )] });
  }

  // ── /voicejoin
  if (commandName === 'voicejoin') {
    await ensureVoiceJoined();
    return interaction.editReply({ embeds: [embed('🔊 Joined Voice', 'Bot is now in the voice channel and ready for TTS alerts.', 0x3DDC84)] });
  }

  // ── /voiceleave
  if (commandName === 'voiceleave') {
    if (voiceConn) { voiceConn.destroy(); voiceConn = null; }
    return interaction.editReply({ embeds: [embed('🔇 Left Voice', 'Bot disconnected from voice channel.', 0x888888)] });
  }

  // ── /testalert
  if (commandName === 'testalert') {
    const type = interaction.options.getString('type');
    await interaction.editReply({ embeds: [embed('🧪 Test Alert', `Firing test: **${type}**`, 0xF5A623)] });
    switch (type) {
      case 'raid': await handleRaidAlert('TEST — Rocket fired nearby (simulated)'); break;
      case 'alarm':
        for (const [id, alm] of knownAlarms) { await handleAlarmAlert(id, alm, { payload: { targetName: 'F5' } }); break; }
        break;
      case 'death':
        sendTo('deaths', { embeds: [embed('💀 TEST Death', '**TestPlayer** was killed at Grid F5 (simulated)', 0xFF3B30)] });
        break;
      case 'tts':
        await speakTTS('This is a test of the Rust Link voice alert system. All systems operational.');
        break;
    }
  }
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommands();
  createRustClient();
  await updateSwitchPanel();
  console.log('[RustLink] All systems GO');
});

// ─── START ────────────────────────────────────────────────────────────────────
client.login(C.discord.token).catch(err => {
  console.error('[Discord] Login failed:', err.message);
  process.exit(1);
});
