'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const R = require('./rules');
const E = require('./engine');
const A = require('./actions');
const M = require('./master');
const V = require('./views');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const MASTER_PIN = String(process.env.MASTER_PIN || Math.floor(1000 + Math.random() * 9000));

/* ------------------------------------------------------- состояние игры */

let state = E.createState();
const loaded = store.load();
if (loaded && loaded.players) {
  try {
    // мягкая миграция: дополняем отсутствующие поля значениями по умолчанию
    const fresh = E.createState();
    state = Object.assign(fresh, loaded);
    state.config = Object.assign(R.defaultConfig(), loaded.config || {});
    state.config.marketRates = Object.assign(R.defaultConfig().marketRates, (loaded.config || {}).marketRates || {});
    state.config.marketQuotas = Object.assign(R.defaultConfig().marketQuotas, (loaded.config || {}).marketQuotas || {});
    // старые сохранения: булевы флаги сезонов заменены списками сезонов
    if (!Array.isArray(state.config.travelSeasons)) state.config.travelSeasons = R.defaultConfig().travelSeasons;
    if (!Array.isArray(state.config.marketOpenSeasons)) state.config.marketOpenSeasons = R.defaultConfig().marketOpenSeasons;
    delete state.config.travelOnlyInWinter;
    delete state.config.marketClosedInWinter;
    delete state.config.scoring;
    state.stateCrops = Object.assign(R.emptyCrops(), loaded.stateCrops || {});
    state.market = Object.assign({ quotaUsed: R.emptyCrops() }, loaded.market || {});
    state.boyarDismiss = loaded.boyarDismiss || { seasonKey: null, count: 0 };
    for (const p of Object.values(state.players)) {
      p.connected = false;
      p.sanctions = Object.assign({ noBoat: false, noTrade: false, noFarm: false, notes: '' }, p.sanctions || {});
      p.crops = Object.assign(R.emptyCrops(), p.crops || {});
      p.notifications = p.notifications || [];
      p.tax = p.tax || { year: state.time.year, cropsPaid: 0, moneyPaid: 0, lastSeasonKey: null };
    }
    console.log(`[store] Загружена сохранённая сессия: игроков ${Object.keys(state.players).length}, фаза ${state.phase}`);
  } catch (e) {
    console.error('[store] сохранение повреждено, начинаем с нуля:', e.message);
    state = E.createState();
  }
}

/* ------------------------------------------------------------ сеть/адреса */

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push({ name, address: iface.address });
    }
  }
  // Виртуальные адаптеры (VirtualBox, VMware, VPN, WSL и т.п.) уводим в конец списка:
  // игроки должны подключаться по адресу настоящего Wi-Fi или хот-спота.
  const VIRTUAL = /virtual|vmware|hyper-?v|vethernet|radmin|loopback|tap-|zerotier|tailscale|vmvapp|vpn|docker|wsl|bluetooth/i;
  const WIRELESS = /wi-?fi|wireless|wlan|беспровод|hotspot|хот-?спот/i;

  const score = (a) => {
    let s = 5;
    if (a.address.startsWith('192.168.')) s = 0;
    else if (a.address.startsWith('10.')) s = 1;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) s = 6;
    if (a.address.startsWith('169.254.')) s += 50;
    if (a.address.startsWith('192.168.56.')) s += 30; // типовая сеть VirtualBox host-only
    if (VIRTUAL.test(a.name)) s += 40;
    if (WIRELESS.test(a.name)) s -= 3;
    else if (/ethernet|локальн/i.test(a.name)) s -= 2;
    return s;
  };
  return out.map((a) => ({ ...a, virtual: VIRTUAL.test(a.name) || a.address.startsWith('192.168.56.') })).sort((a, b) => score(a) - score(b));
}

/* ------------------------------------------------------------- HTTP */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.get('/api/info', async (req, res) => {
  const addrs = lanAddresses();
  const urls = addrs.map((a) => ({ ...a, url: `http://${a.address}:${PORT}/` }));
  const primary = urls[0] ? urls[0].url : `http://localhost:${PORT}/`;
  let qr = null;
  try {
    qr = await QRCode.toDataURL(primary, { width: 512, margin: 1, errorCorrectionLevel: 'M' });
  } catch (e) {
    qr = null;
  }
  res.json({ port: PORT, urls, primary, qr, phase: state.phase, players: Object.keys(state.players).length });
});

app.get('/api/qr', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).send('url required');
  try {
    const png = await QRCode.toBuffer(url, { width: 700, margin: 1, type: 'png' });
    res.type('png').send(png);
  } catch (e) {
    res.status(500).send('qr error');
  }
});

app.get('/api/save', (req, res) => {
  store.saveNow(state);
  res.json({ ok: true, file: store.SAVE_FILE });
});

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="gosudarstvo-save.json"');
  res.json(state);
});

const server = http.createServer(app);

/* --------------------------------------------------------------- WS */

const wss = new WebSocketServer({ server, path: '/ws' });

/** socket -> { kind: 'player'|'master'|'anon', playerId } */
const clients = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      /* ignore */
    }
  }
}

function viewFor(meta) {
  if (meta.kind === 'master') return V.buildMasterView(state);
  if (meta.kind === 'player') return V.buildPlayerView(state, meta.playerId);
  return { type: 'lobby_info', phase: state.phase, players: E.playerList(state).map((p) => ({ id: p.id, name: p.name, connected: p.connected })) };
}

let broadcastScheduled = false;
function markDirty() {
  store.saveDebounced(state);
  if (broadcastScheduled) return;
  broadcastScheduled = true;
  setTimeout(() => {
    broadcastScheduled = false;
    broadcast();
  }, 40);
}

function broadcast() {
  for (const [ws, meta] of clients.entries()) {
    if (meta.kind === 'player' && !state.players[meta.playerId]) {
      send(ws, { type: 'kicked' });
      meta.kind = 'anon';
      meta.playerId = null;
      continue;
    }
    send(ws, viewFor(meta));
  }
}

function timeSync() {
  const t = V.timeView(state);
  const payload = { type: 'time', time: t, phase: state.phase };
  for (const ws of clients.keys()) send(ws, payload);
}

wss.on('connection', (ws) => {
  const meta = { kind: 'anon', playerId: null };
  clients.set(ws, meta);
  send(ws, { type: 'hello', phase: state.phase, needName: true });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'auth': {
        const token = String(msg.token || '');
        const player = E.playerList(state).find((p) => p.token === token);
        if (!player) {
          send(ws, { type: 'auth_failed' });
          return;
        }
        meta.kind = 'player';
        meta.playerId = player.id;
        player.connected = true;
        player.lastSeen = Date.now();
        send(ws, { type: 'welcome', playerId: player.id, token: player.token, name: player.name });
        markDirty();
        return;
      }
      case 'join': {
        const name = String(msg.name || '').trim().slice(0, 24);
        if (!name) {
          send(ws, { type: 'error', error: 'Введите имя' });
          return;
        }
        const dup = E.playerList(state).find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (dup) {
          send(ws, { type: 'error', error: 'Такое имя уже занято, выберите другое' });
          return;
        }
        if (state.phase !== 'lobby' && !msg.force) {
          send(ws, { type: 'error', error: 'Игра уже началась. Попросите мастера добавить вас.' });
          return;
        }
        const player = E.createPlayer(state, name);
        meta.kind = 'player';
        meta.playerId = player.id;
        E.pushFeed(state, `${player.name} подключился к сессии.`, 'lobby');
        send(ws, { type: 'welcome', playerId: player.id, token: player.token, name: player.name });
        markDirty();
        return;
      }
      case 'auth_master': {
        if (String(msg.pin || '') !== MASTER_PIN) {
          send(ws, { type: 'master_auth_failed' });
          return;
        }
        meta.kind = 'master';
        meta.playerId = null;
        send(ws, { type: 'master_welcome', pin: MASTER_PIN });
        send(ws, V.buildMasterView(state));
        return;
      }
      case 'action': {
        if (meta.kind !== 'player') {
          send(ws, { type: 'error', error: 'Не авторизованы' });
          return;
        }
        const player = state.players[meta.playerId];
        if (!player) {
          send(ws, { type: 'kicked' });
          return;
        }
        player.lastSeen = Date.now();
        const res = A.handlePlayerAction(state, player, msg.action, msg.data);
        if (res.ok && !res.silent) send(ws, { type: 'toast', kind: 'ok', message: res.message || 'Готово' });
        if (!res.ok) send(ws, { type: 'toast', kind: 'error', message: res.error });
        markDirty();
        return;
      }
      case 'master_action': {
        if (meta.kind !== 'master') {
          send(ws, { type: 'error', error: 'Нужна авторизация мастера' });
          return;
        }
        const res = M.handleMasterAction(state, msg.action, msg.data);
        if (res.ok) send(ws, { type: 'toast', kind: 'ok', message: res.message || 'Готово' });
        else send(ws, { type: 'toast', kind: 'error', message: res.error });
        markDirty();
        return;
      }
      case 'master_backup': {
        if (meta.kind !== 'master') return;
        const ok = store.backup(state);
        send(ws, { type: 'toast', kind: ok ? 'ok' : 'error', message: ok ? 'Бэкап создан в папке data' : 'Не удалось создать бэкап' });
        return;
      }
      case 'ping': {
        send(ws, { type: 'pong' });
        return;
      }
      default:
        send(ws, { type: 'error', error: `Неизвестный тип сообщения: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    const m = clients.get(ws);
    if (m && m.kind === 'player' && state.players[m.playerId]) {
      state.players[m.playerId].connected = false;
      state.players[m.playerId].lastSeen = Date.now();
      markDirty();
    }
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

/* -------------------------------------------------------------- цикл */

setInterval(() => {
  const changed = E.tick(state);
  if (changed) markDirty();
  timeSync();
}, 1000);

setInterval(() => store.saveNow(state), 30000);

process.on('SIGINT', () => {
  store.saveNow(state);
  console.log('\nСессия сохранена. Выход.');
  process.exit(0);
});

/* -------------------------------------------------------------- старт */

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log('  ИГРА «ГОСУДАРСТВО» — сервер запущен');
  console.log(line);
  console.log('  Ссылка для игроков (открыть на телефонах в той же сети):');
  if (addrs.length) {
    for (const a of addrs) console.log(`     http://${a.address}:${PORT}/     [${a.name}]`);
  } else {
    console.log('     сетевые адреса не найдены — проверьте подключение к Wi-Fi/точке доступа');
  }
  console.log(`\n  Панель мастера (на этом ноутбуке):  http://localhost:${PORT}/master`);
  console.log(`  PIN мастера:  ${MASTER_PIN}`);
  console.log(`\n  QR-код для подключения открывается в панели мастера (вкладка «Подключение»).`);
  console.log(`${line}\n`);
});
