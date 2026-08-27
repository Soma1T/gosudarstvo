'use strict';

const R = require('./rules');
const E = require('./engine');
const A = require('./actions');

function timeView(state) {
  const t = state.time;
  const remainingMs = t.paused
    ? (t.remainingMs ?? 0)
    : t.seasonEndsAt
      ? Math.max(0, t.seasonEndsAt - Date.now())
      : 0;
  return {
    year: t.year,
    seasonIndex: t.seasonIndex,
    season: R.SEASONS[t.seasonIndex],
    seasonLabel: R.SEASON_LABELS[R.SEASONS[t.seasonIndex]],
    paused: t.paused,
    remainingMs,
    seasonDurationSec: state.config.seasonDurationSec,
    totalYears: state.config.totalYears,
  };
}

function publicConfig(state, { includeMarketPrices = false } = {}) {
  const c = state.config;
  const out = {
    boatPrice: c.boatPrice,
    ransomPrice: c.ransomPrice,
    harvestYield: c.harvestYield,
    feudalTaxCropsPerYear: c.feudalTaxCropsPerYear,
    feudalTaxMoneyPerYear: c.feudalTaxMoneyPerYear,
    tsarTaxCropsPerYear: c.tsarTaxCropsPerYear,
    tsarTaxMoneyPerYear: c.tsarTaxMoneyPerYear,
    freePeasantTaxEnabled: c.freePeasantTaxEnabled,
    freeTaxCropsPerYear: c.freeTaxCropsPerYear,
    freeTaxMoneyPerYear: c.freeTaxMoneyPerYear,
    marketClosedInWinter: c.marketClosedInWinter,
    travelOnlyInWinter: c.travelOnlyInWinter,
    plantOnlyInSpring: c.plantOnlyInSpring,
    totalYears: c.totalYears,
    seasonDurationSec: c.seasonDurationSec,
  };
  // Мировой курс и квоты Рынка — только купцам (для продажи системе).
  if (includeMarketPrices) {
    out.marketRates = { ...c.marketRates };
    out.marketQuotas = { ...c.marketQuotas };
  }
  return out;
}

function publicPlayer(state, p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    lordId: p.lordId,
    onMarket: p.role === 'merchant' ? p.onMarket : false,
    hasBoat: p.hasBoat,
    connected: p.connected,
    plotsCount: E.plotsOf(state, p.id).length,
    sanctions: { ...p.sanctions },
    protectedUntilYear: p.protectedUntilYear,
  };
}

function marketView(state, { includePrices = false } = {}) {
  const season = R.SEASONS[state.time.seasonIndex];
  const out = {
    open: !(state.config.marketClosedInWinter && season === 'winter'),
    travelOpen: !state.config.travelOnlyInWinter || season === 'winter',
    merchantsOnMarket: E.playersByRole(state, 'merchant').filter((m) => m.onMarket).map((m) => ({ id: m.id, name: m.name })),
  };
  // Курсы, квоты и остатки — только купцам и мастеру.
  if (includePrices) {
    const rates = {};
    const quotas = {};
    const left = {};
    for (const c of R.CROPS) {
      rates[c] = state.config.marketRates[c];
      quotas[c] = state.config.marketQuotas[c];
      left[c] = Math.max(0, (state.config.marketQuotas[c] || 0) - (state.market.quotaUsed[c] || 0));
    }
    out.rates = rates;
    out.quotas = quotas;
    out.quotaLeft = left;
    out.quotaUsed = { ...state.market.quotaUsed };
  }
  return out;
}

function wardsView(state, collector) {
  let wards = [];
  if (collector.role === 'feudal') wards = E.subordinates(state, collector.id);
  else if (collector.role === 'tsar') wards = E.playersByRole(state, 'feudal');
  else if (collector.role === 'boyar' && state.config.freePeasantTaxEnabled) {
    wards = E.playersByRole(state, 'peasant').filter((p) => !p.lordId);
  }
  return wards.map((w) => {
    const rem = A.taxRemaining(state, collector, w);
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      connected: w.connected,
      plots: E.plotsOf(state, w.id).length,
      taxLeft: rem.error ? null : { crops: rem.crops, money: rem.money, collectedThisSeason: rem.collectedThisSeason },
      taxError: rem.error || null,
    };
  });
}

function decreeView(state, d) {
  const bs = E.boyars(state);
  return {
    id: d.id,
    title: d.title,
    text: d.text,
    changes: d.changes,
    changesText: A.describeDecree(state, d),
    sanction: d.sanction,
    status: d.status,
    createdAt: d.createdAt,
    year: d.year,
    season: d.season,
    votes: d.votes,
    voters: bs.map((b) => ({ id: b.id, name: b.name, vote: d.votes[b.id] || null })),
  };
}

function requestView(state, r) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    initiatorId: r.initiatorId,
    initiatorName: state.players[r.initiatorId] ? state.players[r.initiatorId].name : '—',
    data: r.data,
    approvals: r.approvals,
    approvalNames: Object.fromEntries(
      Object.keys(r.approvals).map((id) => [id, state.players[id] ? state.players[id].name : '—']),
    ),
    needBoyar: r.needBoyar,
    boyarId: r.boyarId,
    boyarVote: r.boyarVote,
    error: r.error || null,
  };
}

function txView(state, t) {
  const nameOf = (id) => {
    if (!id) return null;
    if (id === 'TREASURY') return 'Казна';
    if (id === 'MARKET') return 'Рынок';
    if (id === A.STATE_OWNER) return 'Гос. фонд';
    return state.players[id] ? state.players[id].name : '—';
  };
  return {
    id: t.id,
    at: t.at,
    year: t.year,
    season: t.season,
    kind: t.kind,
    fromId: t.fromId || null,
    toId: t.toId || null,
    fromName: nameOf(t.fromId),
    toName: nameOf(t.toId),
    items: t.items || null,
    items2: t.items2 || null,
    note: t.note || '',
    byMaster: !!t.byMaster,
  };
}

function electionView(state) {
  const el = state.election;
  if (!el) return null;
  const tally = {};
  for (const cid of Object.values(el.votes)) tally[cid] = (tally[cid] || 0) + 1;
  return {
    id: el.id,
    status: el.status,
    reason: el.reason,
    candidates: el.candidates.map((id) => ({
      id,
      name: state.players[id] ? state.players[id].name : '—',
      role: state.players[id] ? state.players[id].role : null,
      votes: tally[id] || 0,
    })),
    votedCount: Object.keys(el.votes).length,
    voterCount: E.playerList(state).filter((p) => !el.candidates.includes(p.id)).length,
    winnerId: el.winnerId || null,
    winnerName: el.winnerId && state.players[el.winnerId] ? state.players[el.winnerId].name : null,
  };
}

function overthrowView(state) {
  const ov = state.overthrow;
  if (!ov) return null;
  return {
    id: ov.id,
    status: ov.status,
    startedBy: ov.startedBy,
    startedByName: state.players[ov.startedBy] ? state.players[ov.startedBy].name : 'мастер',
    votes: E.boyars(state).map((b) => ({ id: b.id, name: b.name, vote: ov.votes[b.id] })),
  };
}

function buildPlayerView(state, playerId) {
  const me = state.players[playerId];
  if (!me) return { type: 'kicked' };
  const myPlots = E.plotsOf(state, me.id).map((l) => ({ id: l.id, planted: l.planted, plantedYear: l.plantedYear }));
  const all = E.playerList(state);
  const myRequests = state.requests.filter((r) => {
    if (r.initiatorId === me.id) return true;
    if (Object.prototype.hasOwnProperty.call(r.approvals, me.id)) return true;
    if (r.needBoyar && me.role === 'boyar' && r.status === 'pending') return true;
    if (r.boyarId === me.id) return true;
    return false;
  });

  const seeMarketPrices = me.role === 'merchant';

  const view = {
    type: 'state',
    phase: state.phase,
    time: timeView(state),
    config: publicConfig(state, { includeMarketPrices: seeMarketPrices }),
    me: {
      id: me.id,
      name: me.name,
      role: me.role,
      roleLabel: me.role ? R.ROLE_LABELS[me.role] : null,
      money: me.money,
      crops: { ...me.crops },
      hasBoat: me.hasBoat,
      onMarket: me.onMarket,
      lordId: me.lordId,
      lordName: me.lordId && state.players[me.lordId] ? state.players[me.lordId].name : null,
      sanctions: { ...me.sanctions },
      plots: myPlots,
      tax: { ...me.tax },
      protectedUntilYear: me.protectedUntilYear,
      notifications: me.notifications,
      wealth: state.phase === 'lobby' ? 0 : E.playerWealth(state, me),
      locked: me.locked,
    },
    players: all.map((p) => publicPlayer(state, p)),
    market: marketView(state, { includePrices: seeMarketPrices }),
    feed: state.feed.slice(0, 40),
    decrees: state.decrees.slice(0, 20).map((d) => decreeView(state, d)),
    requests: myRequests.slice(0, 30).map((r) => requestView(state, r)),
    transactions: state.transactions
      .filter((t) => t.fromId === me.id || t.toId === me.id)
      .slice(0, 40)
      .map((t) => txView(state, t)),
    election: electionView(state),
    overthrow: overthrowView(state),
    results: state.results,
    treasury: me.role === 'tsar' || me.role === 'boyar' ? state.treasury : null,
    stateCrops: me.role === 'tsar' ? { ...state.stateCrops } : null,
    wards: ['feudal', 'tsar', 'boyar'].includes(me.role) ? wardsView(state, me) : [],
    complaints: me.role === 'tsar' ? state.complaints.slice(0, 30) : [],
    stateFundPlots: me.role === 'tsar' ? E.plotsOf(state, A.STATE_OWNER).length : null,
  };
  return view;
}

function buildMasterView(state) {
  const all = E.playerList(state);
  return {
    type: 'master_state',
    phase: state.phase,
    time: timeView(state),
    config: state.config,
    treasury: state.treasury,
    stateCrops: { ...state.stateCrops },
    market: marketView(state, { includePrices: true }),
    roleSuggestion: R.computeRoleCounts(all.length),
    players: all.map((p) => ({
      ...p,
      token: undefined,
      roleLabel: p.role ? R.ROLE_LABELS[p.role] : null,
      lordName: p.lordId && state.players[p.lordId] ? state.players[p.lordId].name : null,
      plots: E.plotsOf(state, p.id).map((l) => ({ id: l.id, planted: l.planted })),
      wealth: E.playerWealth(state, p),
      unread: p.notifications.filter((n) => !n.read).length,
      taxLeftFromLord:
        p.role === 'peasant' && p.lordId && state.players[p.lordId]
          ? A.taxRemaining(state, state.players[p.lordId], p)
          : null,
    })),
    stateFund: E.plotsOf(state, A.STATE_OWNER).map((l) => ({ id: l.id, planted: l.planted })),
    decrees: state.decrees.map((d) => decreeView(state, d)),
    requests: state.requests.slice(0, 60).map((r) => requestView(state, r)),
    transactions: state.transactions.slice(0, 120).map((t) => txView(state, t)),
    feed: state.feed.slice(0, 60),
    complaints: state.complaints.slice(0, 40),
    election: electionView(state),
    overthrow: overthrowView(state),
    results: state.results,
    labels: {
      crops: R.CROP_LABELS,
      roles: R.ROLE_LABELS,
      seasons: R.SEASON_LABELS,
      config: A.CONFIG_LABELS,
    },
  };
}

module.exports = { buildPlayerView, buildMasterView, timeView, marketView };
