'use strict';

const crypto = require('crypto');
const R = require('./rules');

const MAX_LOG = 500;
const MAX_FEED = 200;
const MAX_NOTIFICATIONS = 40;

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createState() {
  return {
    version: 1,
    phase: 'lobby', // lobby | running | finished
    createdAt: Date.now(),
    config: R.defaultConfig(),
    time: {
      year: 1,
      seasonIndex: 0,
      seasonEndsAt: null,
      remainingMs: null, // заполняется при паузе
      paused: false,
    },
    treasury: 0,
    stateCrops: R.emptyCrops(),
    players: {},
    plots: {},
    market: { quotaUsed: R.emptyCrops() },
    decrees: [],
    requests: [],
    election: null,
    overthrow: null,
    complaints: [],
    transactions: [],
    feed: [],
    results: null,
    nextPlotNum: 1,
  };
}

/* ------------------------------------------------------------------ игроки */

function createPlayer(state, name) {
  const id = uid('p');
  const player = {
    id,
    token: crypto.randomBytes(16).toString('hex'),
    name: String(name || '').trim().slice(0, 24) || 'Игрок',
    role: null,
    money: 0,
    crops: R.emptyCrops(),
    hasBoat: false,
    onMarket: false,
    lordId: null,
    connected: true,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    sanctions: { noBoat: false, noTrade: false, noFarm: false, notes: '' },
    tax: { year: 1, cropsPaid: 0, moneyPaid: 0, lastSeasonKey: null },
    protectedUntilYear: 0,
    notifications: [],
    locked: false, // мастер зафиксировал параметры
  };
  state.players[id] = player;
  return player;
}

function playerList(state) {
  return Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt);
}

function playersByRole(state, role) {
  return playerList(state).filter((p) => p.role === role);
}

function tsarOf(state) {
  return playersByRole(state, 'tsar')[0] || null;
}

function boyars(state) {
  return playersByRole(state, 'boyar');
}

function subordinates(state, feudalId) {
  return playerList(state).filter((p) => p.role === 'peasant' && p.lordId === feudalId);
}

/* ------------------------------------------------------------------ участки */

function createPlot(state, ownerId) {
  const id = `L${state.nextPlotNum++}`;
  state.plots[id] = { id, ownerId, planted: null, plantedYear: null };
  return state.plots[id];
}

function plotsOf(state, ownerId) {
  return Object.values(state.plots).filter((l) => l.ownerId === ownerId);
}

function totalCrops(crops) {
  return R.CROPS.reduce((s, c) => s + (Number(crops[c]) || 0), 0);
}

/* -------------------------------------------------------------- журналы/лог */

function seasonKey(state) {
  return `${state.time.year}:${state.time.seasonIndex}`;
}

function seasonName(state) {
  return R.SEASON_LABELS[R.SEASONS[state.time.seasonIndex]];
}

function pushFeed(state, text, kind = 'info') {
  state.feed.unshift({
    id: uid('f'),
    at: Date.now(),
    year: state.time.year,
    season: R.SEASONS[state.time.seasonIndex],
    kind,
    text,
  });
  if (state.feed.length > MAX_FEED) state.feed.length = MAX_FEED;
}

function pushTx(state, tx) {
  state.transactions.unshift({
    id: uid('t'),
    at: Date.now(),
    year: state.time.year,
    season: R.SEASONS[state.time.seasonIndex],
    ...tx,
  });
  if (state.transactions.length > MAX_LOG) state.transactions.length = MAX_LOG;
}

function notify(state, playerId, text, kind = 'info') {
  const p = state.players[playerId];
  if (!p) return;
  p.notifications.unshift({ id: uid('n'), at: Date.now(), text, kind, read: false });
  if (p.notifications.length > MAX_NOTIFICATIONS) p.notifications.length = MAX_NOTIFICATIONS;
}

/* ------------------------------------------------- распределение ролей и старт */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Присваивает роли случайным образом согласно counts. */
function assignRoles(state, counts) {
  const pool = shuffle(playerList(state).map((p) => p.id));
  const order = ['tsar', 'boyar', 'feudal', 'merchant', 'peasant'];
  let i = 0;
  for (const role of order) {
    const k = counts[role] || 0;
    for (let j = 0; j < k && i < pool.length; j++, i++) {
      state.players[pool[i]].role = role;
    }
  }
  // Все, кто не получил роль (несовпадение сумм) — крестьяне.
  for (; i < pool.length; i++) state.players[pool[i]].role = 'peasant';
}

/** Раздаёт стартовые наборы согласно ролям и конфигу. Стирает предыдущее имущество. */
function applyStartingSets(state) {
  const cfg = state.config;
  // очистка
  state.plots = {};
  state.nextPlotNum = 1;
  for (const p of playerList(state)) {
    p.money = 0;
    p.crops = R.emptyCrops();
    p.hasBoat = false;
    p.onMarket = false;
    p.lordId = null;
    p.tax = { year: 1, cropsPaid: 0, moneyPaid: 0, lastSeasonKey: null };
    p.protectedUntilYear = 0;
  }
  state.treasury = cfg.startTreasury;
  state.stateCrops = R.emptyCrops();

  const peasants = playersByRole(state, 'peasant');
  const feudals = playersByRole(state, 'feudal');

  for (const p of peasants) {
    p.money = cfg.startPeasantMoney;
    for (const c of R.CROPS) p.crops[c] = cfg.startPeasantCropEach;
    for (let i = 0; i < cfg.startPeasantPlots; i++) createPlot(state, p.id);
  }
  for (const f of feudals) f.money = cfg.startFeudalMoney;
  for (const b of playersByRole(state, 'boyar')) b.money = cfg.startBoyarMoney;
  for (const m of playersByRole(state, 'merchant')) {
    m.money = cfg.startMerchantMoney;
    m.hasBoat = true;
  }
  const tsar = tsarOf(state);
  if (tsar) {
    tsar.money = cfg.startTsarMoney;
    const n = Math.round(peasants.length * cfg.tsarPlotsPerPeasant);
    for (let i = 0; i < n; i++) createPlot(state, tsar.id);
  }

  // Крестьяне случайно распределяются по феодалам.
  if (feudals.length > 0) {
    const shuffled = shuffle(peasants.map((p) => p.id));
    shuffled.forEach((pid, idx) => {
      state.players[pid].lordId = feudals[idx % feudals.length].id;
    });
  }
}

/* ------------------------------------------------------------------- время */

function seasonDurationMs(state) {
  return Math.max(5, Number(state.config.seasonDurationSec) || 300) * 1000;
}

function startGame(state, counts) {
  assignRoles(state, counts);
  applyStartingSets(state);
  state.phase = 'running';
  state.time.year = 1;
  state.time.seasonIndex = 0;
  state.time.paused = false;
  state.time.remainingMs = null;
  state.time.seasonEndsAt = Date.now() + seasonDurationMs(state);
  state.market.quotaUsed = R.emptyCrops();
  state.results = null;
  state.requests = [];
  state.decrees = [];
  state.complaints = [];
  state.election = null;
  state.overthrow = null;
  state.transactions = [];
  state.feed = [];
  pushFeed(state, 'Игра началась. Год 1, Весна.', 'phase');
  for (const p of playerList(state)) {
    notify(state, p.id, `Игра началась. Ваша роль: ${R.ROLE_LABELS[p.role]}.`, 'phase');
  }
}

function pauseTime(state) {
  if (state.phase !== 'running' || state.time.paused) return;
  state.time.remainingMs = Math.max(0, (state.time.seasonEndsAt || Date.now()) - Date.now());
  state.time.paused = true;
  state.time.seasonEndsAt = null;
  pushFeed(state, 'Мастер поставил время на паузу.', 'phase');
}

function resumeTime(state) {
  if (state.phase !== 'running' || !state.time.paused) return;
  state.time.seasonEndsAt = Date.now() + (state.time.remainingMs ?? seasonDurationMs(state));
  state.time.remainingMs = null;
  state.time.paused = false;
  pushFeed(state, 'Время снова идёт.', 'phase');
}

/** Автоматический сбор урожая: каждая посадка даёт config.harvestYield культур. */
function runHarvest(state, { byMaster = false } = {}) {
  const yield_ = Math.max(0, Number(state.config.harvestYield) || 0);
  const perPlayer = {};
  for (const plot of Object.values(state.plots)) {
    if (!plot.planted) continue;
    const owner = state.players[plot.ownerId];
    if (!owner) continue;
    if (owner.role !== 'peasant') continue; // возделывать может только крестьянин
    owner.crops[plot.planted] = (owner.crops[plot.planted] || 0) + yield_;
    perPlayer[owner.id] = perPlayer[owner.id] || {};
    perPlayer[owner.id][plot.planted] = (perPlayer[owner.id][plot.planted] || 0) + yield_;
    plot.planted = null;
    plot.plantedYear = null;
  }
  let any = false;
  for (const [pid, gained] of Object.entries(perPlayer)) {
    any = true;
    const text = Object.entries(gained)
      .map(([c, n]) => `${R.CROP_LABELS[c]} +${n}`)
      .join(', ');
    notify(state, pid, `Сбор урожая: ${text}`, 'harvest');
    pushTx(state, { kind: 'harvest', toId: pid, items: { crops: gained }, byMaster });
  }
  pushFeed(state, any ? 'Осень: собран урожай.' : 'Осень: урожая не было.', 'harvest');
  return perPlayer;
}

function resetYearTaxes(state) {
  for (const p of playerList(state)) {
    p.tax = { year: state.time.year, cropsPaid: 0, moneyPaid: 0, lastSeasonKey: null };
  }
}

function advanceSeason(state, { byMaster = false } = {}) {
  const t = state.time;
  t.seasonIndex += 1;
  if (t.seasonIndex >= R.SEASONS.length) {
    t.seasonIndex = 0;
    t.year += 1;
    resetYearTaxes(state);
    if (t.year > state.config.totalYears) {
      finishGame(state);
      return;
    }
    pushFeed(state, `Начался год ${t.year}. Лимиты налогов обнулены.`, 'phase');
  }
  state.market.quotaUsed = R.emptyCrops();
  const season = R.SEASONS[t.seasonIndex];
  pushFeed(state, `Наступил сезон: ${R.SEASON_LABELS[season]} (год ${t.year}).`, 'phase');

  if (season === 'autumn') runHarvest(state, { byMaster });
  if (season === 'winter') pushFeed(state, 'Зима: море открыто, купцы могут отправиться на Рынок. Продажа системе недоступна.', 'phase');
  if (season === 'spring') pushFeed(state, 'Весна: крестьяне могут сажать культуры.', 'phase');

  if (!t.paused) t.seasonEndsAt = Date.now() + seasonDurationMs(state);
  else t.remainingMs = seasonDurationMs(state);
}

/** Вызывается по таймеру раз в секунду. Возвращает true, если состояние изменилось. */
function tick(state) {
  if (state.phase !== 'running' || state.time.paused) return false;
  if (!state.time.seasonEndsAt) {
    state.time.seasonEndsAt = Date.now() + seasonDurationMs(state);
    return true;
  }
  let changed = false;
  let guard = 0;
  while (state.phase === 'running' && !state.time.paused && state.time.seasonEndsAt <= Date.now() && guard++ < 100) {
    advanceSeason(state);
    changed = true;
  }
  return changed;
}

/* ------------------------------------------------------------------- итоги */

function cropPrice(state, crop) {
  const s = state.config.scoring;
  if (s.cropValueFromMarket) return Number(state.config.marketRates[crop]) || 0;
  return Number(s.cropValue) || 0;
}

function playerWealth(state, player) {
  const s = state.config.scoring;
  let wealth = player.money;
  for (const c of R.CROPS) wealth += (player.crops[c] || 0) * cropPrice(state, c);
  wealth += plotsOf(state, player.id).length * (Number(s.plotValue) || 0);
  if (player.hasBoat) wealth += Number(s.boatValue) || 0;
  return Math.round(wealth);
}

function computeResults(state) {
  const rows = playerList(state)
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      money: p.money,
      crops: { ...p.crops },
      plots: plotsOf(state, p.id).length,
      hasBoat: p.hasBoat,
      wealth: playerWealth(state, p),
    }))
    .sort((a, b) => b.wealth - a.wealth);
  return { at: Date.now(), treasury: state.treasury, rows };
}

function finishGame(state) {
  state.phase = 'finished';
  state.time.seasonEndsAt = null;
  state.time.remainingMs = null;
  state.results = computeResults(state);
  pushFeed(state, 'Игра завершена. Подведены итоги.', 'phase');
}

module.exports = {
  uid,
  createState,
  createPlayer,
  playerList,
  playersByRole,
  tsarOf,
  boyars,
  subordinates,
  createPlot,
  plotsOf,
  totalCrops,
  seasonKey,
  seasonName,
  pushFeed,
  pushTx,
  notify,
  shuffle,
  assignRoles,
  applyStartingSets,
  seasonDurationMs,
  startGame,
  pauseTime,
  resumeTime,
  runHarvest,
  advanceSeason,
  resetYearTaxes,
  tick,
  playerWealth,
  computeResults,
  finishGame,
};
