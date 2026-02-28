require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, REST, Routes
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const RustPlus = require('@liamcottle/rustplus.js');
const { execSync } = require('child_process');
const fs   = require('fs');
const http = require('http');
const WebSocket = require('ws');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
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
    }
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
    msgTemplate: process.env.TTS_TEMPLATE || 'WARNING! {alarm_name} has been triggered at grid {grid}!',
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
    voiceEvents: process.env.VOICE_EVENTS       !== 'false',
  },
  wipeDate:    process.env.WIPE_DATE ? new Date(process.env.WIPE_DATE) : null,
  wsPort:      parseInt(process.env.PORT) || 3000,
  dashboardKey: process.env.DASHBOARD_KEY || 'rustlink',  // simple auth key for WS
};

// ─── ROLE RULES ──────────────────────────────────────────────────────────────
const roleRules = [];
if (process.env.ROLE_RULES) {
  process.env.ROLE_RULES.split(',').forEach(pair => {
    const [kw, roleId, ch] = pair.split(':');
    if (kw && roleId) roleRules.push({ keyword: kw.trim().toUpperCase(), roleId: roleId.trim(), channelOverride: ch?.trim() || null, enabled: true });
  });
}

// ─── ENTITY STORES ───────────────────────────────────────────────────────────
const knownSwitches = new Map(); // entityId → { name, icon, inPanel }
const knownAlarms   = new Map(); // entityId → { name, voice, teamChat, roleId }
const entityStates  = {};        // entityId → bool

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

// ─── LIVE STATE (sent to dashboard) ──────────────────────────────────────────
const liveState = {
  connected:   false,
  botReady:    false,
  serverInfo:  {},
  teamInfo:    {},
  switches:    [],
  alarms:      [],
  alerts:      [],      // last 50 alerts
  chatMessages:[],      // last 30 team chat messages
  pop:         { current: 0, max: 0, queued: 0, joined30m: 0, left30m: 0, history: [] },
  wipeDate:    C.wipeDate ? C.wipeDate.toISOString() : null,
  lastUpdate:  null,
};

// ─── GLOBAL STATE ────────────────────────────────────────────────────────────
let rustplus         = null;
let serverInfo       = {};
let teamInfo         = {};
let switchPanelMsgId = null;
let voiceConn        = null;
const audioPlayer    = createAudioPlayer();
let ttsQueue         = [];
let ttsPlaying       = false;
let popHistory       = [];
let popLog30m        = { joined: 0, left: 0 };
let prevPopCount     = 0;
let lastTeamMembers  = {};

// ─── DISCORD CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent]
});

// ─── WEBSOCKET SERVER ────────────────────────────────────────────────────────
// Creates an HTTP server (required by Railway) + WebSocket on same port
const httpServer = http.createServer((req, res) => {
  // Health check endpoint — Railway uses this to confirm the service is alive
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RustLink OK');
});

const wss = new WebSocket.Server({ server: httpServer });

const wsClients = new Set();

wss.on('connection', (ws, req) => {
  console.log('[WS] Dashboard client connected');
  wsClients.add(ws);

  // Send full state immediately on connect
  wsSend(ws, { type: 'fullState', data: buildLiveState() });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWsMessage(ws, msg);
    } catch { /* ignore bad messages */ }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('[WS] Dashboard client disconnected');
  });

  ws.on('error', (e) => {
    wsClients.delete(ws);
    console.error('[WS] Client error:', e.message);
  });
});

// Broadcast to all connected dashboard tabs
function wsBroadcast(msg) {
  const payload = JSON.stringify(msg);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function wsSend(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Handle messages sent FROM the dashboard (e.g. toggle switch)
async function handleWsMessage(ws, msg) {
  switch (msg.type) {

    case 'toggleSwitch': {
      const { entityId, value } = msg;
      if (!entityId) return;
      const ok = await setEntityValue(entityId, value);
      if (ok) {
        pushLiveState();
        wsBroadcast({ type: 'switchToggled', entityId, value });
      } else {
        wsSend(ws, { type: 'error', message: 'Failed to toggle switch — check Rust+ connection' });
      }
      break;
    }

    case 'sendTeamChat': {
      const { message } = msg;
      if (!message || !rustplus) return;
      try {
        await rustplus.sendTeamMessage(message);
        addChatMsg('You (Dashboard)', message);
        wsBroadcast({ type: 'chatSent', message });
      } catch (e) {
        wsSend(ws, { type: 'error', message: 'Could not send chat: ' + e.message });
      }
      break;
    }

    case 'requestState': {
      wsSend(ws, { type: 'fullState', data: buildLiveState() });
      break;
    }
  }
}

// Build the full live state object for the dashboard
function buildLiveState() {
  // Switches array
  const switches = [];
  for (const [id, sw] of knownSwitches) {
    switches.push({ id, name: sw.name, icon: sw.icon || '⚡', on: entityStates[id] ?? false, inPanel: sw.inPanel });
  }

  // Alarms array
  const alarms = [];
  for (const [id, alm] of knownAlarms) {
    alarms.push({ id, name: alm.name, voice: alm.voice, teamChat: alm.teamChat });
  }

  // Team members
  const team = teamInfo?.members?.map(m => ({
    name:     m.name,
    steamId:  m.steamId,
    online:   m.isOnline ?? false,
    alive:    m.isAlive  ?? true,
    hp:       Math.round(m.health || 0),
    grid:     m.isOnline ? getGrid(m.x, m.y) : '—',
  })) || [];

  // Pop history (last 20 data points)
  const popHist = popHistory.slice(-20).map(p => ({ t: p.time, v: p.count }));

  return {
    connected:    liveState.connected,
    botReady:     liveState.botReady,
    serverName:   serverInfo.name   || C.rust.ip || 'Unknown Server',
    serverIp:     C.rust.ip         || '—',
    serverPort:   C.rust.port,
    mapSize:      serverInfo.mapSize || '—',
    seed:         serverInfo.seed    || '—',
    wipeTime:     serverInfo.wipeTime|| null,
    wipeDate:     C.wipeDate        ? C.wipeDate.toISOString() : null,
    players:      serverInfo.players || 0,
    maxPlayers:   serverInfo.maxPlayers || 0,
    queuedPlayers:serverInfo.queuedPlayers || 0,
    gameTime:     serverInfo.time   || '—',
    team,
    switches,
    alarms,
    alerts:       liveState.alerts.slice(0, 50),
    chatMessages: liveState.chatMessages.slice(0, 30),
    pop: {
      current:  serverInfo.players || 0,
      max:      serverInfo.maxPlayers || 0,
      queued:   serverInfo.queuedPlayers || 0,
      joined30m: popLog30m.joined,
      left30m:   popLog30m.left,
      history:   popHist,
    },
    botTag:      client.user?.tag || 'Not connected',
    lastUpdate:  Date.now(),
  };
}

// Push state update to all dashboard clients
function pushLiveState() {
  wsBroadcast({ type: 'stateUpdate', data: buildLiveState() });
}

// ─── ALERT HELPERS ───────────────────────────────────────────────────────────
function pushAlert(alert) {
  liveState.alerts.unshift({ ...alert, time: Date.now() });
  if (liveState.alerts.length > 100) liveState.alerts.pop();
  wsBroadcast({ type: 'alert', data: alert });
}

function addChatMsg(name, text) {
  liveState.chatMessages.unshift({ name, text, time: Date.now() });
  if (liveState.chatMessages.length > 50) liveState.chatMessages.pop();
  wsBroadcast({ type: 'chatMessage', data: { name, text, time: Date.now() } });
}

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
    const guild   = await client.guilds.fetch(C.discord.guildId);
    const channel = await guild.channels.fetch(C.voice.channelId);
    if (!channel.isVoiceBased()) return null;
    voiceConn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
    voiceConn.subscribe(audioPlayer);
    return voiceConn;
  } catch (e) { console.error('[Voice] Join failed:', e.message); return null; }
}

async function speakTTS(text) { ttsQueue.push(text); if (!ttsPlaying) processTTSQueue(); }

async function processTTSQueue() {
  if (!ttsQueue.length) {
    ttsPlaying = false;
    if (C.voice.autoLeave) setTimeout(() => { if (voiceConn) { voiceConn.destroy(); voiceConn = null; } }, 30000);
    return;
  }
  ttsPlaying = true;
  const text = ttsQueue.shift();
  const conn = await ensureVoiceJoined();
  if (!conn) { ttsPlaying = false; return; }
  try {
    const tmp = '/tmp/rl_tts_' + Date.now() + '.wav';
    try { execSync(`espeak "${text.replace(/"/g,"'")}" -w ${tmp} --rate=140 2>/dev/null`); } catch {}
    if (fs.existsSync(tmp)) {
      const res = createAudioResource(tmp);
      audioPlayer.play(res);
      audioPlayer.once(AudioPlayerStatus.Idle, () => { try { fs.unlinkSync(tmp); } catch {} setTimeout(processTTSQueue, 500); });
    } else { ttsPlaying = false; }
  } catch (e) { console.error('[TTS]', e.message); ttsPlaying = false; setTimeout(processTTSQueue, 500); }
}

function buildTTSMsg(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] || k);
}

// ─── RUST+ CLIENT ─────────────────────────────────────────────────────────────
function createRustClient() {
  if (!C.rust.ip || !C.rust.steamId || !C.rust.token) {
    console.warn('[Rust+] Missing credentials — set RUST_IP, STEAM_ID, PLAYER_TOKEN in Railway env vars');
    return;
  }

  rustplus = new RustPlus(C.rust.ip, C.rust.port, C.rust.steamId, C.rust.token);

  rustplus.on('connected', async () => {
    console.log('[Rust+] Connected!');
    liveState.connected = true;
    await refreshServerInfo();
    await refreshTeamInfo();
    sendTo('log', { embeds: [embed('🔗 Rust Link Connected', `Now monitoring **${serverInfo.name || C.rust.ip}**`, 0x3DDC84)] });
    startPopTracker();
    scheduleWipeReminders();
    await updateSwitchPanel();
    pushLiveState(); // push full state to all dashboard clients
    pushAlert({ type: 'info', icon: '🔗', title: 'Bot Connected', detail: `Connected to ${serverInfo.name || C.rust.ip}` });
  });

  rustplus.on('disconnected', () => {
    console.warn('[Rust+] Disconnected — retrying in 15s');
    liveState.connected = false;
    pushLiveState();
    pushAlert({ type: 'info', icon: '🔌', title: 'Disconnected', detail: 'Reconnecting in 15s…' });
    sendTo('log', { embeds: [embed('🔌 Disconnected', 'Reconnecting in 15 seconds…', 0xCE422B)] });
    setTimeout(() => rustplus.connect(), 15000);
  });

  rustplus.on('message', async (msg) => {
    if (!msg.broadcast) return;
    const b = msg.broadcast;

    // ── TEAM CHAT
    if (b.teamMessage && C.alerts.teamChat) {
      const tm   = b.teamMessage.message;
      const text = tm.message.trim();
      const name = tm.name;

      addChatMsg(name, text);

      const prefix = process.env.CMD_PREFIX || '!';
      if (text.startsWith(prefix)) {
        await handleIngameCommand(text.slice(prefix.length).trim(), name);
        return;
      }

      sendTo('teamChat', {
        embeds: [new EmbedBuilder().setColor(0x5865F2)
          .setAuthor({ name: `💬 ${name}` })
          .setDescription(text)
          .setFooter({ text: `Grid: ${tm.targetName || '?'} · In-game Team Chat` })
          .setTimestamp()]
      });
    }

    // ── ENTITY CHANGED (switches + alarms)
    if (b.entityChanged) {
      const ec    = b.entityChanged;
      const idStr = String(ec.entityId);
      const val   = ec.payload?.value;

      if (knownSwitches.has(idStr)) {
        entityStates[idStr] = val;
        await updateSwitchPanel();
        pushLiveState(); // dashboard updates switch states in real time
        wsBroadcast({ type: 'switchToggled', entityId: idStr, value: val });
      }

      if (knownAlarms.has(idStr) && val && C.alerts.alarms) {
        const alm = knownAlarms.get(idStr);
        await handleAlarmAlert(idStr, alm, ec);
      }
    }

    // ── TEAM CHANGED
    if (b.teamChanged) {
      await handleTeamChanged(b.teamChanged);
    }
  });

  rustplus.connect();
}

// ─── ALARM ALERT ─────────────────────────────────────────────────────────────
async function handleAlarmAlert(entityId, alm, ec) {
  const ping = alm.roleId ? `<@&${alm.roleId}> ` : getPingForKeyword('ALARM');
  const grid = ec.payload?.targetName || 'Unknown Grid';

  sendTo('alarms', {
    content: ping || null,
    embeds: [new EmbedBuilder().setColor(0xF5A623).setTitle('🔔 Smart Alarm Triggered')
      .setDescription(`${ping}**${alm.name}** has been activated!`)
      .addFields({ name: 'Grid', value: grid, inline: true }, { name: 'Entity ID', value: entityId, inline: true })
      .setTimestamp()]
  });

  pushAlert({ type: 'alarm', icon: '🔔', title: `Alarm: ${alm.name}`, detail: `Triggered at grid ${grid}` });

  if (alm.voice && C.alerts.voiceAlarms) {
    await speakTTS(buildTTSMsg(C.voice.msgTemplate, { alarm_name: alm.name, grid, time: new Date().toLocaleTimeString(), server: serverInfo.name || C.rust.ip }));
  }
  if (alm.teamChat && C.alerts.alarmInChat) {
    try { await rustplus.sendTeamMessage(`🔔 ALARM: ${alm.name} triggered at ${grid}!`); } catch {}
  }
}

// ─── TEAM CHANGED ─────────────────────────────────────────────────────────────
async function handleTeamChanged(tc) {
  const newTeam = await refreshTeamInfo();
  if (!newTeam?.members) return;

  newTeam.members.forEach(member => {
    const prev = lastTeamMembers[member.steamId];

    if (prev && member.isAlive === false && prev.isAlive === true && C.alerts.deaths) {
      const grid = getGrid(member.x, member.y);
      sendTo('deaths', {
        content: getPingForKeyword('DEATH') || null,
        embeds: [new EmbedBuilder().setColor(0xFF3B30).setTitle('💀 Team Member Died')
          .setDescription(`${getPingForKeyword('DEATH')}**${member.name}** was killed!`)
          .addFields({ name: 'Grid', value: grid, inline: true })
          .setTimestamp()]
      });
      pushAlert({ type: 'death', icon: '💀', title: `${member.name} died`, detail: `Killed at Grid ${grid}` });
      if (C.alerts.deathInChat) { try { rustplus.sendTeamMessage(`💀 ${member.name} died at ${grid}!`); } catch {} }
      if (C.alerts.voiceDeaths) speakTTS(`${member.name} has been killed at grid ${grid}!`);
    }

    if (prev && member.isOnline !== prev.isOnline && C.alerts.playerJoin) {
      const action = member.isOnline ? 'came online' : 'went offline';
      sendTo('log', { embeds: [embed(member.isOnline ? '🟢 Teammate Online' : '⚫ Teammate Offline', `**${member.name}** ${action}`, member.isOnline ? 0x3DDC84 : 0x666666)] });
    }

    lastTeamMembers[member.steamId] = member;
  });

  pushLiveState(); // team state updated — push to dashboard
}

function getGrid(x, y) {
  if (!x && !y) return '?';
  const mapSize = serverInfo.mapSize || 4500;
  const col = String.fromCharCode(65 + Math.floor(x / (mapSize / 26)));
  const row = Math.floor(y / (mapSize / 26)) + 1;
  return `${col}${row}`;
}

// ─── RAID ALERT ───────────────────────────────────────────────────────────────
async function handleRaidAlert(detail) {
  if (!C.alerts.raids) return;
  const ping = getPingForKeyword('RAID');
  sendTo('raids', {
    content: ping || null,
    embeds: [new EmbedBuilder().setColor(0xCE422B).setTitle('💥 RAID ALERT')
      .setDescription(`${ping}Explosions detected near your base!`)
      .addFields({ name: 'Detail', value: detail || 'Explosion detected', inline: true })
      .setTimestamp().setFooter({ text: serverInfo.name || C.rust.ip })]
  });
  pushAlert({ type: 'raid', icon: '💥', title: 'RAID ALERT', detail: detail || 'Explosions detected near base!' });
  if (C.alerts.voiceRaids) speakTTS('RAID ALERT! Explosions detected near your base!');
}

// ─── IN-GAME COMMANDS ─────────────────────────────────────────────────────────
async function handleIngameCommand(cmd, senderName) {
  const parts   = cmd.split(' ');
  const command = parts[0].toLowerCase();
  const args    = parts.slice(1);
  try {
    switch (command) {
      case 'pop': {
        const info = await refreshServerInfo();
        await rustplus.sendTeamMessage(`📊 Players: ${info.players}/${info.maxPlayers} | Queue: ${info.queuedPlayers||0} | Last 30m: +${popLog30m.joined} joined · -${popLog30m.left} left`);
        break;
      }
      case 'time': {
        const info = await refreshServerInfo();
        const t = info.time || '??:??';
        const [h] = t.split(':').map(Number);
        const isDay = h >= 6 && h < 20;
        await rustplus.sendTeamMessage(`${isDay?'☀️':'🌙'} In-game: ${t} | ${isDay?'Day':'Night'} | ${isDay?'Night':'Day'} in ~${Math.round((isDay?20-h:24-h+6)*60)}min`);
        break;
      }
      case 'wipe': {
        if (C.wipeDate) {
          const diff = C.wipeDate - Date.now();
          const d = Math.floor(diff/86400000), h = Math.floor((diff%86400000)/3600000), m = Math.floor((diff%3600000)/60000);
          await rustplus.sendTeamMessage(`📅 Next wipe: ${d}d ${h}h ${m}m`);
        } else { await rustplus.sendTeamMessage('📅 Wipe date not set.'); }
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
        const lines = team.members.map(m => `${m.isOnline?'●':'○'} ${m.name} ${m.isOnline?getGrid(m.x,m.y):'offline'}${m.isOnline&&m.isAlive?` ${Math.round(m.health||0)}HP`:''}`);
        await rustplus.sendTeamMessage('👥 Team:\n' + lines.join('\n'));
        break;
      }
      case 'sw': case 'switch': {
        if (!args[0]) { await rustplus.sendTeamMessage('Usage: !sw [name]'); break; }
        const target = args.join(' ').toLowerCase();
        let found = null;
        for (const [id, sw] of knownSwitches) { if (sw.name.toLowerCase().includes(target)) { found = {id,sw}; break; } }
        if (!found) { await rustplus.sendTeamMessage(`⚡ Switch not found: ${args.join(' ')}`); break; }
        const newVal = !(entityStates[found.id] ?? false);
        await setEntityValue(found.id, newVal);
        await rustplus.sendTeamMessage(`⚡ ${found.sw.name}: ${newVal?'ON':'OFF'}`);
        pushLiveState();
        break;
      }
      case 'switches': {
        const lines = [];
        for (const [id, sw] of knownSwitches) lines.push(`${entityStates[id]?'⚡':'○'} ${sw.name}: ${entityStates[id]?'ON':'OFF'}`);
        await rustplus.sendTeamMessage('⚡ Switches:\n' + (lines.join('\n')||'None configured'));
        break;
      }
      case 'ping': {
        await rustplus.sendTeamMessage(`🤖 Rust Link: Online | Discord: Connected | Latency: ${client.ws.ping}ms`);
        break;
      }
    }
  } catch (e) { console.error('[Cmd]', command, e.message); }
}

// ─── SET ENTITY ───────────────────────────────────────────────────────────────
async function setEntityValue(entityId, value) {
  try { await rustplus.setEntityValue(entityId, value); entityStates[entityId] = value; return true; }
  catch (e) { console.error('[setEntity]', e.message); return false; }
}

// ─── SWITCH PANEL (Discord) ───────────────────────────────────────────────────
async function updateSwitchPanel() {
  if (!C.discord.channels.switches) return;
  try {
    const ch = await client.channels.fetch(C.discord.channels.switches);
    const panelEmbed = new EmbedBuilder()
      .setColor(0xCE422B)
      .setTitle('⚡ Smart Switch Control Panel')
      .setDescription('Click buttons below to toggle switches in-game.')
      .setTimestamp()
      .setFooter({ text: `${Object.values(entityStates).filter(Boolean).length} ON · Updated` });

    for (const [id, sw] of knownSwitches) {
      if (!sw.inPanel) continue;
      panelEmbed.addFields({ name: `${sw.icon||'⚡'} ${sw.name}`, value: entityStates[id]?'🟢 ON':'⚫ OFF', inline: true });
    }

    const rows = [];
    let currentRow = new ActionRowBuilder();
    let count = 0;
    for (const [id, sw] of knownSwitches) {
      if (!sw.inPanel) continue;
      if (count > 0 && count % 5 === 0) { rows.push(currentRow); currentRow = new ActionRowBuilder(); }
      const on = entityStates[id] ?? false;
      currentRow.addComponents(new ButtonBuilder().setCustomId(`sw_toggle_${id}`).setLabel(`${on?'⚡':'○'} ${sw.name}`).setStyle(on?ButtonStyle.Success:ButtonStyle.Secondary));
      count++;
      if (rows.length >= 4) break;
    }
    if (count % 5 !== 0 || count === 0) rows.push(currentRow);
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sw_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sw_all_on').setLabel('⚡ All ON').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sw_all_off').setLabel('⬛ All OFF').setStyle(ButtonStyle.Secondary),
    ));

    const payload = { embeds: [panelEmbed], components: rows };
    if (switchPanelMsgId) {
      try { const msg = await ch.messages.fetch(switchPanelMsgId); await msg.edit(payload); return; }
      catch { switchPanelMsgId = null; }
    }
    const msg = await ch.send(payload);
    switchPanelMsgId = msg.id;
  } catch (e) { console.error('[Panel]', e.message); }
}

// ─── POP TRACKER ──────────────────────────────────────────────────────────────
function startPopTracker() {
  setInterval(async () => {
    try {
      const info = await refreshServerInfo();
      const count = info.players || 0;
      const now   = Date.now();
      popHistory.push({ time: now, count });
      const cutoff = now - 30 * 60 * 1000;
      popHistory = popHistory.filter(p => p.time >= cutoff);
      if (prevPopCount > 0) {
        if (count > prevPopCount) popLog30m.joined += count - prevPopCount;
        else if (count < prevPopCount) popLog30m.left += prevPopCount - count;
      }
      prevPopCount = count;
      pushLiveState(); // push updated pop stats to dashboard
    } catch {}
  }, 60000);
  setInterval(() => { popLog30m = { joined: 0, left: 0 }; }, 30 * 60 * 1000);
}

// ─── WIPE REMINDERS ───────────────────────────────────────────────────────────
function scheduleWipeReminders() {
  if (!C.wipeDate || !C.alerts.wipe) return;
  [{ before: 86400000, label: '24 hours' }, { before: 3600000, label: '1 hour' }, { before: 900000, label: '15 minutes' }]
    .forEach(({ before, label }) => {
      const delay = C.wipeDate.getTime() - before - Date.now();
      if (delay > 0) setTimeout(() => {
        sendTo('wipe', { content: getPingForKeyword('WIPE')||null, embeds: [embed('📅 Wipe Reminder', `**Wipes in ${label}!**`, 0xF5A623)] });
        pushAlert({ type: 'event', icon: '📅', title: `Wipe in ${label}`, detail: 'Server is about to wipe!' });
      }, delay);
    });
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────
async function refreshServerInfo() {
  try {
    const r = await rustplus.getInfo();
    serverInfo = r?.response?.info || {};
    return serverInfo;
  } catch { return serverInfo; }
}

async function refreshTeamInfo() {
  try {
    const r = await rustplus.getTeamInfo();
    teamInfo = r?.response?.teamInfo || {};
    return teamInfo;
  } catch { return teamInfo; }
}

// Push state to dashboard every 30 seconds as a heartbeat
setInterval(() => {
  if (liveState.connected) pushLiveState();
}, 30000);

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder().setName('server').setDescription('📊 Server info & population'),
  new SlashCommandBuilder().setName('team').setDescription('👥 Team members + HP + grid'),
  new SlashCommandBuilder().setName('switches').setDescription('⚡ List all smart switches'),
  new SlashCommandBuilder().setName('switch').setDescription('⚡ Toggle a smart switch')
    .addStringOption(o => o.setName('name').setDescription('Switch name or entity ID').setRequired(true))
    .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('alarms').setDescription('🔔 List smart alarms'),
  new SlashCommandBuilder().setName('wipe').setDescription('📅 Time until next wipe'),
  new SlashCommandBuilder().setName('map').setDescription('🗺 Server map link'),
  new SlashCommandBuilder().setName('pop').setDescription('📊 Current population + 30m trend'),
  new SlashCommandBuilder().setName('time').setDescription('🕐 In-game time + day/night'),
  new SlashCommandBuilder().setName('voicejoin').setDescription('🔊 Bot joins voice channel'),
  new SlashCommandBuilder().setName('voiceleave').setDescription('🔇 Bot leaves voice channel'),
  new SlashCommandBuilder().setName('testalert').setDescription('🧪 Test an alert type')
    .addStringOption(o => o.setName('type').setDescription('Alert type').setRequired(true)
      .addChoices({name:'raid',value:'raid'},{name:'alarm',value:'alarm'},{name:'death',value:'death'},{name:'tts',value:'tts'})),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(C.discord.token);
  try {
    await rest.put(Routes.applicationGuildCommands(C.discord.clientId, C.discord.guildId), { body: slashCommands });
    console.log('[Discord] Slash commands registered');
  } catch (e) { console.error('[Discord] Command register failed:', e.message); }
}

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const [, action, entityId] = interaction.customId.split('_');
    await interaction.deferUpdate();
    if (action === 'toggle' && entityId) {
      const ok = await setEntityValue(entityId, !(entityStates[entityId] ?? false));
      if (ok) {
        const sw = knownSwitches.get(entityId);
        sendTo('log', { embeds: [embed(`⚡ Switch ${entityStates[entityId]?'ON':'OFF'}`, `**${sw?.name||entityId}** toggled by **${interaction.user.username}**`, entityStates[entityId]?0x3DDC84:0x888888)] });
        pushLiveState();
      }
      await updateSwitchPanel();
    }
    if (action === 'refresh') await updateSwitchPanel();
    if (action === 'all') {
      const val = entityId === 'on';
      for (const [id] of knownSwitches) if (knownSwitches.get(id).inPanel) await setEntityValue(id, val);
      pushLiveState();
      await updateSwitchPanel();
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: false });
  const cmd = interaction.commandName;

  if (cmd === 'server') {
    const info = await refreshServerInfo();
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xCE422B).setTitle(`🎮 ${info.name||'Unknown Server'}`)
      .addFields({name:'Players',value:`${info.players}/${info.maxPlayers}`,inline:true},{name:'Queued',value:`${info.queuedPlayers||0}`,inline:true},{name:'Map',value:`${info.mapSize||'?'} · Seed: ${info.seed||'?'}`,inline:true},{name:'Wipe',value:info.wipeTime?`<t:${info.wipeTime}:R>`:'Unknown',inline:true}).setTimestamp()] });
  }
  if (cmd === 'pop') {
    const info = await refreshServerInfo();
    return interaction.editReply({ embeds: [embed('📊 Population', `**${info.players}/${info.maxPlayers}** online · **${info.queuedPlayers||0}** queued`, 0x00D4FF, [{name:'30m Trend',value:`+${popLog30m.joined} joined · -${popLog30m.left} left`,inline:true}])] });
  }
  if (cmd === 'time') {
    const info = await refreshServerInfo();
    const t = info.time||'??:??'; const [h] = t.split(':').map(Number); const isDay = h>=6&&h<20;
    return interaction.editReply({ embeds: [embed(`${isDay?'☀️':'🌙'} In-Game Time: ${t}`, `**${isDay?'Daytime':'Nighttime'}** · ${isDay?'Night':'Day'} in ~${Math.round((isDay?20-h:24-h+6)*60)}min`, 0xF5A623)] });
  }
  if (cmd === 'team') {
    const team = await refreshTeamInfo();
    if (!team?.members) return interaction.editReply({ embeds: [embed('❌ Error','Could not fetch team info',0xCE422B)] });
    const e = new EmbedBuilder().setColor(0x5865F2).setTitle('👥 Team Members').setTimestamp();
    team.members.forEach(m => e.addFields({ name: (m.isOnline?'🟢 ':'⚫ ')+m.name, value: `HP: ${m.isOnline&&m.isAlive?Math.round(m.health)+'HP':m.isOnline?'Dead':'—'}\nGrid: ${m.isOnline?getGrid(m.x,m.y):'—'}`, inline: true }));
    return interaction.editReply({ embeds: [e] });
  }
  if (cmd === 'switch') {
    const nameOrId = interaction.options.getString('name');
    const wantOn   = interaction.options.getString('state') === 'on';
    let entityId = null;
    for (const [id, sw] of knownSwitches) { if (sw.name.toLowerCase().includes(nameOrId.toLowerCase())||id===nameOrId) { entityId=id; break; } }
    if (!entityId) return interaction.editReply({ embeds: [embed('❌ Not Found', `No switch matching "${nameOrId}"`, 0xCE422B)] });
    const ok = await setEntityValue(entityId, wantOn);
    await updateSwitchPanel(); pushLiveState();
    return interaction.editReply({ embeds: [embed(wantOn?'⚡ Switch ON':'⬛ Switch OFF', `**${knownSwitches.get(entityId)?.name||entityId}** turned ${wantOn?'ON':'OFF'}`, wantOn?0x3DDC84:0x888888)] });
  }
  if (cmd === 'switches') {
    const e = new EmbedBuilder().setColor(0xCE422B).setTitle('⚡ Smart Switches');
    for (const [id, sw] of knownSwitches) e.addFields({ name: `${sw.icon||'⚡'} ${sw.name}`, value: `${entityStates[id]?'🟢 ON':'⚫ OFF'}\nID: \`${id}\``, inline: true });
    if (!knownSwitches.size) e.setDescription('No switches configured.');
    return interaction.editReply({ embeds: [e] });
  }
  if (cmd === 'alarms') {
    const e = new EmbedBuilder().setColor(0xF5A623).setTitle('🔔 Smart Alarms');
    for (const [id, alm] of knownAlarms) e.addFields({ name: alm.name, value: `ID: \`${id}\`\nVoice: ${alm.voice?'✅':'❌'} · Chat: ${alm.teamChat?'✅':'❌'}`, inline: true });
    if (!knownAlarms.size) e.setDescription('No alarms configured.');
    return interaction.editReply({ embeds: [e] });
  }
  if (cmd === 'wipe') {
    const info = await refreshServerInfo();
    const wipeTs = C.wipeDate ? Math.floor(C.wipeDate.getTime()/1000) : info.wipeTime;
    if (!wipeTs) return interaction.editReply({ embeds: [embed('📅 Wipe','No wipe date configured.',0xF5A623)] });
    return interaction.editReply({ embeds: [embed('📅 Next Wipe',`Wipe is <t:${wipeTs}:R> (<t:${wipeTs}:F>)`,0xF5A623)] });
  }
  if (cmd === 'map') {
    const info = await refreshServerInfo();
    return interaction.editReply({ embeds: [embed('🗺 Server Map',`[View on rustmaps.com](https://rustmaps.com/map/${info.mapSize}/${info.seed})`,0x3DDC84)] });
  }
  if (cmd === 'voicejoin') { await ensureVoiceJoined(); return interaction.editReply({ embeds: [embed('🔊 Joined Voice','Bot is now in voice channel.',0x3DDC84)] }); }
  if (cmd === 'voiceleave') { if (voiceConn) { voiceConn.destroy(); voiceConn=null; } return interaction.editReply({ embeds: [embed('🔇 Left Voice','Bot disconnected.',0x888888)] }); }
  if (cmd === 'testalert') {
    const type = interaction.options.getString('type');
    await interaction.editReply({ embeds: [embed('🧪 Test Alert',`Firing test: **${type}**`,0xF5A623)] });
    switch (type) {
      case 'raid':  await handleRaidAlert('TEST — Rocket fired nearby (simulated)'); break;
      case 'alarm': for (const [id, alm] of knownAlarms) { await handleAlarmAlert(id, alm, {payload:{targetName:'F5'}}); break; } break;
      case 'death': sendTo('deaths',{embeds:[embed('💀 TEST Death','**TestPlayer** killed at Grid F5',0xFF3B30)]}); pushAlert({type:'death',icon:'💀',title:'TEST: TestPlayer died',detail:'Killed at Grid F5 (test)'}); break;
      case 'tts':   await speakTTS('This is a test of the Rust Link voice alert system.'); break;
    }
  }
});

// ─── DISCORD READY ────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  liveState.botReady = true;
  await registerCommands();
  createRustClient();
  wsBroadcast({ type: 'botReady', tag: client.user.tag });
  console.log('[RustLink] All systems GO');
});

// ─── START HTTP + WS SERVER ───────────────────────────────────────────────────
httpServer.listen(C.wsPort, () => {
  console.log(`[WS] WebSocket + HTTP server listening on port ${C.wsPort}`);
});

// ─── START DISCORD ────────────────────────────────────────────────────────────
client.login(C.discord.token).catch(err => {
  console.error('[Discord] Login failed:', err.message);
  process.exit(1);
});
