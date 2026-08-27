'use strict';

const CROPS = ['carrot', 'potato', 'beet', 'pea'];

const CROP_LABELS = {
  carrot: 'Морковь',
  potato: 'Картошка',
  beet: 'Свёкла',
  pea: 'Горох',
};

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

const SEASON_LABELS = {
  spring: 'Весна',
  summer: 'Лето',
  autumn: 'Осень',
  winter: 'Зима',
};

const ROLES = ['tsar', 'boyar', 'feudal', 'merchant', 'peasant'];

const ROLE_LABELS = {
  tsar: 'Царь',
  boyar: 'Боярин',
  feudal: 'Феодал',
  merchant: 'Купец',
  peasant: 'Крестьянин',
};

/** Роли, которым разрешено держать участки. Бояре и купцы землёй владеть не могут. */
const LAND_HOLDING_ROLES = ['peasant', 'feudal', 'tsar'];

/** Роли, которые могут возделывать (сажать) землю. */
const FARMING_ROLES = ['peasant'];

function emptyCrops() {
  const out = {};
  for (const c of CROPS) out[c] = 0;
  return out;
}

function defaultConfig() {
  return {
    // Время
    seasonDurationSec: 300,
    totalYears: 10,

    // Земля и урожай
    harvestYield: 2,
    plantOnlyInSpring: true,

    // Стартовые наборы
    startPeasantPlots: 2,
    startPeasantCropEach: 1,
    startPeasantMoney: 0,
    startFeudalMoney: 0,
    startBoyarMoney: 0,
    startMerchantMoney: 100,
    startTsarMoney: 200,
    startTreasury: 0,
    tsarPlotsPerPeasant: 1,

    // Экономика
    boatPrice: 50,
    ransomPrice: 20,

    // Налоги (лимиты на одного подопечного в год)
    feudalTaxCropsPerYear: 1,
    feudalTaxMoneyPerYear: 5,
    tsarTaxCropsPerYear: 1,
    tsarTaxMoneyPerYear: 5,
    taxOncePerSeason: true,
    freePeasantTaxEnabled: false,
    freeTaxCropsPerYear: 1,
    freeTaxMoneyPerYear: 5,

    // Рынок
    marketRates: { carrot: 5, potato: 5, beet: 5, pea: 5 },
    marketQuotas: { carrot: 100, potato: 100, beet: 100, pea: 100 },
    marketClosedInWinter: true,
    travelOnlyInWinter: true,

    // Прочее
    allowMerchantDowngrade: false,
    overthrowProtectionYears: 1,

    // Подсчёт итогов
    scoring: {
      plotValue: 20,
      boatValue: 50,
      cropValueFromMarket: true,
      cropValue: 5,
    },
  };
}

/**
 * Раскладка ролей по числу игроков.
 * Царь — всегда один. На одного феодала — 4 крестьянина.
 * Бояр вдвое меньше, чем феодалов. По 1 купцу на каждые 8 игроков.
 * Остаток отдаётся крестьянам (наиболее близкое к идеальной пропорции целое решение).
 */
function computeRoleCounts(playerCount) {
  const n = Math.max(0, Math.floor(playerCount));
  const counts = { tsar: 0, boyar: 0, feudal: 0, merchant: 0, peasant: 0 };
  if (n === 0) return counts;
  counts.tsar = 1;
  if (n === 1) return counts;

  counts.merchant = Math.floor(n / 8);
  let rest = n - counts.tsar - counts.merchant;
  if (rest < 0) {
    counts.merchant += rest;
    rest = 0;
  }

  let best = null;
  for (let f = 0; f <= rest; f++) {
    const b = Math.round(f / 2);
    const p = rest - f - b;
    if (p < 0) break;
    const score = Math.abs(p - 4 * f);
    if (best === null || score <= best.score) best = { f, b, p, score };
  }
  counts.feudal = best.f;
  counts.boyar = best.b;
  counts.peasant = best.p;
  return counts;
}

module.exports = {
  CROPS,
  CROP_LABELS,
  SEASONS,
  SEASON_LABELS,
  ROLES,
  ROLE_LABELS,
  LAND_HOLDING_ROLES,
  FARMING_ROLES,
  emptyCrops,
  defaultConfig,
  computeRoleCounts,
};
