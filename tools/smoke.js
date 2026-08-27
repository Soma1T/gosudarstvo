'use strict';

/**
 * Сквозная проверка сервера: поднимает сервер, подключает мастера и 12 игроков,
 * запускает игру и прогоняет основные механики. Запуск: node tools/smoke.js
 */

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3111;
const PIN = '1234';
const BASE = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждёт, пока сервер начнёт принимать соединения. */
async function waitForServer(timeoutMs = 20000) {
  const net = require('net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 800);
    });
    if (up) return true;
    await sleep(300);
  }
  return false;
}

class Client {
  constructor(label) {
    this.label = label;
    this.state = null;
    this.toasts = [];
    this.errors = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state' || msg.type === 'master_state') this.state = msg;
        else if (msg.type === 'welcome') this.token = msg.token;
        else if (msg.type === 'toast') {
          this.toasts.push(msg);
          if (msg.kind === 'error') this.errors.push(msg.message);
        }
      });
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  act(action, data = {}) {
    this.send({ type: 'action', action, data });
  }
  mact(action, data = {}) {
    this.send({ type: 'master_action', action, data });
  }
  lastError() {
    return this.errors[this.errors.length - 1];
  }
}

async function main() {
  // чистое состояние
  const fs = require('fs');
  const save = path.join(__dirname, '..', 'data', 'save.json');
  if (fs.existsSync(save)) fs.renameSync(save, save + '.smokebak');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MASTER_PIN: PIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  if (!(await waitForServer())) {
    console.error('Сервер не запустился. Лог:\n' + serverLog);
    process.exit(1);
  }
  await sleep(300);

  try {
    console.log('\n[1] Подключение мастера и игроков');
    const master = new Client('master');
    await master.connect();
    master.send({ type: 'auth_master', pin: PIN });
    await sleep(200);
    check('мастер авторизован', !!master.state, master.lastError() || '');

    const N = 12;
    const players = [];
    for (let i = 0; i < N; i++) {
      const c = new Client(`p${i}`);
      await c.connect();
      c.send({ type: 'join', name: `Игрок${i + 1}` });
      players.push(c);
    }
    await sleep(400);
    check(`${N} игроков в комнате`, master.state.players.length === N, `реально ${master.state.players.length}`);
    check('токены выданы', players.every((p) => p.token));

    console.log('\n[2] Переподключение по токену');
    const rec = new Client('reconnect');
    await rec.connect();
    rec.send({ type: 'auth', token: players[0].token });
    await sleep(200);
    check('игрок вернулся в свою сессию', rec.state && rec.state.me.name === 'Игрок1');

    console.log('\n[3] Старт игры и раздача ролей');
    master.mact('startGame', {});
    await sleep(400);
    const st = master.state;
    const byRole = (r) => st.players.filter((p) => p.role === r);
    check('фаза running', st.phase === 'running');
    check('ровно один царь', byRole('tsar').length === 1);
    check('есть феодалы', byRole('feudal').length >= 1);
    check('есть бояре', byRole('boyar').length >= 1);
    check('купцов = floor(N/8)', byRole('merchant').length === Math.floor(N / 8), `${byRole('merchant').length}`);
    check('у всех есть роль', st.players.every((p) => p.role));
    const peasants = byRole('peasant');
    check(
      'у крестьян по 2 участка и по 1 культуре',
      peasants.every((p) => p.plots.length === 2 && p.crops.carrot === 1 && p.crops.pea === 1),
    );
    check('крестьяне распределены по феодалам', peasants.every((p) => p.lordId));
    check(
      'царь: 200 монет и участки по числу крестьян',
      byRole('tsar')[0].money === 200 && byRole('tsar')[0].plots.length === peasants.length,
      `${byRole('tsar')[0].plots.length} уч.`,
    );
    check('купец: лодка и 100 монет', byRole('merchant').every((m) => m.hasBoat && m.money === 100));

    const cl = (id) => players.find((p) => p.state && p.state.me.id === id) || null;
    await sleep(200);
    const tsarC = cl(byRole('tsar')[0].id);
    const feudalC = cl(byRole('feudal')[0].id);
    const boyarC = cl(byRole('boyar')[0].id);
    const merchantC = byRole('merchant').length ? cl(byRole('merchant')[0].id) : null;
    const peasantId = st.players.find((p) => p.role === 'peasant' && p.lordId === byRole('feudal')[0].id).id;
    const peasantC = cl(peasantId);
    check('интерфейсы игроков получили состояние', !!tsarC && !!feudalC && !!boyarC && !!peasantC);

    console.log('\n[4] Весна: посадка и урожай');
    // у крестьянина на старте по 1 культуре каждого вида — добавим запас для посадки на 2 участка
    master.mact('addCrops', { playerId: peasantId, crops: { carrot: 3 } });
    await sleep(200);
    peasantC.act('plant', { crop: 'carrot', count: 2 });
    await sleep(250);
    check('посажено на 2 участка', master.state.players.find((p) => p.id === peasantId).plots.filter((l) => l.planted === 'carrot').length === 2);
    check('культура списана со склада (4 − 2 = 2)', master.state.players.find((p) => p.id === peasantId).crops.carrot === 2);

    // Лето → сажать нельзя
    master.mact('nextSeason');
    await sleep(250);
    peasantC.act('plant', { crop: 'potato', count: 1 });
    await sleep(200);
    check('летом посадка запрещена', /Весной/.test(peasantC.lastError() || ''), peasantC.lastError());

    // Осень → авто-урожай
    master.mact('nextSeason');
    await sleep(300);
    const afterHarvest = master.state.players.find((p) => p.id === peasantId);
    check('осенью собран урожай 1→2 (2 + 2×2 = 6)', afterHarvest.crops.carrot === 6, `${afterHarvest.crops.carrot}`);
    check('участки освободились', afterHarvest.plots.every((l) => !l.planted));

    console.log('\n[5] Налоги');
    feudalC.act('collectTax', { payerId: peasantId, money: 0, crops: { carrot: 1 } });
    await sleep(250);
    let fe = master.state.players.find((p) => p.id === feudalC.state.me.id);
    check('феодал получил 1 морковь налогом', fe.crops.carrot === 1, `${fe.crops.carrot}`);
    feudalC.act('collectTax', { payerId: peasantId, money: 0, crops: { potato: 1 } });
    await sleep(200);
    check('повторный сбор в сезоне запрещён', /сезоне/.test(feudalC.lastError() || ''), feudalC.lastError());
    master.mact('setTime', { year: 1, seasonIndex: 3 });
    await sleep(250);
    feudalC.act('collectTax', { payerId: peasantId, money: 0, crops: { potato: 1 } });
    await sleep(250);
    check('годовой лимит культур (1) исчерпан', /лимит/i.test(feudalC.lastError() || ''), feudalC.lastError());

    console.log('\n[6] Рынок и купец');
    check('курс скрыт от крестьянина', !peasantC.state.market.rates);
    check('курс скрыт от царя', !tsarC.state.market.rates);
    check('курс скрыт от боярина', !boyarC.state.market.rates);
    if (merchantC) {
      check('курс скрыт от купца на материке', !merchantC.state.market.rates);
      merchantC.act('setMarketPresence', { onMarket: true });
      await sleep(250);
      check('зимой купец отправился на Рынок', master.state.players.find((p) => p.id === merchantC.state.me.id).onMarket);
      check('на закрытом Рынке курс всё ещё скрыт', !merchantC.state.market.rates);
      master.mact('addCrops', { playerId: merchantC.state.me.id, crops: { beet: 10 } });
      await sleep(250);
      merchantC.act('sellToMarket', { crop: 'beet', qty: 3 });
      await sleep(300);
      check('зимой продажа системе закрыта', /Рынок закрыт/.test(merchantC.lastError() || ''), merchantC.lastError());
      master.mact('setTime', { year: 2, seasonIndex: 0 });
      await sleep(350);
      check('на открытом Рынке купец видит курс и квоты', !!merchantC.state.market.rates && !!merchantC.state.market.quotaLeft);
      const before = master.state.players.find((p) => p.id === merchantC.state.me.id).money;
      merchantC.act('sellToMarket', { crop: 'beet', qty: 3 });
      await sleep(250);
      const after = master.state.players.find((p) => p.id === merchantC.state.me.id).money;
      check('продажа 3 свёклы по 5 = +15 монет', after - before === 15, `+${after - before}`);
      check('квота уменьшилась на 3', master.state.market.quotaUsed.beet === 3);

      // обмен с купцом на рынке запрещён для не-купцов
      peasantC.act('transfer', { toId: merchantC.state.me.id, money: 0, crops: { carrot: 1 } });
      await sleep(250);
      check('пока купец на Рынке — обмен с ним закрыт', /Рынке/.test(peasantC.lastError() || ''), peasantC.lastError());
    } else {
      console.log('  (купцов нет при таком числе игроков — пропуск)');
    }

    console.log('\n[7] Обмен между игроками');
    const otherPeasantId = master.state.players.find((p) => p.role === 'peasant' && p.id !== peasantId).id;
    peasantC.act('transfer', { toId: otherPeasantId, money: 0, crops: { carrot: 1 } });
    await sleep(250);
    check('передача культуры прошла', master.state.players.find((p) => p.id === otherPeasantId).crops.carrot >= 1);

    const otherPeasantC = cl(otherPeasantId);
    master.mact('addCrops', { playerId: peasantId, crops: { carrot: 2 } });
    master.mact('addCrops', { playerId: otherPeasantId, crops: { pea: 2 } });
    await sleep(250);
    peasantC.act('tradeOffer', { toId: otherPeasantId, give: { crops: { carrot: 1 } }, want: { crops: { pea: 1 } } });
    await sleep(300);
    const req = otherPeasantC.state.requests.find((r) => r.status === 'pending');
    check('предложение сделки доставлено', !!req);
    if (req) {
      otherPeasantC.act('respondRequest', { requestId: req.id, approve: true });
      await sleep(250);
      const me1 = master.state.players.find((p) => p.id === peasantId);
      check('сделка исполнена после подтверждения', me1.crops.pea >= 1);
    }

    console.log('\n[7b] Обмен без встречного запроса — сразу передача');
    master.mact('addCrops', { playerId: peasantId, crops: { potato: 2 } });
    await sleep(250);
    const potatoBefore = master.state.players.find((p) => p.id === otherPeasantId).crops.potato;
    peasantC.act('tradeOffer', { toId: otherPeasantId, give: { crops: { potato: 1 } }, want: {} });
    await sleep(300);
    check(
      'без встречного запроса передача проходит сразу',
      master.state.players.find((p) => p.id === otherPeasantId).crops.potato === potatoBefore + 1,
    );

    console.log('\n[8] Лодка → купец');
    master.mact('addMoney', { playerId: peasantId, delta: 100 });
    await sleep(200);
    peasantC.act('requestBoat', { boyarId: boyarC.state.me.id, plotTarget: 'lord' });
    await sleep(250);
    const boatReq = boyarC.state.requests.find((r) => r.kind === 'boat_sale' && r.status === 'pending');
    check('боярин получил заявку на лодку', !!boatReq);
    if (boatReq) {
      const boyarMoneyBefore = boyarC.state.me.money;
      boyarC.act('respondRequest', { requestId: boatReq.id, approve: true });
      await sleep(300);
      const nowP = master.state.players.find((p) => p.id === peasantId);
      check('крестьянин стал купцом', nowP.role === 'merchant' && nowP.hasBoat);
      check('участки ушли (купец без земли)', nowP.plots.length === 0);
      check('боярин получил 50 монет', master.state.players.find((p) => p.id === boyarC.state.me.id).money === boyarMoneyBefore + 50);
    }

    console.log('\n[9] Указы и голосование бояр');
    tsarC.act('createDecree', { title: 'О цене лодок', changes: { boatPrice: 70 } });
    await sleep(300);
    let decree = master.state.decrees[0];
    check('указ создан и на голосовании', decree && (decree.status === 'voting' || decree.status === 'passed'));
    if (decree && decree.status === 'voting') {
      for (const b of master.state.players.filter((p) => p.role === 'boyar')) {
        const bc = cl(b.id);
        if (bc) bc.act('voteDecree', { decreeId: decree.id, vote: 'for' });
      }
      await sleep(350);
    }
    check('указ принят и цена лодки изменилась', master.state.config.boatPrice === 70, `${master.state.config.boatPrice}`);

    tsarC.act('createDecree', { title: 'Санкции', sanction: { targetId: otherPeasantId, noTrade: true } });
    await sleep(300);
    const d2 = master.state.decrees.find((d) => d.title === 'Санкции');
    if (d2 && d2.status === 'voting') {
      for (const b of master.state.players.filter((p) => p.role === 'boyar')) {
        const bc = cl(b.id);
        if (bc) bc.act('voteDecree', { decreeId: d2.id, vote: 'for' });
      }
      await sleep(350);
    }
    check('санкция применена', master.state.players.find((p) => p.id === otherPeasantId).sanctions.noTrade === true);

    console.log('\n[10] Выкуп, покровительство, назначения');
    const serf = master.state.players.find((p) => p.role === 'peasant' && p.lordId);
    if (serf) {
      const serfC = cl(serf.id);
      const lordId = serf.lordId;
      master.mact('addMoney', { playerId: serf.id, delta: 50 });
      master.mact('addPlots', { playerId: serf.id, count: 2 });
      await sleep(300);
      const serfPlots = master.state.players.find((p) => p.id === serf.id).plots.length;
      const lordPlotsBefore = master.state.players.find((p) => p.id === lordId).plots.length;
      serfC.act('ransom');
      await sleep(300);
      check('крестьянин выкупился (стал вольным)', master.state.players.find((p) => p.id === serf.id).lordId === null);
      check('после выкупа у него не осталось участков', master.state.players.find((p) => p.id === serf.id).plots.length === 0);
      check(
        `все ${serfPlots} участков перешли феодалу`,
        master.state.players.find((p) => p.id === lordId).plots.length === lordPlotsBefore + serfPlots,
        `у феодала ${master.state.players.find((p) => p.id === lordId).plots.length}, было ${lordPlotsBefore}`,
      );
    }
    const freeP = master.state.players.find((p) => p.role === 'peasant' && !p.lordId);
    if (freeP) {
      tsarC.act('appoint', { playerId: freeP.id, role: 'feudal' });
      await sleep(300);
      check('царь назначил феодала', master.state.players.find((p) => p.id === freeP.id).role === 'feudal');
      tsarC.act('dismiss', { playerId: freeP.id, toRole: 'peasant' });
      await sleep(300);
      check('царь разжаловал в крестьяне', master.state.players.find((p) => p.id === freeP.id).role === 'peasant');
    }

    console.log('\n[11] Казна');
    master.mact('setTreasury', { value: 300 });
    await sleep(200);
    tsarC.act('treasuryPay', { toId: otherPeasantId, amount: 100 });
    await sleep(250);
    check('выплата из казны', master.state.treasury === 200, `казна ${master.state.treasury}`);

    console.log('\n[11b] Разжалование бояр: не больше одного за сезон');
    const toBoyars = master.state.players.filter((p) => p.role === 'peasant').slice(0, 2);
    for (const b of toBoyars) master.mact('setPlayerRole', { playerId: b.id, role: 'boyar' });
    await sleep(400);
    const freshBoyars = master.state.players.filter((p) => p.role === 'boyar' && p.protectedUntilYear < master.state.time.year);
    if (freshBoyars.length >= 2) {
      tsarC.act('dismiss', { playerId: freshBoyars[0].id, toRole: 'feudal' });
      await sleep(300);
      check('первое разжалование боярина прошло', master.state.players.find((p) => p.id === freshBoyars[0].id).role === 'feudal');
      tsarC.act('dismiss', { playerId: freshBoyars[1].id, toRole: 'feudal' });
      await sleep(300);
      check('второе разжалование в том же сезоне запрещено', /сезон/.test(tsarC.lastError() || ''), tsarC.lastError());
      master.mact('nextSeason');
      await sleep(400);
      tsarC.act('dismiss', { playerId: freshBoyars[1].id, toRole: 'feudal' });
      await sleep(300);
      check('в новом сезоне разжалование снова доступно', master.state.players.find((p) => p.id === freshBoyars[1].id).role === 'feudal');
    } else {
      console.log('  (не удалось получить двух бояр — пропуск)');
    }
    // восстанавливаем бояр для проверки свержения
    const restore = master.state.players.filter((p) => ['feudal', 'peasant'].includes(p.role)).slice(0, 2);
    for (const b of restore) master.mact('setPlayerRole', { playerId: b.id, role: 'boyar' });
    await sleep(400);
    check('бояре восстановлены для следующей проверки', master.state.players.filter((p) => p.role === 'boyar').length >= 1);

    console.log('\n[12] Свержение царя и выборы');
    const oldTsarId = master.state.players.find((p) => p.role === 'tsar').id;
    const boyarList = master.state.players.filter((p) => p.role === 'boyar');
    const bc0 = cl(boyarList[0].id);
    bc0.act('startOverthrow');
    await sleep(300);
    for (const b of boyarList.slice(1)) {
      const bcx = cl(b.id);
      if (bcx) bcx.act('voteOverthrow', { value: true });
    }
    await sleep(400);
    check('царь свергнут и стал крестьянином', master.state.players.find((p) => p.id === oldTsarId).role === 'peasant');
    check('начались выборы', master.state.election && master.state.election.status === 'voting');
    if (master.state.election) {
      // на время выборов остальные действия должны быть заблокированы
      const voterList = master.state.players.filter((p) => !master.state.election.candidates.some((c) => c.id === p.id));
      const blockedC = voterList.map((v) => cl(v.id)).find((x) => x);
      if (blockedC) {
        blockedC.act('transfer', { toId: oldTsarId, money: 1 });
        await sleep(300);
        check('до голосования все действия заблокированы', /выборы/i.test(blockedC.lastError() || ''), blockedC.lastError());
      }
      const cand = master.state.election.candidates[0];
      for (const v of voterList) {
        const vc = cl(v.id);
        if (vc) vc.act('voteElection', { candidateId: cand.id });
      }
      await sleep(600);
      check('избран новый царь', master.state.players.filter((p) => p.role === 'tsar').length === 1);
      check('выборы закрыты', !master.state.election || master.state.election.status !== 'voting');
    }

    console.log('\n[13] Мастер: ручное управление');
    master.mact('addMoney', { playerId: otherPeasantId, delta: 777 });
    await sleep(200);
    check('мастер выдал деньги', master.state.players.find((p) => p.id === otherPeasantId).money >= 777);
    master.mact('addPlots', { playerId: otherPeasantId, count: 3 });
    await sleep(200);
    check('мастер выдал участки', master.state.players.find((p) => p.id === otherPeasantId).plots.length >= 3);
    master.mact('forceTransfer', { fromId: otherPeasantId, toId: peasantId, money: 100, ignoreChecks: true });
    await sleep(250);
    check('принудительная передача денег', master.state.players.find((p) => p.id === peasantId).money >= 100);
    master.mact('rawPatch', { patch: { treasury: 4242 } });
    await sleep(200);
    check('JSON-патч применён', master.state.treasury === 4242);
    master.mact('renamePlayer', { playerId: otherPeasantId, name: 'Переименован' });
    await sleep(200);
    check('переименование', master.state.players.find((p) => p.id === otherPeasantId).name === 'Переименован');
    master.mact('kickPlayer', { playerId: otherPeasantId });
    await sleep(250);
    check('игрок удалён', !master.state.players.find((p) => p.id === otherPeasantId));

    console.log('\n[14] Завершение и итоги');
    master.mact('finishGame');
    await sleep(300);
    check('фаза finished', master.state.phase === 'finished');
    check('итоги посчитаны и отсортированы', master.state.results && master.state.results.rows.length > 0);
    check(
      'итоги считаются только по личным монетам, по убыванию',
      master.state.results.rows.every((r, i, a) => i === 0 || a[i - 1].money >= r.money) &&
        master.state.results.rows.every((r) => r.wealth === undefined),
    );

    console.log('\n[15] Автосохранение и восстановление');
    master.mact('setTreasury', { value: 999 });
    await sleep(2000);
    server.kill('SIGKILL');
    await sleep(600);
    const server2 = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), MASTER_PIN: PIN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer();
    await sleep(400);
    const m2 = new Client('master2');
    await m2.connect();
    m2.send({ type: 'auth_master', pin: PIN });
    await sleep(400);
    check('сессия восстановлена после перезапуска', m2.state && m2.state.players.length > 0, `игроков ${m2.state ? m2.state.players.length : 0}`);
    check('казна сохранилась', m2.state && m2.state.treasury === 999, `${m2.state && m2.state.treasury}`);
    server2.kill('SIGKILL');

    console.log(`\n${'='.repeat(50)}`);
    console.log(failures === 0 ? '✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `❌ ПРОВАЛЕНО ПРОВЕРОК: ${failures}`);
    console.log('='.repeat(50));
    if (serverLog.match(/Error|error:/)) {
      console.log('\nЛог сервера содержит ошибки:\n' + serverLog.slice(0, 4000));
    }
  } catch (e) {
    console.error('\nИСКЛЮЧЕНИЕ В ТЕСТЕ:', e);
    console.error('\nЛог сервера:\n', serverLog.slice(0, 4000));
    failures++;
  } finally {
    try {
      server.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
    const fs2 = require('fs');
    const save2 = path.join(__dirname, '..', 'data', 'save.json');
    if (fs2.existsSync(save2)) fs2.unlinkSync(save2);
    if (fs2.existsSync(save2 + '.smokebak')) fs2.renameSync(save2 + '.smokebak', save2);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main();
