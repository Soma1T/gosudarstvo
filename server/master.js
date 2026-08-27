'use strict';

const R = require('./rules');
const E = require('./engine');
const A = require('./actions');

function fail(error) {
  return { ok: false, error };
}
function done(message) {
  return { ok: true, message };
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function int(v, def = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : def;
}

const MASTER_ACTIONS = {
  /* ------------------------------------------------ лобби и игроки */

  renamePlayer(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const name = String(d.name || '').trim().slice(0, 24);
    if (!name) return fail('пустое имя');
    const old = p.name;
    p.name = name;
    E.pushFeed(state, `Мастер переименовал «${old}» → «${name}».`, 'master');
    return done('Переименовано');
  },

  kickPlayer(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    // Освобождаем зависимости
    for (const s of E.subordinates(state, p.id)) s.lordId = null;
    for (const plot of E.plotsOf(state, p.id)) {
      plot.ownerId = A.stateFundOwnerId(state) === p.id ? A.STATE_OWNER : A.stateFundOwnerId(state);
      plot.planted = null;
    }
    delete state.players[p.id];
    E.pushFeed(state, `Мастер удалил игрока «${p.name}» из сессии.`, 'master');
    return done('Игрок удалён');
  },

  lockPlayer(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    p.locked = !!d.locked;
    return done(p.locked ? 'Параметры зафиксированы' : 'Фиксация снята');
  },

  startGame(state, d) {
    const players = E.playerList(state);
    if (!players.length) return fail('в сессии нет игроков');
    if (state.phase === 'running') return fail('игра уже идёт');
    let counts;
    if (d.keepRoles) {
      counts = null;
      if (players.some((p) => !p.role)) return fail('не всем игрокам назначена роль');
    } else {
      counts = {};
      const auto = R.computeRoleCounts(players.length);
      for (const role of R.ROLES) {
        counts[role] = d.counts && d.counts[role] !== undefined ? Math.max(0, int(d.counts[role])) : auto[role];
      }
      const sum = R.ROLES.reduce((s, r) => s + counts[r], 0);
      if (sum !== players.length) return fail(`сумма ролей (${sum}) не равна числу игроков (${players.length})`);
    }
    if (counts) E.startGame(state, counts);
    else {
      E.applyStartingSets(state);
      state.phase = 'running';
      state.time = {
        year: 1,
        seasonIndex: 0,
        paused: false,
        remainingMs: null,
        seasonEndsAt: Date.now() + E.seasonDurationMs(state),
      };
      state.market.quotaUsed = R.emptyCrops();
      state.results = null;
      E.pushFeed(state, 'Игра началась (роли заданы мастером). Год 1, Весна.', 'phase');
      for (const p of E.playerList(state)) {
        E.notify(state, p.id, `Игра началась. Ваша роль: ${R.ROLE_LABELS[p.role]}.`, 'phase');
      }
    }
    return done('Игра запущена');
  },

  reassignRoles(state, d) {
    const players = E.playerList(state);
    if (!players.length) return fail('нет игроков');
    const auto = R.computeRoleCounts(players.length);
    const counts = {};
    for (const role of R.ROLES) {
      counts[role] = d.counts && d.counts[role] !== undefined ? Math.max(0, int(d.counts[role])) : auto[role];
    }
    const sum = R.ROLES.reduce((s, r) => s + counts[r], 0);
    if (sum !== players.length) return fail(`сумма ролей (${sum}) не равна числу игроков (${players.length})`);
    E.assignRoles(state, counts);
    if (d.applyStartingSets) E.applyStartingSets(state);
    E.pushFeed(state, 'Мастер перераспределил роли.', 'master');
    return done('Роли перераспределены');
  },

  setPlayerRole(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    if (!R.ROLES.includes(d.role)) return fail('неизвестная роль');
    if (d.role === 'tsar') {
      const oldTsar = E.tsarOf(state);
      if (oldTsar && oldTsar.id !== p.id) {
        A.changeRole(state, oldTsar, 'feudal');
        E.pushFeed(state, `Мастер: ${oldTsar.name} больше не царь (стал феодалом).`, 'master');
      }
    }
    if (state.phase === 'lobby') p.role = d.role;
    else A.changeRole(state, p, d.role);
    if (d.giveStartingSet && d.role === 'peasant') A.giveStandardPeasantSet(state, p, { confiscate: false });
    E.pushFeed(state, `Мастер изменил роль ${p.name} → ${R.ROLE_LABELS[d.role]}.`, 'master');
    E.notify(state, p.id, `Мастер изменил вашу роль: ${R.ROLE_LABELS[d.role]}.`, 'master');
    return done('Роль изменена');
  },

  setPlayerLord(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    if (!d.lordId) {
      p.lordId = null;
      return done('Крестьянин стал вольным');
    }
    const lord = state.players[d.lordId];
    if (!lord) return fail('феодал не найден');
    p.lordId = lord.id;
    return done('Феодал назначен');
  },

  setMoney(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    p.money = Math.max(0, int(d.value));
    E.pushTx(state, { kind: 'master_set', toId: p.id, items: { money: p.money }, note: 'мастер задал деньги', byMaster: true });
    return done('Деньги обновлены');
  },

  addMoney(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const delta = int(d.delta);
    p.money = Math.max(0, p.money + delta);
    E.pushTx(state, { kind: 'master_grant', toId: p.id, items: { money: delta }, note: `мастер: ${delta > 0 ? '+' : ''}${delta} монет`, byMaster: true });
    E.notify(state, p.id, `Мастер изменил ваши деньги: ${delta > 0 ? '+' : ''}${delta}`, 'master');
    return done('Готово');
  },

  setCrops(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    for (const c of R.CROPS) {
      if (d.crops && d.crops[c] !== undefined) p.crops[c] = Math.max(0, int(d.crops[c]));
    }
    return done('Культуры обновлены');
  },

  addCrops(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const changed = {};
    for (const c of R.CROPS) {
      const delta = int(d.crops && d.crops[c]);
      if (!delta) continue;
      p.crops[c] = Math.max(0, (p.crops[c] || 0) + delta);
      changed[c] = delta;
    }
    if (Object.keys(changed).length) {
      E.pushTx(state, { kind: 'master_grant', toId: p.id, items: { crops: changed }, note: 'мастер выдал/забрал культуры', byMaster: true });
      E.notify(state, p.id, 'Мастер изменил ваши культуры.', 'master');
    }
    return done('Готово');
  },

  setFlags(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    if (d.hasBoat !== undefined) p.hasBoat = !!d.hasBoat;
    if (d.onMarket !== undefined) p.onMarket = !!d.onMarket;
    if (d.sanctions) {
      if (d.sanctions.noBoat !== undefined) p.sanctions.noBoat = !!d.sanctions.noBoat;
      if (d.sanctions.noTrade !== undefined) p.sanctions.noTrade = !!d.sanctions.noTrade;
      if (d.sanctions.noFarm !== undefined) p.sanctions.noFarm = !!d.sanctions.noFarm;
      if (d.sanctions.notes !== undefined) p.sanctions.notes = String(d.sanctions.notes).slice(0, 200);
    }
    if (d.protectedUntilYear !== undefined) p.protectedUntilYear = int(d.protectedUntilYear);
    return done('Флаги обновлены');
  },

  setTax(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    if (d.cropsPaid !== undefined) p.tax.cropsPaid = Math.max(0, int(d.cropsPaid));
    if (d.moneyPaid !== undefined) p.tax.moneyPaid = Math.max(0, int(d.moneyPaid));
    if (d.clearSeason) p.tax.lastSeasonKey = null;
    p.tax.year = state.time.year;
    return done('Налоговый счётчик обновлён');
  },

  addPlots(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const n = Math.max(1, Math.min(200, int(d.count, 1)));
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(E.createPlot(state, p.id).id);
    E.pushTx(state, { kind: 'master_grant', toId: p.id, items: { plots: ids }, note: 'мастер выдал участки', byMaster: true });
    return done(`Выдано участков: ${n}`);
  },

  removePlots(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const n = Math.max(1, Math.min(200, int(d.count, 1)));
    const owned = E.plotsOf(state, p.id).sort((a, b) => (a.planted ? 1 : 0) - (b.planted ? 1 : 0));
    const removed = owned.slice(0, n).map((l) => l.id);
    for (const id of removed) delete state.plots[id];
    return done(`Удалено участков: ${removed.length}`);
  },

  movePlots(state, d) {
    const from = d.fromId === A.STATE_OWNER ? { id: A.STATE_OWNER, role: 'tsar' } : state.players[d.fromId];
    const to = d.toId === A.STATE_OWNER ? { id: A.STATE_OWNER, role: 'tsar' } : state.players[d.toId];
    if (!from || !to) return fail('владелец не найден');
    const n = Math.max(1, Math.min(200, int(d.count, 1)));
    const owned = E.plotsOf(state, from.id);
    const moving = owned.slice(0, n).map((l) => l.id);
    A.movePlotsTo(state, moving, to.id);
    E.pushTx(state, { kind: 'plots_move', fromId: from.id, toId: to.id, items: { plots: moving }, note: 'мастер переместил участки', byMaster: true });
    return done(`Перемещено участков: ${moving.length}`);
  },

  setPlotPlanted(state, d) {
    const plot = state.plots[d.plotId];
    if (!plot) return fail('участок не найден');
    if (d.crop === null || d.crop === '' || d.crop === undefined) {
      plot.planted = null;
      plot.plantedYear = null;
    } else {
      if (!R.CROPS.includes(d.crop)) return fail('неизвестная культура');
      plot.planted = d.crop;
      plot.plantedYear = state.time.year;
    }
    return done('Участок обновлён');
  },

  forceTransfer(state, d) {
    const from = state.players[d.fromId];
    const to = state.players[d.toId];
    if (!from || !to) return fail('игрок не найден');
    const b = A.normBundle(d);
    A.resolvePlotCount(state, from, b);
    if (A.bundleIsEmpty(b)) return fail('нечего передавать');
    const err = A.checkCanGive(state, from, b);
    if (err && !d.ignoreChecks) return fail(err);
    if (d.ignoreChecks) {
      // добавляем недостающее, чтобы мастер мог принудительно провести операцию
      if (from.money < b.money) from.money = b.money;
      for (const c of R.CROPS) if ((from.crops[c] || 0) < b.crops[c]) from.crops[c] = b.crops[c];
      b.plots = b.plots.filter((id) => state.plots[id]);
    }
    A.moveBundle(state, from, to, b);
    E.pushTx(state, { kind: 'master_transfer', fromId: from.id, toId: to.id, items: b, note: `мастер: ${A.describeBundle(b)}`, byMaster: true });
    E.notify(state, to.id, `Мастер передал вам: ${A.describeBundle(b)}`, 'master');
    E.notify(state, from.id, `Мастер забрал у вас: ${A.describeBundle(b)}`, 'master');
    return done('Передано');
  },

  giveStandardSet(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    A.giveStandardPeasantSet(state, p, { confiscate: !!d.confiscate });
    return done('Стандартный набор выдан');
  },

  /* ------------------------------------------------ казна и экономика */

  setTreasury(state, d) {
    state.treasury = Math.max(0, int(d.value));
    return done('Казна обновлена');
  },

  addTreasury(state, d) {
    state.treasury = Math.max(0, state.treasury + int(d.delta));
    return done('Казна обновлена');
  },

  setStateCrops(state, d) {
    for (const c of R.CROPS) {
      if (d.crops && d.crops[c] !== undefined) state.stateCrops[c] = Math.max(0, int(d.crops[c]));
    }
    return done('Культуры казны обновлены');
  },

  setConfig(state, d) {
    const patch = d.patch || {};
    const before = state.config.seasonDurationSec;
    deepMerge(state.config, patch);
    // числовые поля приводим к числам
    for (const k of Object.keys(state.config)) {
      if (typeof R.defaultConfig()[k] === 'number') state.config[k] = Number(state.config[k]) || 0;
    }
    for (const c of R.CROPS) {
      state.config.marketRates[c] = Math.max(0, Number(state.config.marketRates[c]) || 0);
      state.config.marketQuotas[c] = Math.max(0, Number(state.config.marketQuotas[c]) || 0);
    }
    if (d.applyTimerNow && state.config.seasonDurationSec !== before && state.phase === 'running') {
      if (state.time.paused) state.time.remainingMs = E.seasonDurationMs(state);
      else state.time.seasonEndsAt = Date.now() + E.seasonDurationMs(state);
    }
    E.pushFeed(state, 'Мастер изменил параметры игры.', 'master');
    return done('Параметры обновлены');
  },

  resetQuotas(state) {
    state.market.quotaUsed = R.emptyCrops();
    return done('Квоты сброшены');
  },

  resetTaxes(state) {
    E.resetYearTaxes(state);
    return done('Налоговые лимиты сброшены');
  },

  /* ------------------------------------------------------------ время */

  pause(state) {
    E.pauseTime(state);
    return done('Пауза');
  },

  resume(state) {
    E.resumeTime(state);
    return done('Время идёт');
  },

  nextSeason(state) {
    if (state.phase !== 'running') return fail('игра не идёт');
    E.advanceSeason(state, { byMaster: true });
    return done('Сезон переключён');
  },

  setTime(state, d) {
    if (d.year !== undefined) state.time.year = Math.max(1, int(d.year, 1));
    if (d.seasonIndex !== undefined) {
      state.time.seasonIndex = Math.max(0, Math.min(R.SEASONS.length - 1, int(d.seasonIndex)));
    }
    if (state.phase === 'running' && !state.time.paused) {
      state.time.seasonEndsAt = Date.now() + E.seasonDurationMs(state);
    }
    E.pushFeed(state, `Мастер перевёл время: год ${state.time.year}, ${E.seasonName(state)}.`, 'master');
    return done('Время изменено');
  },

  setSeasonRemaining(state, d) {
    const ms = Math.max(0, int(d.seconds)) * 1000;
    if (state.time.paused) state.time.remainingMs = ms;
    else state.time.seasonEndsAt = Date.now() + ms;
    return done('Таймер обновлён');
  },

  runHarvest(state) {
    E.runHarvest(state, { byMaster: true });
    return done('Урожай собран');
  },

  finishGame(state) {
    E.finishGame(state);
    return done('Игра завершена');
  },

  recomputeResults(state) {
    state.results = E.computeResults(state);
    return done('Итоги пересчитаны');
  },

  backToLobby(state, d) {
    state.phase = 'lobby';
    state.time = { year: 1, seasonIndex: 0, seasonEndsAt: null, remainingMs: null, paused: false };
    state.plots = {};
    state.nextPlotNum = 1;
    state.treasury = 0;
    state.stateCrops = R.emptyCrops();
    state.market.quotaUsed = R.emptyCrops();
    state.decrees = [];
    state.requests = [];
    state.complaints = [];
    state.election = null;
    state.overthrow = null;
    state.transactions = [];
    state.feed = [];
    state.results = null;
    for (const p of E.playerList(state)) {
      p.money = 0;
      p.crops = R.emptyCrops();
      p.hasBoat = false;
      p.onMarket = false;
      p.lordId = null;
      p.notifications = [];
      p.tax = { year: 1, cropsPaid: 0, moneyPaid: 0, lastSeasonKey: null };
      p.protectedUntilYear = 0;
      p.sanctions = { noBoat: false, noTrade: false, noFarm: false, notes: '' };
      if (d.clearRoles) p.role = null;
    }
    E.pushFeed(state, 'Мастер вернул сессию в лобби.', 'master');
    return done('Сессия в лобби');
  },

  resetAll(state) {
    const fresh = E.createState();
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fresh);
    return done('Полный сброс выполнен');
  },

  /* ---------------------------------------------------------- политика */

  resolveDecree(state, d) {
    const decree = state.decrees.find((x) => x.id === d.decreeId);
    if (!decree) return fail('указ не найден');
    if (d.outcome === 'pass') A.applyDecree(state, decree);
    else if (d.outcome === 'reject') A.rejectDecree(state, decree);
    else if (d.outcome === 'cancel') {
      decree.status = 'cancelled';
      decree.resolvedAt = Date.now();
      E.pushFeed(state, `Мастер отменил указ «${decree.title}».`, 'master');
    } else return fail('неизвестный исход');
    return done('Указ обработан');
  },

  setBoyarVote(state, d) {
    const decree = state.decrees.find((x) => x.id === d.decreeId);
    if (!decree) return fail('указ не найден');
    if (!state.players[d.boyarId]) return fail('боярин не найден');
    decree.votes[d.boyarId] = d.vote === 'against' ? 'against' : 'for';
    A.evaluateDecree(state, decree);
    return done('Голос выставлен');
  },

  startElection(state, d) {
    A.startElection(state, d.reason || 'master');
    return done('Выборы начаты');
  },

  finishElection(state, d) {
    const res = A.finishElection(state, d.winnerId || null);
    return res.ok ? done('Выборы завершены') : res;
  },

  cancelElection(state) {
    if (state.election) state.election.status = 'cancelled';
    E.pushFeed(state, 'Мастер отменил выборы.', 'master');
    return done('Выборы отменены');
  },

  cancelOverthrow(state) {
    if (state.overthrow) state.overthrow.status = 'cancelled';
    E.pushFeed(state, 'Мастер отменил процедуру свержения.', 'master');
    return done('Процедура отменена');
  },

  forceOverthrow(state) {
    if (!E.tsarOf(state)) return fail('царя нет');
    state.overthrow = { id: E.uid('ov'), status: 'voting', createdAt: Date.now(), startedBy: 'MASTER', votes: {} };
    const res = A.executeOverthrow(state);
    return res.ok ? done('Царь свергнут мастером') : res;
  },

  /* ------------------------------------------------------------ заявки */

  handleRequest(state, d) {
    const r = state.requests.find((x) => x.id === d.requestId);
    if (!r) return fail('заявка не найдена');
    if (d.mode === 'complete') {
      A.tryCompleteRequest(state, r, { force: true });
      return done('Заявка выполнена принудительно');
    }
    if (d.mode === 'decline') {
      r.status = 'declined';
      r.resolvedAt = Date.now();
      return done('Заявка отклонена');
    }
    if (d.mode === 'delete') {
      state.requests = state.requests.filter((x) => x.id !== r.id);
      return done('Заявка удалена');
    }
    return fail('неизвестный режим');
  },

  /* -------------------------------------------------------------- прочее */

  announce(state, d) {
    const text = String(d.text || '').trim().slice(0, 400);
    if (!text) return fail('пустое объявление');
    E.pushFeed(state, `Объявление мастера: ${text}`, 'master');
    for (const p of E.playerList(state)) E.notify(state, p.id, `Мастер: ${text}`, 'master');
    return done('Объявление отправлено');
  },

  notifyPlayer(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const text = String(d.text || '').trim().slice(0, 300);
    if (!text) return fail('пустое сообщение');
    E.notify(state, p.id, `Мастер: ${text}`, 'master');
    return done('Отправлено');
  },

  clearLog(state) {
    state.transactions = [];
    return done('Журнал очищен');
  },

  /** Действие «на все случаи»: сырое слияние JSON в состояние. */
  rawPatch(state, d) {
    if (!isPlainObject(d.patch)) return fail('patch должен быть объектом');
    deepMerge(state, d.patch);
    E.pushFeed(state, 'Мастер применил ручное изменение состояния.', 'master');
    return done('Патч применён');
  },

  /** Выполнить действие от имени игрока (отладка ролевых интерфейсов). */
  actAsPlayer(state, d) {
    const p = state.players[d.playerId];
    if (!p) return fail('игрок не найден');
    const A2 = require('./actions');
    return A2.handlePlayerAction(state, p, d.type, d.data);
  },
};

function handleMasterAction(state, type, data) {
  const handler = MASTER_ACTIONS[type];
  if (!handler) return fail(`неизвестное действие мастера: ${type}`);
  try {
    return handler(state, data || {}) || { ok: true };
  } catch (e) {
    return fail(`ошибка: ${e.message}`);
  }
}

module.exports = { handleMasterAction, MASTER_ACTIONS, deepMerge };
