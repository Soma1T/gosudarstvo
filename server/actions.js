'use strict';

const R = require('./rules');
const E = require('./engine');

const STATE_OWNER = 'STATE';

function fail(error) {
  return { ok: false, error };
}
function done(message) {
  return { ok: true, message };
}

function season(state) {
  return R.SEASONS[state.time.seasonIndex];
}

function running(state) {
  return state.phase === 'running';
}

function pname(state, id) {
  if (id === STATE_OWNER) return 'Государственный фонд';
  if (id === 'TREASURY') return 'Казна';
  if (id === 'MARKET') return 'Рынок';
  return state.players[id] ? state.players[id].name : 'неизвестный';
}

/* ------------------------------------------------------- наборы ресурсов */

function normBundle(raw) {
  const money = Math.max(0, Math.floor(Number(raw && raw.money) || 0));
  const crops = {};
  for (const c of R.CROPS) {
    crops[c] = Math.max(0, Math.floor(Number(raw && raw.crops && raw.crops[c]) || 0));
  }
  const plots = Array.isArray(raw && raw.plots)
    ? raw.plots.filter((x) => typeof x === 'string').slice(0, 100)
    : [];
  const plotCount = Math.max(0, Math.min(200, Math.floor(Number(raw && raw.plotCount) || 0)));
  return { money, crops, plots, plotCount };
}

/**
 * Если в наборе указано только количество участков (например, «прошу 2 участка»),
 * подбирает конкретные участки владельца — сначала незасеянные.
 */
function resolvePlotCount(state, owner, bundle) {
  if (!bundle.plotCount || bundle.plots.length) return;
  const owned = E.plotsOf(state, owner.id).sort((a, b) => (a.planted ? 1 : 0) - (b.planted ? 1 : 0));
  bundle.plots = owned.slice(0, bundle.plotCount).map((l) => l.id);
}

function bundleIsEmpty(b) {
  return b.money === 0 && R.CROPS.every((c) => b.crops[c] === 0) && b.plots.length === 0 && !b.plotCount;
}

function describeBundle(b) {
  const parts = [];
  if (b.money) parts.push(`${b.money} монет`);
  for (const c of R.CROPS) if (b.crops[c]) parts.push(`${R.CROP_LABELS[c]} ×${b.crops[c]}`);
  if (b.plots.length) parts.push(`участки: ${b.plots.join(', ')}`);
  else if (b.plotCount) parts.push(`участков: ${b.plotCount}`);
  return parts.length ? parts.join(', ') : 'ничего';
}

function canHoldLand(role) {
  return R.LAND_HOLDING_ROLES.includes(role);
}

function checkCanGive(state, from, b) {
  if (from.money < b.money) return `у ${from.name} недостаточно монет`;
  for (const c of R.CROPS) {
    if ((from.crops[c] || 0) < b.crops[c]) return `у ${from.name} недостаточно «${R.CROP_LABELS[c]}»`;
  }
  for (const id of b.plots) {
    const plot = state.plots[id];
    if (!plot) return `участок ${id} не найден`;
    if (plot.ownerId !== from.id) return `участок ${id} не принадлежит ${from.name}`;
  }
  return null;
}

function moveBundle(state, from, to, b) {
  from.money -= b.money;
  to.money += b.money;
  for (const c of R.CROPS) {
    if (!b.crops[c]) continue;
    from.crops[c] -= b.crops[c];
    to.crops[c] = (to.crops[c] || 0) + b.crops[c];
  }
  for (const id of b.plots) {
    const plot = state.plots[id];
    plot.ownerId = to.id;
    if (to.role !== 'peasant') {
      plot.planted = null;
      plot.plantedYear = null;
    }
  }
}

/** Ограничение: игрок на Рынке может обмениваться только с купцами на Рынке. */
function tradeBlockReason(state, a, b) {
  if (a.sanctions.noTrade) return `${a.name}: действует запрет на обмен (санкция)`;
  if (b.sanctions.noTrade) return `${b.name}: действует запрет на обмен (санкция)`;
  const aOnMarket = a.role === 'merchant' && a.onMarket;
  const bOnMarket = b.role === 'merchant' && b.onMarket;
  if (aOnMarket !== bOnMarket) {
    return 'Пока купец находится на Рынке, обмениваться с ним могут только купцы на Рынке';
  }
  return null;
}

function checkPlotsReceivable(state, to, b) {
  if (b.plots.length && !canHoldLand(to.role)) {
    return `${R.ROLE_LABELS[to.role]} не может владеть землёй`;
  }
  return null;
}

/* ---------------------------------------------------------- смена роли */

function stateFundOwnerId(state) {
  const tsar = E.tsarOf(state);
  return tsar ? tsar.id : STATE_OWNER;
}

function movePlotsTo(state, plotIds, targetOwnerId) {
  for (const id of plotIds) {
    const plot = state.plots[id];
    if (!plot) continue;
    plot.ownerId = targetOwnerId;
    plot.planted = null;
    plot.plantedYear = null;
  }
}

/**
 * Централизованная смена роли со всеми последствиями.
 * opts.plotTarget — куда девать участки, если новая роль не может владеть землёй.
 */
function changeRole(state, player, newRole, opts = {}) {
  const oldRole = player.role;
  if (oldRole === newRole) return;

  if (oldRole === 'feudal') {
    for (const s of E.subordinates(state, player.id)) {
      s.lordId = null;
      E.notify(state, s.id, `${player.name} больше не феодал — вы стали вольным крестьянином.`, 'politics');
    }
  }
  if (oldRole === 'merchant') {
    player.hasBoat = false;
    player.onMarket = false;
  }

  player.role = newRole;

  if (!canHoldLand(newRole)) {
    const plots = E.plotsOf(state, player.id).map((l) => l.id);
    if (plots.length) {
      const target = opts.plotTarget || stateFundOwnerId(state);
      movePlotsTo(state, plots, target === player.id ? STATE_OWNER : target);
      E.pushTx(state, {
        kind: 'plots_move',
        fromId: player.id,
        toId: target,
        items: { plots },
        note: 'смена роли: участки переданы',
      });
    }
  }
  if (newRole !== 'peasant') player.lordId = null;
  if (newRole === 'merchant') player.hasBoat = true;
  if (newRole === 'tsar') {
    // Государственный фонд участков переходит новому царю.
    const fund = E.plotsOf(state, STATE_OWNER).map((l) => l.id);
    movePlotsTo(state, fund, player.id);
  }
}

/** Стандартный набор крестьянина: участки из фонда царя, 4 культуры, 0 монет. */
function giveStandardPeasantSet(state, player, { confiscate = false } = {}) {
  const cfg = state.config;
  if (confiscate) {
    state.treasury += player.money;
    player.money = 0;
    for (const c of R.CROPS) {
      state.stateCrops[c] = (state.stateCrops[c] || 0) + (player.crops[c] || 0);
      player.crops[c] = 0;
    }
    E.pushTx(state, { kind: 'confiscation', fromId: player.id, toId: 'TREASURY', note: 'конфискация в казну' });
  }
  player.money = confiscate ? cfg.startPeasantMoney : player.money;
  for (const c of R.CROPS) {
    player.crops[c] = (player.crops[c] || 0) + cfg.startPeasantCropEach;
  }
  // участки берём из фонда царя, если есть
  const fundOwner = stateFundOwnerId(state);
  const fund = E.plotsOf(state, fundOwner);
  let need = cfg.startPeasantPlots;
  const taken = [];
  while (need > 0 && fund.length) {
    const plot = fund.pop();
    plot.ownerId = player.id;
    plot.planted = null;
    taken.push(plot.id);
    need--;
  }
  while (need > 0) {
    taken.push(E.createPlot(state, player.id).id);
    need--;
  }
  E.pushTx(state, {
    kind: 'standard_set',
    toId: player.id,
    items: { plots: taken, crops: R.CROPS.reduce((o, c) => ((o[c] = cfg.startPeasantCropEach), o), {}) },
    note: 'стандартный набор крестьянина',
  });
}

/* ---------------------------------------------------------------- заявки */

function createRequest(state, req) {
  const r = {
    id: E.uid('r'),
    createdAt: Date.now(),
    status: 'pending',
    approvals: {},
    needBoyar: false,
    boyarId: null,
    boyarVote: null,
    data: {},
    ...req,
  };
  state.requests.unshift(r);
  if (state.requests.length > 200) state.requests.length = 200;
  return r;
}

function requestParticipants(r) {
  const ids = new Set([r.initiatorId, ...Object.keys(r.approvals)]);
  if (r.boyarId) ids.add(r.boyarId);
  return [...ids];
}

function tryCompleteRequest(state, r, { force = false } = {}) {
  if (r.status !== 'pending') return;
  const votes = Object.values(r.approvals);
  if (!force) {
    if (votes.includes('no') || r.boyarVote === 'no') {
      r.status = 'declined';
      r.resolvedAt = Date.now();
      E.notify(state, r.initiatorId, `Заявка отклонена: ${r.title}`, 'warn');
      return;
    }
    if (votes.includes('pending')) return;
    if (r.needBoyar && r.boyarVote !== 'yes') return;
  }
  const executor = REQUEST_EXECUTORS[r.kind];
  const res = executor ? executor(state, r) : fail('неизвестный тип заявки');
  if (!res.ok) {
    r.status = 'failed';
    r.error = res.error;
    r.resolvedAt = Date.now();
    for (const id of requestParticipants(r)) {
      E.notify(state, id, `Заявка не выполнена (${r.title}): ${res.error}`, 'warn');
    }
    return;
  }
  r.status = 'done';
  r.resolvedAt = Date.now();
  for (const id of requestParticipants(r)) {
    E.notify(state, id, `Выполнено: ${r.title}`, 'ok');
  }
}

const REQUEST_EXECUTORS = {
  trade(state, r) {
    const a = state.players[r.initiatorId];
    const b = state.players[r.data.toId];
    if (!a || !b) return fail('участник сделки покинул игру');
    const block = tradeBlockReason(state, a, b);
    if (block) return fail(block);
    const give = normBundle(r.data.give);
    const want = normBundle(r.data.want);
    resolvePlotCount(state, a, give);
    resolvePlotCount(state, b, want);
    if (want.plotCount && want.plots.length < want.plotCount) {
      return fail(`у ${b.name} нет ${want.plotCount} участков`);
    }
    let err = checkCanGive(state, a, give) || checkCanGive(state, b, want);
    if (err) return fail(err);
    err = checkPlotsReceivable(state, b, give) || checkPlotsReceivable(state, a, want);
    if (err) return fail(err);
    moveBundle(state, a, b, give);
    moveBundle(state, b, a, want);
    E.pushTx(state, {
      kind: 'trade',
      fromId: a.id,
      toId: b.id,
      items: give,
      items2: want,
      note: `обмен: ${describeBundle(give)} ⇄ ${describeBundle(want)}`,
    });
    return done();
  },

  boat_sale(state, r) {
    const peasant = state.players[r.data.peasantId];
    const boyar = state.players[r.data.boyarId];
    if (!peasant || !boyar) return fail('участник покинул игру');
    if (peasant.role !== 'peasant') return fail('покупателем лодки может быть только крестьянин');
    if (boyar.role !== 'boyar') return fail('лодки продаёт только боярин');
    if (peasant.sanctions.noBoat) return fail('крестьянину запрещено покупать лодку (санкция)');
    const price = Math.max(0, Math.floor(Number(state.config.boatPrice) || 0));
    if (peasant.money < price) return fail('у крестьянина недостаточно монет');

    const wasSerf = !!peasant.lordId;
    let target = r.data.plotTarget === 'lord' && wasSerf ? peasant.lordId : stateFundOwnerId(state);
    if (!state.players[target] && target !== STATE_OWNER) target = STATE_OWNER;

    peasant.money -= price;
    boyar.money += price;
    const plots = E.plotsOf(state, peasant.id).map((l) => l.id);
    changeRole(state, peasant, 'merchant', { plotTarget: target });
    E.pushTx(state, {
      kind: 'boat_sale',
      fromId: boyar.id,
      toId: peasant.id,
      items: { money: price },
      note: `продажа лодки за ${price}; участки (${plots.join(', ') || '—'}) → ${pname(state, target)}`,
    });
    E.pushFeed(state, `${peasant.name} купил лодку у ${boyar.name} и стал купцом.`, 'economy');
    return done();
  },

  patronage(state, r) {
    const peasant = state.players[r.data.peasantId];
    const feudal = state.players[r.data.feudalId];
    if (!peasant || !feudal) return fail('участник покинул игру');
    if (peasant.role !== 'peasant') return fail('под покровительство берут только крестьян');
    if (feudal.role !== 'feudal') return fail('покровительство даёт только феодал');
    if (peasant.lordId) return fail('крестьянин уже принадлежит феодалу');
    peasant.lordId = feudal.id;
    E.pushTx(state, { kind: 'patronage', fromId: feudal.id, toId: peasant.id, note: 'крестьянин принят под покровительство' });
    E.pushFeed(state, `${peasant.name} перешёл под покровительство феодала ${feudal.name}.`, 'politics');
    return done();
  },

  lord_change(state, r) {
    const peasant = state.players[r.data.peasantId];
    const to = state.players[r.data.toLordId];
    if (!peasant || !to) return fail('участник покинул игру');
    if (peasant.role !== 'peasant') return fail('переходить может только крестьянин');
    if (to.role !== 'feudal') return fail('принять может только феодал');
    peasant.lordId = to.id;
    E.pushTx(state, {
      kind: 'lord_change',
      fromId: r.data.fromLordId,
      toId: to.id,
      note: `${peasant.name} перешёл к другому феодалу`,
    });
    E.pushFeed(state, `${peasant.name} перешёл от ${pname(state, r.data.fromLordId)} к ${to.name}.`, 'politics');
    return done();
  },
};

/* ------------------------------------------------------------- налоги */

function taxContext(state, collector, payer) {
  const cfg = state.config;
  if (collector.role === 'feudal') {
    if (payer.role !== 'peasant' || payer.lordId !== collector.id) {
      return { error: 'это не ваш крестьянин' };
    }
    return { cropLimit: cfg.feudalTaxCropsPerYear, moneyLimit: cfg.feudalTaxMoneyPerYear, dest: 'collector' };
  }
  if (collector.role === 'tsar') {
    if (payer.role !== 'feudal') return { error: 'царь собирает налог только с феодалов' };
    return { cropLimit: cfg.tsarTaxCropsPerYear, moneyLimit: cfg.tsarTaxMoneyPerYear, dest: 'collector' };
  }
  if (collector.role === 'boyar') {
    if (!cfg.freePeasantTaxEnabled) return { error: 'указ о налоге для вольных крестьян не введён' };
    if (payer.role !== 'peasant' || payer.lordId) return { error: 'налог собирается только с вольных крестьян' };
    return { cropLimit: cfg.freeTaxCropsPerYear, moneyLimit: cfg.freeTaxMoneyPerYear, dest: 'treasury' };
  }
  return { error: 'ваша роль не собирает налоги' };
}

function taxState(state, payer) {
  if (payer.tax.year !== state.time.year) {
    payer.tax = { year: state.time.year, cropsPaid: 0, moneyPaid: 0, lastSeasonKey: null };
  }
  return payer.tax;
}

function taxRemaining(state, collector, payer) {
  const ctx = taxContext(state, collector, payer);
  if (ctx.error) return { error: ctx.error };
  const t = taxState(state, payer);
  return {
    crops: Math.max(0, ctx.cropLimit - t.cropsPaid),
    money: Math.max(0, ctx.moneyLimit - t.moneyPaid),
    collectedThisSeason: state.config.taxOncePerSeason && t.lastSeasonKey === E.seasonKey(state),
    dest: ctx.dest,
  };
}

function collectTax(state, collector, payload) {
  const payer = state.players[payload && payload.payerId];
  if (!payer) return fail('игрок не найден');
  const ctx = taxContext(state, collector, payer);
  if (ctx.error) return fail(ctx.error);
  const t = taxState(state, payer);
  if (state.config.taxOncePerSeason && t.lastSeasonKey === E.seasonKey(state)) {
    return fail('налог с этого игрока уже собран в текущем сезоне');
  }
  const money = Math.max(0, Math.floor(Number(payload.money) || 0));
  const crops = {};
  let cropTotal = 0;
  for (const c of R.CROPS) {
    crops[c] = Math.max(0, Math.floor(Number(payload.crops && payload.crops[c]) || 0));
    cropTotal += crops[c];
  }
  if (money === 0 && cropTotal === 0) return fail('укажите, что собираете');
  if (t.moneyPaid + money > ctx.moneyLimit) {
    return fail(`лимит по монетам на год: ${ctx.moneyLimit}, уже собрано ${t.moneyPaid}`);
  }
  if (t.cropsPaid + cropTotal > ctx.cropLimit) {
    return fail(`лимит по культурам на год: ${ctx.cropLimit}, уже собрано ${t.cropsPaid}`);
  }
  if (payer.money < money) return fail('у плательщика недостаточно монет');
  for (const c of R.CROPS) {
    if ((payer.crops[c] || 0) < crops[c]) return fail(`у плательщика нет «${R.CROP_LABELS[c]}» в нужном количестве`);
  }

  payer.money -= money;
  for (const c of R.CROPS) payer.crops[c] -= crops[c];
  if (ctx.dest === 'treasury') {
    state.treasury += money;
    for (const c of R.CROPS) state.stateCrops[c] = (state.stateCrops[c] || 0) + crops[c];
  } else {
    collector.money += money;
    for (const c of R.CROPS) collector.crops[c] = (collector.crops[c] || 0) + crops[c];
  }
  t.moneyPaid += money;
  t.cropsPaid += cropTotal;
  t.lastSeasonKey = E.seasonKey(state);

  const desc = describeBundle({ money, crops, plots: [] });
  E.pushTx(state, {
    kind: 'tax',
    fromId: payer.id,
    toId: ctx.dest === 'treasury' ? 'TREASURY' : collector.id,
    items: { money, crops },
    note: `налог: ${desc} (сборщик ${collector.name})`,
  });
  E.notify(state, payer.id, `С вас удержан налог: ${desc} (${collector.name})`, 'tax');
  return done(`Налог собран: ${desc}`);
}

/* ----------------------------------------------------------------- указы */

const CONFIG_NUMERIC_KEYS = [
  'boatPrice',
  'ransomPrice',
  'feudalTaxCropsPerYear',
  'feudalTaxMoneyPerYear',
  'tsarTaxCropsPerYear',
  'tsarTaxMoneyPerYear',
  'freeTaxCropsPerYear',
  'freeTaxMoneyPerYear',
];

const CONFIG_LABELS = {
  boatPrice: 'Цена лодки',
  ransomPrice: 'Цена выкупа крестьянина',
  feudalTaxCropsPerYear: 'Лимит налога феодала: культур/год',
  feudalTaxMoneyPerYear: 'Лимит налога феодала: монет/год',
  tsarTaxCropsPerYear: 'Лимит налога царя: культур/год',
  tsarTaxMoneyPerYear: 'Лимит налога царя: монет/год',
  freeTaxCropsPerYear: 'Налог вольных: культур/год',
  freeTaxMoneyPerYear: 'Налог вольных: монет/год',
  freePeasantTaxEnabled: 'Налог для вольных крестьян',
};

function sanitizeDecreeChanges(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of CONFIG_NUMERIC_KEYS) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
    const v = Math.max(0, Math.floor(Number(raw[k])));
    if (Number.isFinite(v)) out[k] = v;
  }
  if (raw.freePeasantTaxEnabled !== undefined) out.freePeasantTaxEnabled = !!raw.freePeasantTaxEnabled;
  return out;
}

function describeDecree(state, d) {
  const parts = [];
  for (const [k, v] of Object.entries(d.changes || {})) {
    const label = CONFIG_LABELS[k] || k;
    parts.push(typeof v === 'boolean' ? `${label}: ${v ? 'введён' : 'отменён'}` : `${label} → ${v}`);
  }
  if (d.sanction && d.sanction.targetId) {
    const flags = [];
    if (d.sanction.noBoat) flags.push('запрет покупки лодки');
    if (d.sanction.noTrade) flags.push('запрет обмена');
    if (d.sanction.noFarm) flags.push('запрет возделывания земли');
    parts.push(`санкции на ${pname(state, d.sanction.targetId)}: ${flags.length ? flags.join(', ') : 'сняты'}`);
  }
  return parts.join('; ');
}

function applyDecree(state, d) {
  for (const [k, v] of Object.entries(d.changes || {})) state.config[k] = v;
  if (d.sanction && d.sanction.targetId) {
    const target = state.players[d.sanction.targetId];
    if (target) {
      target.sanctions.noBoat = !!d.sanction.noBoat;
      target.sanctions.noTrade = !!d.sanction.noTrade;
      target.sanctions.noFarm = !!d.sanction.noFarm;
      target.sanctions.notes = String(d.sanction.notes || '').slice(0, 200);
      E.notify(state, target.id, `Против вас введены санкции указом: ${describeDecree(state, d)}`, 'warn');
    }
  }
  d.status = 'passed';
  d.resolvedAt = Date.now();
  const summary = describeDecree(state, d);
  E.pushFeed(state, `УКАЗ принят: «${d.title}». ${summary}`, 'decree');
  for (const p of E.playerList(state)) E.notify(state, p.id, `Принят указ: «${d.title}». ${summary}`, 'decree');
}

function rejectDecree(state, d) {
  d.status = 'rejected';
  d.resolvedAt = Date.now();
  E.pushFeed(state, `Указ «${d.title}» отклонён боярами.`, 'decree');
  for (const p of E.playerList(state)) E.notify(state, p.id, `Указ «${d.title}» отклонён боярами.`, 'decree');
}

function evaluateDecree(state, d, { close = false } = {}) {
  if (d.status !== 'voting') return;
  const bs = E.boyars(state);
  const total = bs.length;
  if (total === 0) {
    applyDecree(state, d);
    return;
  }
  const votes = bs.map((b) => d.votes[b.id]).filter(Boolean);
  const against = votes.filter((v) => v === 'against').length;
  const threshold = Math.floor(total / 2) + 1; // строго больше половины
  if (against >= threshold) {
    rejectDecree(state, d);
    return;
  }
  if (close) {
    applyDecree(state, d);
    return;
  }
  const remaining = total - votes.length;
  if (against + remaining < threshold) applyDecree(state, d);
}

/* ------------------------------------------------- свержение и выборы */

function startElection(state, reason) {
  const candidates = E.playerList(state)
    .filter((p) => p.role === 'boyar' || p.role === 'feudal')
    .map((p) => p.id);
  state.election = {
    id: E.uid('e'),
    status: 'voting',
    createdAt: Date.now(),
    candidates,
    votes: {},
    reason,
  };
  E.pushFeed(state, `Начались выборы нового царя. Кандидаты: ${candidates.map((id) => pname(state, id)).join(', ') || '—'}.`, 'politics');
  for (const p of E.playerList(state)) {
    E.notify(state, p.id, candidates.includes(p.id) ? 'Вы кандидат на престол. Кандидаты не голосуют.' : 'Идут выборы царя — проголосуйте.', 'politics');
  }
}

function finishElection(state, forcedWinnerId) {
  const el = state.election;
  if (!el || el.status !== 'voting') return fail('выборы не идут');
  let winnerId = forcedWinnerId;
  if (!winnerId) {
    const tally = {};
    for (const cid of Object.values(el.votes)) tally[cid] = (tally[cid] || 0) + 1;
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return fail('нет ни одного голоса');
    const top = sorted.filter(([, n]) => n === sorted[0][1]);
    winnerId = top[Math.floor(Math.random() * top.length)][0];
    el.tie = top.length > 1;
  }
  const winner = state.players[winnerId];
  if (!winner) return fail('победитель не найден');
  const previousRole = winner.role;
  changeRole(state, winner, 'tsar');
  el.status = 'done';
  el.winnerId = winner.id;
  el.resolvedAt = Date.now();
  E.pushFeed(
    state,
    `Новый царь — ${winner.name} (был ${R.ROLE_LABELS[previousRole] || '—'}). Казна (${state.treasury} монет) переходит к нему. ` +
      (previousRole === 'boyar'
        ? 'Требуется ротация: на место боярина — феодала, на место феодала — крестьянина.'
        : previousRole === 'feudal'
          ? 'Требуется ротация: на место феодала — крестьянина.'
          : ''),
    'politics',
  );
  for (const p of E.playerList(state)) E.notify(state, p.id, `Новый царь — ${winner.name}.`, 'politics');
  return done();
}

function executeOverthrow(state) {
  const ov = state.overthrow;
  const tsar = E.tsarOf(state);
  if (!tsar) {
    ov.status = 'failed';
    return fail('царя нет');
  }
  const protectedYear = state.time.year + (Number(state.config.overthrowProtectionYears) || 0);
  for (const bid of Object.keys(ov.votes)) {
    const b = state.players[bid];
    if (b) b.protectedUntilYear = protectedYear;
  }
  // Личные деньги и культуры конфискуются в казну; участки — в государственный фонд.
  state.treasury += tsar.money;
  tsar.money = 0;
  for (const c of R.CROPS) {
    state.stateCrops[c] = (state.stateCrops[c] || 0) + (tsar.crops[c] || 0);
    tsar.crops[c] = 0;
  }
  const plots = E.plotsOf(state, tsar.id).map((l) => l.id);
  movePlotsTo(state, plots, STATE_OWNER);
  tsar.role = 'peasant';
  tsar.lordId = null;
  giveStandardPeasantSet(state, tsar, { confiscate: false });
  ov.status = 'done';
  ov.resolvedAt = Date.now();
  E.pushFeed(state, `Царь ${tsar.name} свергнут боярами и стал крестьянином. Его личные средства конфискованы в казну.`, 'politics');
  startElection(state, 'overthrow');
  return done();
}

function evaluateOverthrow(state) {
  const ov = state.overthrow;
  if (!ov || ov.status !== 'voting') return;
  const bs = E.boyars(state);
  if (!bs.length) {
    ov.status = 'failed';
    E.pushFeed(state, 'Свержение невозможно: нет бояр.', 'politics');
    return;
  }
  const values = bs.map((b) => ov.votes[b.id]);
  if (values.includes(false)) {
    ov.status = 'failed';
    ov.resolvedAt = Date.now();
    E.pushFeed(state, 'Попытка свержения царя провалилась: бояре не единогласны.', 'politics');
    return;
  }
  if (values.every((v) => v === true)) executeOverthrow(state);
}

/* ------------------------------------------------ действия игроков */

const PLAYER_ACTIONS = {
  /* --- общие --- */

  setName(state, p, d) {
    if (p.locked) return fail('мастер зафиксировал ваши параметры');
    const name = String(d.name || '').trim().slice(0, 24);
    if (!name) return fail('пустое имя');
    p.name = name;
    return done('Имя изменено');
  },

  readNotifications(state, p) {
    for (const n of p.notifications) n.read = true;
    return { ok: true, silent: true };
  },

  transfer(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    const to = state.players[d.toId];
    if (!to) return fail('получатель не найден');
    if (to.id === p.id) return fail('нельзя передать себе');
    const b = normBundle(d);
    if (bundleIsEmpty(b)) return fail('нечего передавать');
    const block = tradeBlockReason(state, p, to);
    if (block) return fail(block);
    let err = checkCanGive(state, p, b) || checkPlotsReceivable(state, to, b);
    if (err) return fail(err);
    moveBundle(state, p, to, b);
    E.pushTx(state, { kind: 'transfer', fromId: p.id, toId: to.id, items: b, note: `передача: ${describeBundle(b)}` });
    E.notify(state, to.id, `${p.name} передал вам: ${describeBundle(b)}`, 'ok');
    return done(`Передано: ${describeBundle(b)}`);
  },

  tradeOffer(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    const to = state.players[d.toId];
    if (!to) return fail('получатель не найден');
    if (to.id === p.id) return fail('нельзя торговать с собой');
    const block = tradeBlockReason(state, p, to);
    if (block) return fail(block);
    const give = normBundle(d.give);
    const want = normBundle(d.want);
    if (bundleIsEmpty(give) && bundleIsEmpty(want)) return fail('пустое предложение');
    const err = checkCanGive(state, p, give);
    if (err) return fail(err);
    const r = createRequest(state, {
      kind: 'trade',
      initiatorId: p.id,
      title: `Сделка ${p.name} ⇄ ${to.name}: отдаёт ${describeBundle(give)}, просит ${describeBundle(want)}`,
      data: { toId: to.id, give, want },
      approvals: { [to.id]: 'pending' },
    });
    E.notify(state, to.id, `Предложение сделки от ${p.name}: вы получаете ${describeBundle(give)}, отдаёте ${describeBundle(want)}`, 'request');
    return done('Предложение отправлено');
  },

  respondRequest(state, p, d) {
    const r = state.requests.find((x) => x.id === d.requestId);
    if (!r) return fail('заявка не найдена');
    if (r.status !== 'pending') return fail('заявка уже закрыта');
    const vote = d.approve ? 'yes' : 'no';
    if (Object.prototype.hasOwnProperty.call(r.approvals, p.id)) {
      r.approvals[p.id] = vote;
    } else if (r.needBoyar && p.role === 'boyar' && !r.boyarVote) {
      r.boyarId = p.id;
      r.boyarVote = vote;
    } else {
      return fail('вы не участник этой заявки');
    }
    tryCompleteRequest(state, r);
    return done(d.approve ? 'Подтверждено' : 'Отклонено');
  },

  cancelRequest(state, p, d) {
    const r = state.requests.find((x) => x.id === d.requestId);
    if (!r) return fail('заявка не найдена');
    if (r.initiatorId !== p.id) return fail('отменить может только инициатор');
    if (r.status !== 'pending') return fail('заявка уже закрыта');
    r.status = 'cancelled';
    r.resolvedAt = Date.now();
    return done('Заявка отменена');
  },

  /* --- крестьянин --- */

  plant(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'peasant') return fail('сажать может только крестьянин');
    if (p.sanctions.noFarm) return fail('вам запрещено возделывать землю (санкция)');
    if (state.config.plantOnlyInSpring && season(state) !== 'spring') return fail('сажать можно только Весной');
    const crop = d.crop;
    if (!R.CROPS.includes(crop)) return fail('неизвестная культура');
    const count = Math.max(1, Math.min(50, Math.floor(Number(d.count) || 1)));
    const free = E.plotsOf(state, p.id).filter((l) => !l.planted);
    if (!free.length) return fail('нет свободных участков');
    const n = Math.min(count, free.length, p.crops[crop] || 0);
    if (n <= 0) return fail('нет культуры для посадки');
    for (let i = 0; i < n; i++) {
      free[i].planted = crop;
      free[i].plantedYear = state.time.year;
      p.crops[crop] -= 1;
    }
    E.pushTx(state, { kind: 'plant', fromId: p.id, note: `посадка: ${R.CROP_LABELS[crop]} ×${n}` });
    return done(`Посажено: ${R.CROP_LABELS[crop]} ×${n}`);
  },

  requestBoat(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'peasant') return fail('лодку покупает только крестьянин');
    if (p.sanctions.noBoat) return fail('вам запрещено покупать лодку (санкция)');
    const boyar = state.players[d.boyarId];
    if (!boyar || boyar.role !== 'boyar') return fail('выберите боярина');
    const price = Number(state.config.boatPrice) || 0;
    if (p.money < price) return fail(`нужно ${price} монет`);
    const plotTarget = p.lordId && d.plotTarget === 'lord' ? 'lord' : 'tsar';
    const r = createRequest(state, {
      kind: 'boat_sale',
      initiatorId: p.id,
      title: `Покупка лодки: ${p.name} ← ${boyar.name} (${price} монет)`,
      data: { peasantId: p.id, boyarId: boyar.id, plotTarget },
      approvals: { [boyar.id]: 'pending' },
    });
    E.notify(state, boyar.id, `${p.name} просит продать лодку за ${price} монет.`, 'request');
    return done('Запрос отправлен боярину');
  },

  ransom(state, p) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'peasant') return fail('выкупиться может только крестьянин');
    if (!p.lordId) return fail('вы уже вольный');
    const lord = state.players[p.lordId];
    const price = Math.max(0, Math.floor(Number(state.config.ransomPrice) || 0));
    if (p.money < price) return fail(`нужно ${price} монет`);
    p.money -= price;
    if (lord) lord.money += price;
    else state.treasury += price;
    p.lordId = null;
    E.pushTx(state, { kind: 'ransom', fromId: p.id, toId: lord ? lord.id : 'TREASURY', items: { money: price }, note: 'выкуп из зависимости' });
    if (lord) E.notify(state, lord.id, `${p.name} выкупился за ${price} монет.`, 'economy');
    E.pushFeed(state, `${p.name} выкупился и стал вольным крестьянином.`, 'economy');
    return done('Вы вольный крестьянин');
  },

  requestPatronage(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'peasant') return fail('только крестьянин');
    if (p.lordId) return fail('вы уже принадлежите феодалу');
    const feudal = state.players[d.feudalId];
    if (!feudal || feudal.role !== 'feudal') return fail('выберите феодала');
    createRequest(state, {
      kind: 'patronage',
      initiatorId: p.id,
      title: `Покровительство: ${p.name} → ${feudal.name}`,
      data: { peasantId: p.id, feudalId: feudal.id },
      approvals: { [feudal.id]: 'pending' },
    });
    E.notify(state, feudal.id, `${p.name} просит взять его под покровительство.`, 'request');
    return done('Запрос отправлен');
  },

  requestLordChange(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'peasant') return fail('только крестьянин');
    if (!p.lordId) return fail('вы вольный — используйте запрос покровительства');
    const to = state.players[d.newLordId];
    if (!to || to.role !== 'feudal') return fail('выберите нового феодала');
    if (to.id === p.lordId) return fail('это ваш текущий феодал');
    const from = state.players[p.lordId];
    createRequest(state, {
      kind: 'lord_change',
      initiatorId: p.id,
      title: `Переход крестьянина ${p.name}: ${pname(state, p.lordId)} → ${to.name}`,
      data: { peasantId: p.id, fromLordId: p.lordId, toLordId: to.id },
      approvals: { [p.lordId]: 'pending', [to.id]: 'pending' },
      needBoyar: true,
    });
    if (from) E.notify(state, from.id, `${p.name} просит разрешить переход к ${to.name}.`, 'request');
    E.notify(state, to.id, `${p.name} просит принять его от ${pname(state, p.lordId)}.`, 'request');
    for (const b of E.boyars(state)) E.notify(state, b.id, `Требуется подтверждение перехода крестьянина ${p.name}.`, 'request');
    return done('Запрос отправлен: нужны согласия феодалов и подтверждение боярина');
  },

  /* --- феодал --- */

  offerPatronage(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'feudal') return fail('только феодал');
    const peasant = state.players[d.peasantId];
    if (!peasant || peasant.role !== 'peasant') return fail('выберите крестьянина');
    if (peasant.lordId) return fail('крестьянин уже принадлежит феодалу');
    createRequest(state, {
      kind: 'patronage',
      initiatorId: p.id,
      title: `Покровительство: ${peasant.name} → ${p.name}`,
      data: { peasantId: peasant.id, feudalId: p.id },
      approvals: { [peasant.id]: 'pending' },
    });
    E.notify(state, peasant.id, `Феодал ${p.name} предлагает взять вас под покровительство.`, 'request');
    return done('Предложение отправлено');
  },

  collectTax(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (!['feudal', 'tsar', 'boyar'].includes(p.role)) return fail('ваша роль не собирает налоги');
    return collectTax(state, p, d);
  },

  /* --- купец --- */

  setMarketPresence(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'merchant') return fail('на Рынок ходят только купцы');
    const wantOn = !!d.onMarket;
    if (state.config.travelOnlyInWinter && season(state) !== 'winter') {
      return fail('Переправиться можно только Зимой, когда море открыто');
    }
    p.onMarket = wantOn;
    E.pushTx(state, { kind: 'market_move', fromId: p.id, note: wantOn ? 'отправился на Рынок' : 'вернулся с Рынка' });
    return done(wantOn ? 'Вы на Рынке' : 'Вы вернулись на материк');
  },

  sellToMarket(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'merchant') return fail('продавать системе может только купец');
    if (!p.onMarket) return fail('вы должны находиться на Рынке');
    if (state.config.marketClosedInWinter && season(state) === 'winter') {
      return fail('Зимой Рынок закрыт: продажа системе недоступна');
    }
    const crop = d.crop;
    if (!R.CROPS.includes(crop)) return fail('неизвестная культура');
    const qty = Math.max(1, Math.floor(Number(d.qty) || 0));
    if ((p.crops[crop] || 0) < qty) return fail('недостаточно культуры');
    const quota = Math.max(0, Number(state.config.marketQuotas[crop]) || 0);
    const used = Number(state.market.quotaUsed[crop]) || 0;
    if (used + qty > quota) return fail(`квота исчерпана: осталось ${Math.max(0, quota - used)}`);
    const rate = Math.max(0, Number(state.config.marketRates[crop]) || 0);
    const gain = qty * rate;
    p.crops[crop] -= qty;
    p.money += gain;
    state.market.quotaUsed[crop] = used + qty;
    E.pushTx(state, {
      kind: 'market_sale',
      fromId: p.id,
      toId: 'MARKET',
      items: { crops: { [crop]: qty }, money: gain },
      note: `продажа на Рынке: ${R.CROP_LABELS[crop]} ×${qty} по ${rate} = ${gain}`,
    });
    return done(`Продано ${R.CROP_LABELS[crop]} ×${qty} за ${gain} монет`);
  },

  /* --- боярин --- */

  offerBoat(state, p, d) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'boyar') return fail('лодки продаёт только боярин');
    const peasant = state.players[d.peasantId];
    if (!peasant || peasant.role !== 'peasant') return fail('выберите крестьянина');
    if (peasant.sanctions.noBoat) return fail('этому крестьянину запрещено покупать лодку');
    const price = Number(state.config.boatPrice) || 0;
    createRequest(state, {
      kind: 'boat_sale',
      initiatorId: p.id,
      title: `Продажа лодки: ${p.name} → ${peasant.name} (${price} монет)`,
      data: { peasantId: peasant.id, boyarId: p.id, plotTarget: peasant.lordId ? 'lord' : 'tsar' },
      approvals: { [peasant.id]: 'pending' },
    });
    E.notify(state, peasant.id, `Боярин ${p.name} предлагает купить лодку за ${price} монет.`, 'request');
    return done('Предложение отправлено');
  },

  voteDecree(state, p, d) {
    if (p.role !== 'boyar') return fail('голосуют только бояре');
    const decree = state.decrees.find((x) => x.id === d.decreeId);
    if (!decree) return fail('указ не найден');
    if (decree.status !== 'voting') return fail('голосование закрыто');
    if (!['for', 'against'].includes(d.vote)) return fail('неверный голос');
    decree.votes[p.id] = d.vote;
    evaluateDecree(state, decree);
    return done('Голос учтён');
  },

  startOverthrow(state, p) {
    if (!running(state)) return fail('игра не идёт');
    if (p.role !== 'boyar') return fail('свержение начинают бояре');
    if (state.overthrow && state.overthrow.status === 'voting') return fail('свержение уже идёт');
    if (!E.tsarOf(state)) return fail('царя нет');
    state.overthrow = {
      id: E.uid('ov'),
      status: 'voting',
      createdAt: Date.now(),
      startedBy: p.id,
      votes: { [p.id]: true },
    };
    E.pushFeed(state, `Боярин ${p.name} начал процедуру свержения царя. Нужно единогласие бояр.`, 'politics');
    for (const b of E.boyars(state)) if (b.id !== p.id) E.notify(state, b.id, `${p.name} предлагает свергнуть царя. Проголосуйте.`, 'politics');
    evaluateOverthrow(state);
    return done('Процедура начата');
  },

  voteOverthrow(state, p, d) {
    if (p.role !== 'boyar') return fail('голосуют только бояре');
    const ov = state.overthrow;
    if (!ov || ov.status !== 'voting') return fail('свержение не идёт');
    ov.votes[p.id] = !!d.value;
    evaluateOverthrow(state);
    return done('Голос учтён');
  },

  complain(state, p, d) {
    if (p.role !== 'boyar') return fail('жалобы подают бояре');
    const target = state.players[d.targetId];
    const text = String(d.text || '').trim().slice(0, 300);
    if (!text) return fail('опишите нарушение');
    state.complaints.unshift({
      id: E.uid('c'),
      at: Date.now(),
      year: state.time.year,
      fromId: p.id,
      targetId: target ? target.id : null,
      text,
      status: 'open',
    });
    if (state.complaints.length > 100) state.complaints.length = 100;
    const tsar = E.tsarOf(state);
    if (tsar) E.notify(state, tsar.id, `Жалоба от боярина ${p.name}${target ? ` на ${target.name}` : ''}: ${text}`, 'warn');
    return done('Жалоба отправлена царю');
  },

  /* --- царь --- */

  createDecree(state, p, d) {
    if (p.role !== 'tsar') return fail('указы издаёт царь');
    const title = String(d.title || '').trim().slice(0, 80) || 'Указ';
    const text = String(d.text || '').trim().slice(0, 500);
    const changes = sanitizeDecreeChanges(d.changes);
    const sanction =
      d.sanction && d.sanction.targetId && state.players[d.sanction.targetId]
        ? {
            targetId: d.sanction.targetId,
            noBoat: !!d.sanction.noBoat,
            noTrade: !!d.sanction.noTrade,
            noFarm: !!d.sanction.noFarm,
            notes: String(d.sanction.notes || '').slice(0, 200),
          }
        : null;
    if (!Object.keys(changes).length && !sanction && !text) return fail('укажите содержание указа');
    const decree = {
      id: E.uid('d'),
      title,
      text,
      changes,
      sanction,
      status: 'voting',
      votes: {},
      createdAt: Date.now(),
      year: state.time.year,
      season: season(state),
    };
    state.decrees.unshift(decree);
    E.pushFeed(state, `Царь объявил указ «${title}». Бояре голосуют.`, 'decree');
    for (const b of E.boyars(state)) E.notify(state, b.id, `Новый указ «${title}» — требуется ваш голос.`, 'decree');
    evaluateDecree(state, decree);
    return done('Указ объявлен');
  },

  closeDecreeVoting(state, p, d) {
    if (p.role !== 'tsar') return fail('только царь');
    const decree = state.decrees.find((x) => x.id === d.decreeId);
    if (!decree || decree.status !== 'voting') return fail('нет активного голосования');
    evaluateDecree(state, decree, { close: true });
    return done('Голосование закрыто');
  },

  appoint(state, p, d) {
    if (p.role !== 'tsar') return fail('назначает царь');
    const target = state.players[d.playerId];
    if (!target) return fail('игрок не найден');
    if (target.id === p.id) return fail('нельзя назначить себя');
    const role = d.role;
    if (!['feudal', 'boyar'].includes(role)) return fail('можно назначить феодалом или боярином');
    if (target.role === 'merchant' && !state.config.allowMerchantDowngrade) {
      return fail('купец не может вернуться в другие роли');
    }
    if (target.role === role) return fail('игрок уже в этой роли');
    changeRole(state, target, role);
    E.pushFeed(state, `Царь назначил ${target.name} — ${R.ROLE_LABELS[role]}.`, 'politics');
    E.notify(state, target.id, `Вы назначены: ${R.ROLE_LABELS[role]}.`, 'politics');
    return done('Назначение выполнено');
  },

  dismiss(state, p, d) {
    if (p.role !== 'tsar') return fail('разжалует царь');
    const target = state.players[d.playerId];
    if (!target) return fail('игрок не найден');
    const toRole = d.toRole;
    if (!['feudal', 'peasant'].includes(toRole)) return fail('разжаловать можно в феодалы или крестьяне');
    if (!['boyar', 'feudal'].includes(target.role)) return fail('разжаловать можно боярина или феодала');
    if (target.role === 'boyar' && target.protectedUntilYear >= state.time.year) {
      return fail(`боярин защищён от разжалования до ${target.protectedUntilYear + 1}-го года`);
    }
    const wasRole = target.role;
    if (wasRole === 'boyar' && toRole === 'peasant') {
      changeRole(state, target, 'peasant');
      giveStandardPeasantSet(state, target, { confiscate: true });
      E.pushFeed(state, `Царь разжаловал боярина ${target.name} в крестьяне. Личные ресурсы конфискованы в казну.`, 'politics');
    } else if (wasRole === 'feudal' && toRole === 'peasant') {
      changeRole(state, target, 'peasant');
      giveStandardPeasantSet(state, target, { confiscate: false });
      E.pushFeed(state, `Царь разжаловал феодала ${target.name} в вольные крестьяне. Его крестьяне стали вольными.`, 'politics');
    } else {
      changeRole(state, target, toRole);
      E.pushFeed(state, `Царь разжаловал ${target.name}: ${R.ROLE_LABELS[wasRole]} → ${R.ROLE_LABELS[toRole]}.`, 'politics');
    }
    E.notify(state, target.id, `Вы разжалованы: ${R.ROLE_LABELS[wasRole]} → ${R.ROLE_LABELS[toRole]}.`, 'warn');
    return done('Разжалование выполнено');
  },

  treasuryPay(state, p, d) {
    if (p.role !== 'tsar') return fail('казной распоряжается царь');
    const to = state.players[d.toId];
    if (!to) return fail('получатель не найден');
    const amount = Math.max(0, Math.floor(Number(d.amount) || 0));
    const crops = {};
    let cropTotal = 0;
    for (const c of R.CROPS) {
      crops[c] = Math.max(0, Math.floor(Number(d.crops && d.crops[c]) || 0));
      cropTotal += crops[c];
    }
    if (!amount && !cropTotal) return fail('укажите сумму или культуры');
    if (state.treasury < amount) return fail('в казне недостаточно монет');
    for (const c of R.CROPS) if ((state.stateCrops[c] || 0) < crops[c]) return fail('в казне недостаточно культур');
    state.treasury -= amount;
    to.money += amount;
    for (const c of R.CROPS) {
      state.stateCrops[c] -= crops[c];
      to.crops[c] = (to.crops[c] || 0) + crops[c];
    }
    const desc = describeBundle({ money: amount, crops, plots: [] });
    E.pushTx(state, { kind: 'treasury_pay', fromId: 'TREASURY', toId: to.id, items: { money: amount, crops }, note: `из казны: ${desc}` });
    E.notify(state, to.id, `Из казны вам выделено: ${desc}`, 'ok');
    E.pushFeed(state, `Царь выделил из казны ${desc} → ${to.name}.`, 'economy');
    return done('Выплата произведена');
  },

  treasuryDeposit(state, p, d) {
    if (p.role !== 'tsar') return fail('только царь');
    const amount = Math.max(0, Math.floor(Number(d.amount) || 0));
    if (!amount) return fail('укажите сумму');
    if (p.money < amount) return fail('недостаточно личных монет');
    p.money -= amount;
    state.treasury += amount;
    E.pushTx(state, { kind: 'treasury_deposit', fromId: p.id, toId: 'TREASURY', items: { money: amount }, note: 'пополнение казны' });
    return done('Казна пополнена');
  },

  resolveComplaint(state, p, d) {
    if (p.role !== 'tsar') return fail('только царь');
    const c = state.complaints.find((x) => x.id === d.complaintId);
    if (!c) return fail('жалоба не найдена');
    c.status = 'closed';
    c.resolution = String(d.resolution || '').slice(0, 200);
    return done('Жалоба закрыта');
  },

  /* --- выборы --- */

  voteElection(state, p, d) {
    const el = state.election;
    if (!el || el.status !== 'voting') return fail('выборы не идут');
    if (el.candidates.includes(p.id)) return fail('кандидаты не голосуют');
    if (!el.candidates.includes(d.candidateId)) return fail('это не кандидат');
    el.votes[p.id] = d.candidateId;
    const voters = E.playerList(state).filter((x) => !el.candidates.includes(x.id));
    if (voters.every((v) => el.votes[v.id])) finishElection(state);
    return done('Голос учтён');
  },
};

function handlePlayerAction(state, player, type, data) {
  const handler = PLAYER_ACTIONS[type];
  if (!handler) return fail(`неизвестное действие: ${type}`);
  try {
    return handler(state, player, data || {}) || { ok: true };
  } catch (e) {
    return fail(`ошибка: ${e.message}`);
  }
}

module.exports = {
  STATE_OWNER,
  handlePlayerAction,
  PLAYER_ACTIONS,
  normBundle,
  resolvePlotCount,
  describeBundle,
  bundleIsEmpty,
  checkCanGive,
  checkPlotsReceivable,
  moveBundle,
  tradeBlockReason,
  changeRole,
  giveStandardPeasantSet,
  movePlotsTo,
  stateFundOwnerId,
  taxRemaining,
  taxContext,
  taxState,
  collectTax,
  evaluateDecree,
  applyDecree,
  rejectDecree,
  describeDecree,
  sanitizeDecreeChanges,
  CONFIG_LABELS,
  CONFIG_NUMERIC_KEYS,
  startElection,
  finishElection,
  evaluateOverthrow,
  executeOverthrow,
  createRequest,
  tryCompleteRequest,
  canHoldLand,
};
