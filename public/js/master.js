import * as C from './common.js';

const root = document.getElementById('root');
const PIN_KEY = 'gos_master_pin';

const ui = {
  tab: 'join',
  auth: 'connecting', // connecting | pin | ready
  selPlayer: null,
  info: null,
  pinError: '',
  logFilter: '',
};

let S = null;
let net = null;
let clock = { remainingMs: 0, at: Date.now(), paused: false, time: null };

function mact(action, data = {}) {
  net.send({ type: 'master_action', action, data });
}

/* --------------------------------------------------------------- сеть */

net = C.connect({
  onOpen() {
    const pin = localStorage.getItem(PIN_KEY);
    if (pin) net.send({ type: 'auth_master', pin });
    else {
      ui.auth = 'pin';
      render();
    }
  },
  onMessage(msg) {
    switch (msg.type) {
      case 'hello':
        if (!localStorage.getItem(PIN_KEY)) {
          ui.auth = 'pin';
          render();
        }
        break;
      case 'master_auth_failed':
        localStorage.removeItem(PIN_KEY);
        ui.auth = 'pin';
        ui.pinError = 'Неверный PIN. Он показан в окне консоли сервера.';
        render();
        break;
      case 'master_welcome':
        ui.auth = 'ready';
        localStorage.setItem(PIN_KEY, msg.pin);
        loadInfo();
        break;
      case 'master_state':
        S = msg;
        ui.auth = 'ready';
        if (msg.time) clock = { remainingMs: msg.time.remainingMs, at: Date.now(), paused: msg.time.paused, time: msg.time };
        render();
        break;
      case 'time':
        clock = { remainingMs: msg.time.remainingMs, at: Date.now(), paused: msg.time.paused, time: msg.time };
        if (S) S.time = msg.time;
        paintClock();
        break;
      case 'toast':
        C.toast(msg.message, msg.kind);
        break;
      case 'error':
        C.toast(msg.error, 'error');
        break;
      default:
        break;
    }
  },
});

let infoTries = 0;
async function loadInfo() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    ui.info = await r.json();
    infoTries = 0;
    render();
  } catch (e) {
    if (infoTries++ < 5) setTimeout(loadInfo, 800);
  }
}

function remainingNow() {
  if (!clock.time) return 0;
  return clock.paused ? clock.remainingMs : Math.max(0, clock.remainingMs - (Date.now() - clock.at));
}

function paintClock() {
  const el = document.getElementById('clockVal');
  if (!el || !clock.time) return;
  el.textContent = clock.paused ? '⏸' : C.fmtClock(remainingNow());
  const sub = document.getElementById('clockSub');
  if (sub) sub.textContent = `${C.SEASON_ICONS[clock.time.season]} ${clock.time.seasonLabel} · год ${clock.time.year}/${clock.time.totalYears}`;
  const el2 = document.getElementById('clockVal2');
  if (el2) el2.textContent = C.fmtClock(remainingNow());
}
setInterval(paintClock, 300);

/* -------------------------------------------------------------- helpers */

function P(id) {
  return S ? S.players.find((p) => p.id === id) : null;
}
function nameOf(id) {
  if (id === 'TREASURY') return 'Казна';
  if (id === 'MARKET') return 'Рынок';
  if (id === 'STATE') return 'Гос. фонд';
  const p = P(id);
  return p ? p.name : '—';
}
function playerOptions(selected, { includeEmpty = false, emptyLabel = '— выберите —', filter = null } = {}) {
  const list = S.players.filter((p) => (filter ? filter(p) : true));
  return (
    (includeEmpty ? `<option value="">${emptyLabel}</option>` : '') +
    list
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${C.esc(p.name)}${p.role ? ` — ${C.ROLE_LABELS[p.role]}` : ''}</option>`,
      )
      .join('')
  );
}

/* -------------------------------------------------------------- рендер */

const MTABS = [
  { id: 'join', label: '📶 Подключение' },
  { id: 'lobby', label: '👥 Игроки и старт' },
  { id: 'time', label: '⏱️ Время' },
  { id: 'econ', label: '⚖️ Параметры' },
  { id: 'edit', label: '🛠️ Ручное управление' },
  { id: 'politics', label: '📜 Политика' },
  { id: 'log', label: '📖 Журнал' },
];

function render() {
  if (ui.auth === 'pin') return renderPin();
  if (!S) return C.renderInto(root, `<div class="section center" style="padding-top:80px"><h1>🎲 Панель мастера</h1><p class="muted">Подключение…</p></div>`);

  const inner = {
    join: tabJoin,
    lobby: tabLobby,
    time: tabTime,
    econ: tabEcon,
    edit: tabEdit,
    politics: tabPolitics,
    log: tabLog,
  }[ui.tab]();

  C.renderInto(
    root,
    `<div class="app">
      <div class="topbar">
        <div class="grow">
          <div class="brand">Государство · мастер</div>
          <div class="who">
            ${
              { lobby: '🕓 Лобби', running: '▶️ Игра идёт', finished: '🏁 Завершена' }[S.phase] || S.phase
            } · игроков: ${S.players.length} · онлайн: ${S.players.filter((p) => p.connected).length}
          </div>
        </div>
        <div class="row nowrap">
          ${
            S.phase === 'running'
              ? `<button class="sm ${S.time.paused ? 'good' : 'ghost'}" data-act="${S.time.paused ? 'resume' : 'pause'}">${S.time.paused ? '▶ Продолжить' : '⏸ Пауза'}</button>
                 <button class="sm ghost" data-act="nextSeason">⏭ Сезон</button>`
              : ''
          }
        </div>
        <div class="clock"><div class="big" id="clockVal">—</div><div class="sub" id="clockSub"></div></div>
      </div>
      <div class="mtabs">${MTABS.map((t) => `<button class="${ui.tab === t.id ? 'on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}</div>
      <div class="section">${inner}</div>
    </div>`,
  );
  paintClock();
  root.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      ui.tab = b.dataset.tab;
      if (ui.tab === 'join' && !ui.info) loadInfo();
      render();
    };
  });
  root.querySelectorAll('[data-act]').forEach((el) => {
    if (el.tagName === 'SELECT') el.onchange = () => handleAct(el.dataset);
    else el.onclick = () => handleAct(el.dataset);
  });
}

function renderPin() {
  C.renderInto(
    root,
    `<div class="overlay"><div class="box card">
      <h2>🎲 Панель мастера</h2>
      <p class="small muted">Введите PIN, который показан в окне сервера (чёрное окно консоли).</p>
      <div class="field"><input id="pin" inputmode="numeric" maxlength="8" placeholder="PIN" autocomplete="off"></div>
      ${ui.pinError ? `<p class="small" style="color:var(--red)">${C.esc(ui.pinError)}</p>` : ''}
      <button class="wide" id="pinBtn">Войти</button>
    </div></div>`,
  );
  const go = () => {
    const pin = document.getElementById('pin').value.trim();
    if (!pin) return;
    localStorage.setItem(PIN_KEY, pin);
    net.send({ type: 'auth_master', pin });
  };
  document.getElementById('pinBtn').onclick = go;
  const inp = document.getElementById('pin');
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
  inp.focus();
}

/* ------------------------------------------------------- вкладка: сеть */

function tabJoin() {
  const info = ui.info;
  const primary = ui.primaryUrl || (info && info.primary);
  return `<div class="grid" style="grid-template-columns:minmax(300px,380px) 1fr;align-items:start">
    <div class="card center">
      <h3>QR для игроков</h3>
      ${
        primary
          ? `<div class="qr-box"><img src="/api/qr?url=${encodeURIComponent(primary)}" alt="QR"></div>
             <div class="urlline mt">${C.esc(primary)}</div>`
          : '<p class="muted small">Загрузка…</p>'
      }
      <p class="tiny muted mt mb0">Игроки сканируют камерой телефона и открывают ссылку в браузере.</p>
      <button class="ghost sm mt" data-act="reloadInfo">Обновить адреса</button>
    </div>

    <div>
      <div class="card">
        <div class="card-title"><h3>Как подключить игроков (без интернета)</h3></div>
        <ol class="small" style="padding-left:20px;margin:0">
          <li><b>Раздайте Wi-Fi с ноутбука</b>: Windows → Параметры → Сеть и Интернет → <b>Мобильный хот-спот</b> → включить. Игроки подключаются к этой сети с телефонов. Интернет не нужен — работает только локальная сеть.<br>
            <span class="muted">Альтернатива: включите точку доступа на любом телефоне и подключите к ней ноутбук и всех игроков.</span></li>
          <li><b>Разрешите подключения в брандмауэре</b>: при первом запуске Windows спросит — нажмите «Разрешить доступ» для частных сетей. Если окна не было, запустите файл <code>allow-firewall.bat</code> от имени администратора.</li>
          <li><b>Покажите QR</b> с этого экрана. Игроки сканируют, вводят имя — и они в комнате.</li>
          <li>Если QR не открывается — попросите вручную набрать адрес из рамки выше.</li>
        </ol>
      </div>
      <div class="card">
        <div class="card-title"><h3>Все сетевые адреса этого ноутбука</h3></div>
        ${
          info && info.urls && info.urls.length
            ? `<div class="list">${info.urls
                .map(
                  (u) => `<div class="item ${primary === u.url ? 'hl' : u.virtual ? 'dim' : ''}">
                    <div class="spread"><span class="mono">${C.esc(u.url)}</span>
                    <span class="tiny muted">${C.esc(u.name)}${u.virtual ? ' · виртуальный адаптер' : ''}</span></div>
                    <button class="sm ${primary === u.url ? '' : 'ghost'} mt" data-act="setPrimary" data-url="${C.esc(u.url)}">
                      ${primary === u.url ? 'показан в QR' : 'показать этот QR'}</button></div>`,
                )
                .join('')}</div>
               <p class="tiny muted mt mb0">Основной адрес выбран автоматически (Wi-Fi / хот-спот). Адреса виртуальных адаптеров (VirtualBox, VPN и т.п.) помечены — с телефонов они недоступны. Если игроки не подключаются — попробуйте другой адрес.</p>`
            : '<p class="small muted mb0">Адреса не найдены. Подключитесь к Wi-Fi или включите хот-спот.</p>'
        }
      </div>
      <div class="card">
        <div class="card-title"><h3>Сохранение сессии</h3></div>
        <p class="small muted">Игра автоматически сохраняется в папку <code>data</code>. Если сервер перезапустить — сессия и все игроки восстановятся (телефоны переподключатся сами).</p>
        <div class="row">
          <button class="ghost sm" data-act="backup">Сделать бэкап</button>
          <a class="btn sm ghost" href="/api/export" target="_blank" style="text-decoration:none;display:inline-flex;align-items:center">Скачать состояние (JSON)</a>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------ вкладка: лобби */

function tabLobby() {
  const sug = S.roleSuggestion || {};
  const total = S.players.length;
  const sum = C.ROLES.reduce((s, r) => s + (sug[r] || 0), 0);
  return `<div class="grid" style="grid-template-columns:1fr minmax(300px,380px);align-items:start">
    <div class="card">
      <div class="card-title"><h3>Игроки в комнате (${total})</h3>
        <span class="tiny muted">роль можно изменить в любой момент</span></div>
      <div class="scroll-x"><table>
        <tr><th></th><th>Имя</th><th>Роль</th><th>Феодал</th><th>💰</th><th>Участки</th><th>Действия</th></tr>
        ${S.players
          .map(
            (p) => `<tr>
              <td>${p.connected ? '🟢' : '⚪'}</td>
              <td class="tbl-input"><input id="nm_${p.id}" value="${C.esc(p.name)}" style="min-width:120px"></td>
              <td class="tbl-input"><select id="rl_${p.id}" style="min-width:120px">
                <option value="">без роли</option>
                ${C.ROLES.map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${C.ROLE_LABELS[r]}</option>`).join('')}
              </select></td>
              <td class="tbl-input">${
                p.role === 'peasant'
                  ? `<select id="ld_${p.id}" style="min-width:110px"><option value="">вольный</option>
                      ${S.players
                        .filter((f) => f.role === 'feudal')
                        .map((f) => `<option value="${f.id}" ${p.lordId === f.id ? 'selected' : ''}>${C.esc(f.name)}</option>`)
                        .join('')}</select>`
                  : '<span class="tiny muted">—</span>'
              }</td>
              <td class="mono">${p.money}</td>
              <td class="mono">${p.plots.length}</td>
              <td><div class="row nowrap">
                <button class="sm ghost" data-act="savePlayerRow" data-id="${p.id}">💾</button>
                <button class="sm ghost" data-act="selectPlayer" data-id="${p.id}">🛠️</button>
                <button class="sm danger" data-act="kick" data-id="${p.id}">✖</button>
              </div></td>
            </tr>`,
          )
          .join('')}
      </table></div>
      ${total ? '' : '<p class="small muted mt mb0">Пока никто не подключился. Покажите QR из вкладки «Подключение».</p>'}
    </div>

    <div>
      <div class="card">
        <div class="card-title"><h3>Запуск игры</h3></div>
        <p class="small muted">Автораскладка на ${total} игроков (1 царь; 4 крестьянина на феодала; бояр вдвое меньше феодалов; 1 купец на 8 игроков). Числа можно поправить — сумма должна быть ${total}.</p>
        <div class="grid g2">
          ${C.ROLES.map(
            (r) => `<div><label>${C.ROLE_ICONS[r]} ${C.ROLE_LABELS[r]}</label>
              <input type="number" min="0" id="cnt_${r}" value="${sug[r] || 0}"></div>`,
          ).join('')}
        </div>
        <p class="tiny ${sum === total ? 'muted' : ''}" style="${sum === total ? '' : 'color:var(--red)'}">Сумма автораскладки: ${sum} из ${total}</p>
        ${
          S.phase === 'lobby'
            ? `<button class="wide good" data-act="startGame">▶ Начать игру (раздать роли и наборы)</button>
               <button class="wide ghost mt" data-act="startGameKeepRoles">▶ Начать с текущими ролями</button>`
            : `<button class="wide ghost" data-act="reassignRoles">🎲 Перераздать роли (без стартовых наборов)</button>
               <button class="wide ghost mt" data-act="reassignRolesFull">🎲 Перераздать роли + выдать стартовые наборы</button>`
        }
        <hr>
        <button class="wide ghost" data-act="backToLobby">↩ Вернуть в лобби (сохранить игроков)</button>
        <button class="wide danger mt" data-act="resetAll">💥 Полный сброс сессии</button>
      </div>

      <div class="card">
        <div class="card-title"><h3>Стартовые наборы</h3></div>
        <div class="grid g2">
          ${[
            ['startPeasantPlots', 'Участков крестьянину'],
            ['startPeasantCropEach', 'Культур каждого вида'],
            ['startPeasantMoney', 'Монет крестьянину'],
            ['startMerchantMoney', 'Монет купцу'],
            ['startTsarMoney', 'Монет царю'],
            ['startTreasury', 'Стартовая казна'],
            ['tsarPlotsPerPeasant', 'Участков царю на 1 крестьянина'],
            ['startFeudalMoney', 'Монет феодалу'],
            ['startBoyarMoney', 'Монет боярину'],
          ]
            .map(
              ([k, label]) => `<div><label>${label}</label>
                <input type="number" id="cfg_${k}" value="${S.config[k]}"></div>`,
            )
            .join('')}
        </div>
        <button class="wide mt" data-act="saveStartCfg">Сохранить</button>
        <p class="tiny muted mt mb0">Применяется при следующей раздаче стартовых наборов.</p>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------- вкладка: время */

function tabTime() {
  const t = S.time;
  return `<div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
    <div class="card">
      <div class="card-title"><h3>Текущее время</h3>
        <span class="badge ${t.paused ? 'red' : 'green'}">${t.paused ? 'пауза' : 'идёт'}</span></div>
      <div class="grid g3">
        <div class="stat"><div class="v">${t.year}</div><div class="k">год из ${t.totalYears}</div></div>
        <div class="stat"><div class="v">${C.SEASON_ICONS[t.season]}</div><div class="k">${t.seasonLabel}</div></div>
        <div class="stat"><div class="v" id="clockVal2">${C.fmtClock(t.remainingMs)}</div><div class="k">до смены</div></div>
      </div>
      <div class="row mt">
        ${
          S.phase === 'running'
            ? `<button class="${t.paused ? 'good' : 'ghost'}" data-act="${t.paused ? 'resume' : 'pause'}">${t.paused ? '▶ Продолжить' : '⏸ Пауза'}</button>
               <button class="ghost" data-act="nextSeason">⏭ Следующий сезон</button>`
            : '<span class="small muted">Игра не идёт — запустите её во вкладке «Игроки и старт».</span>'
        }
      </div>
      <hr>
      <div class="grid g3">
        <div><label>Год</label><input type="number" min="1" id="setYear" value="${t.year}"></div>
        <div><label>Сезон</label><select id="setSeason">
          ${['spring', 'summer', 'autumn', 'winter']
            .map((s, i) => `<option value="${i}" ${t.seasonIndex === i ? 'selected' : ''}>${C.SEASON_LABELS[s]}</option>`)
            .join('')}
        </select></div>
        <div><label>&nbsp;</label><button class="wide ghost" data-act="setTime">Перевести время</button></div>
      </div>
      <div class="grid g3 mt">
        <div><label>Длительность сезона, сек</label><input type="number" min="5" id="cfg_seasonDurationSec" value="${S.config.seasonDurationSec}"></div>
        <div><label>Всего лет</label><input type="number" min="1" id="cfg_totalYears" value="${S.config.totalYears}"></div>
        <div><label>&nbsp;</label><button class="wide ghost" data-act="saveTimeCfg">Сохранить</button></div>
      </div>
      <div class="row mt">
        <input type="number" min="0" id="remainSec" placeholder="осталось секунд в сезоне" class="grow">
        <button class="sm ghost" data-act="setRemaining">Задать остаток</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><h3>Игровые события вручную</h3></div>
      <div class="grid g2">
        <button class="ghost" data-act="runHarvest">🌾 Собрать урожай сейчас</button>
        <button class="ghost" data-act="resetQuotas">🏪 Сбросить квоты Рынка</button>
        <button class="ghost" data-act="resetTaxes">🧾 Сбросить лимиты налогов</button>
        <button class="ghost" data-act="recomputeResults">📊 Пересчитать итоги</button>
        <button class="danger" data-act="finishGame">🏁 Завершить игру</button>
      </div>
      <hr>
      <div class="card-title"><h3>Правила сезонов</h3></div>
      <table>
        <tr><td>🌱 Весна</td><td class="small">посадка культур (1 на участок)</td></tr>
        <tr><td>☀️ Лето</td><td class="small">сделки и политика</td></tr>
        <tr><td>🍂 Осень</td><td class="small">авто-урожай (1 → ${S.config.harvestYield}), сбор налогов</td></tr>
        <tr><td>❄️ Зима</td><td class="small">море открыто (переправа купцов), Рынок закрыт для продажи системе</td></tr>
      </table>
      <hr>
      <div class="grid g2">
        <label class="check"><input type="checkbox" id="cfg_plantOnlyInSpring" ${S.config.plantOnlyInSpring ? 'checked' : ''}> Сажать только Весной</label>
        <label class="check"><input type="checkbox" id="cfg_marketClosedInWinter" ${S.config.marketClosedInWinter ? 'checked' : ''}> Зимой Рынок закрыт</label>
        <label class="check"><input type="checkbox" id="cfg_travelOnlyInWinter" ${S.config.travelOnlyInWinter ? 'checked' : ''}> Переправа только Зимой</label>
        <label class="check"><input type="checkbox" id="cfg_taxOncePerSeason" ${S.config.taxOncePerSeason ? 'checked' : ''}> Налог не чаще раза в сезон</label>
      </div>
      <button class="wide ghost mt" data-act="saveSeasonFlags">Сохранить переключатели</button>
    </div>
  </div>`;
}

/* --------------------------------------------------- вкладка: параметры */

function tabEcon() {
  return `<div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
    <div class="card">
      <div class="card-title"><h3>🏪 Рынок: курсы и квоты</h3></div>
      <table>
        <tr><th>Культура</th><th>Курс</th><th>Квота/сезон</th><th>Продано</th></tr>
        ${C.CROPS.map(
          (c) => `<tr>
            <td>${C.CROP_ICONS[c]} ${C.CROP_LABELS[c]}</td>
            <td class="tbl-input"><input type="number" min="0" id="rate_${c}" value="${S.config.marketRates[c]}" style="width:90px"></td>
            <td class="tbl-input"><input type="number" min="0" id="quota_${c}" value="${S.config.marketQuotas[c]}" style="width:90px"></td>
            <td class="mono">${S.market.quotaUsed[c] || 0}</td>
          </tr>`,
        ).join('')}
      </table>
      <div class="row mt">
        <button data-act="saveMarket">Сохранить курсы и квоты</button>
        <button class="ghost" data-act="resetQuotas">Сбросить «продано»</button>
      </div>
      <p class="tiny muted mt mb0">Квоты обнуляются автоматически каждый сезон. Деньги в игре появляются только через продажу купцами на Рынке.</p>
    </div>

    <div class="card">
      <div class="card-title"><h3>⚖️ Экономические параметры</h3></div>
      <div class="grid g2">
        ${[
          ['boatPrice', 'Цена лодки'],
          ['ransomPrice', 'Цена выкупа крестьянина'],
          ['harvestYield', 'Урожайность (1 → N)'],
          ['feudalTaxCropsPerYear', 'Налог феодала: культур/год'],
          ['feudalTaxMoneyPerYear', 'Налог феодала: монет/год'],
          ['tsarTaxCropsPerYear', 'Налог царя: культур/год'],
          ['tsarTaxMoneyPerYear', 'Налог царя: монет/год'],
          ['freeTaxCropsPerYear', 'Налог вольных: культур/год'],
          ['freeTaxMoneyPerYear', 'Налог вольных: монет/год'],
          ['overthrowProtectionYears', 'Защита бояр после свержения, лет'],
        ]
          .map(([k, label]) => `<div><label>${label}</label><input type="number" min="0" id="cfg_${k}" value="${S.config[k]}"></div>`)
          .join('')}
      </div>
      <label class="check mt"><input type="checkbox" id="cfg_freePeasantTaxEnabled" ${S.config.freePeasantTaxEnabled ? 'checked' : ''}> Введён налог для вольных крестьян (собирают бояре в казну)</label>
      <label class="check"><input type="checkbox" id="cfg_allowMerchantDowngrade" ${S.config.allowMerchantDowngrade ? 'checked' : ''}> Разрешить купцу менять роль (отладка)</label>
      <button class="wide mt" data-act="saveEconCfg">Сохранить параметры</button>
    </div>

    <div class="card">
      <div class="card-title"><h3>🏛️ Казна государства</h3></div>
      <div class="row">
        <div class="grow"><label>Монет в казне</label><input type="number" min="0" id="treasuryVal" value="${S.treasury}"></div>
        <div><label>&nbsp;</label><button class="ghost" data-act="setTreasury">Задать</button></div>
      </div>
      <div class="row mt">
        <input type="number" id="treasuryDelta" placeholder="±монет" class="grow">
        <button class="sm ghost" data-act="addTreasury">Изменить</button>
      </div>
      <hr>
      <label>Культуры в казне</label>
      ${C.cropInputs('scrop', S.stateCrops)}
      <button class="wide ghost mt" data-act="saveStateCrops">Сохранить культуры казны</button>
      <p class="tiny muted mt mb0">Участков без владельца в гос. фонде: <b>${S.stateFund.length}</b>. Перемещать участки — во вкладке «Ручное управление».</p>
    </div>

    <div class="card">
      <div class="card-title"><h3>📊 Подсчёт итогов</h3></div>
      <div class="grid g2">
        <div><label>Стоимость участка</label><input type="number" min="0" id="sc_plotValue" value="${S.config.scoring.plotValue}"></div>
        <div><label>Стоимость лодки</label><input type="number" min="0" id="sc_boatValue" value="${S.config.scoring.boatValue}"></div>
        <div><label>Стоимость культуры (если не по курсу)</label><input type="number" min="0" id="sc_cropValue" value="${S.config.scoring.cropValue}"></div>
      </div>
      <label class="check mt"><input type="checkbox" id="sc_fromMarket" ${S.config.scoring.cropValueFromMarket ? 'checked' : ''}> Считать культуры по текущему курсу Рынка</label>
      <button class="wide ghost mt" data-act="saveScoring">Сохранить</button>
      ${
        S.results
          ? `<hr><div class="scroll-x"><table><tr><th>#</th><th>Игрок</th><th>Роль</th><th>Богатство</th></tr>
              ${S.results.rows
                .map((r, i) => `<tr><td>${i + 1}</td><td>${C.esc(r.name)}</td><td class="tiny">${C.ROLE_LABELS[r.role] || '—'}</td><td class="mono"><b>${r.wealth}</b></td></tr>`)
                .join('')}</table></div>`
          : ''
      }
    </div>
  </div>`;
}

/* -------------------------------------------- вкладка: ручное управление */

function tabEdit() {
  const sel = ui.selPlayer ? P(ui.selPlayer) : null;
  return `<div class="grid" style="grid-template-columns:minmax(260px,320px) 1fr;align-items:start">
    <div class="card">
      <div class="card-title"><h3>Выберите игрока</h3></div>
      <div class="list">${S.players
        .map(
          (p) => `<div class="item ${ui.selPlayer === p.id ? 'hl' : ''}" style="cursor:pointer" data-act="selectPlayer" data-id="${p.id}">
            <div class="spread"><span>${p.connected ? '🟢' : '⚪'} <b>${C.esc(p.name)}</b></span>${C.roleBadge(p.role)}</div>
            <div class="tiny muted">💰 ${p.money} · 🟩 ${p.plots.length} · ${C.cropsText(p.crops)} ${p.hasBoat ? '· 🛶' : ''}${p.onMarket ? ' · Рынок' : ''}</div>
          </div>`,
        )
        .join('')}</div>
      ${S.stateFund.length ? `<p class="tiny muted mt mb0">Гос. фонд без владельца: ${S.stateFund.length} участков</p>` : ''}
    </div>

    <div>
      ${sel ? playerEditor(sel) : '<div class="card"><p class="small muted mb0">Выберите игрока слева, чтобы менять его параметры.</p></div>'}

      <div class="card">
        <div class="card-title"><h3>↔️ Принудительная передача между игроками</h3></div>
        <div class="grid g2">
          <div><label>От кого</label><select id="ftFrom">${playerOptions(sel ? sel.id : null, { includeEmpty: true })}</select></div>
          <div><label>Кому</label><select id="ftTo">${playerOptions(null, { includeEmpty: true })}</select></div>
        </div>
        <div class="grid g2 mt">
          <div><label>💰 Монеты</label><input type="number" min="0" id="ftMoney" placeholder="0"></div>
          <div><label>🟩 Участков</label><input type="number" min="0" id="ftPlots" placeholder="0"></div>
        </div>
        ${C.cropInputs('ftc')}
        <label class="check mt"><input type="checkbox" id="ftIgnore" checked> Игнорировать проверки (дописать недостающее)</label>
        <button class="wide" data-act="forceTransfer">Передать</button>
      </div>

      <div class="card">
        <div class="card-title"><h3>🟩 Перемещение участков</h3></div>
        <div class="grid g4">
          <div><label>От</label><select id="mpFrom"><option value="STATE">Гос. фонд (${S.stateFund.length})</option>${playerOptions(null)}</select></div>
          <div><label>Кому</label><select id="mpTo"><option value="STATE">Гос. фонд</option>${playerOptions(null)}</select></div>
          <div><label>Сколько</label><input type="number" min="1" id="mpCount" value="1"></div>
          <div><label>&nbsp;</label><button class="wide ghost" data-act="movePlots">Переместить</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><h3>💬 Сообщения игрокам</h3></div>
        <div class="field"><label>Объявление всем (попадёт в ленту и уведомления)</label>
          <div class="row nowrap"><input class="grow" id="annText" placeholder="Текст объявления"><button data-act="announce">Отправить</button></div></div>
        <div class="field mb0"><label>Личное сообщение</label>
          <div class="row nowrap">
            <select id="notifyWho" style="max-width:200px">${playerOptions(sel ? sel.id : null, { includeEmpty: true })}</select>
            <input class="grow" id="notifyText" placeholder="Текст">
            <button class="ghost" data-act="notifyPlayer">Отправить</button>
          </div></div>
      </div>

      <details>
        <summary>⚠️ Ручное изменение состояния (JSON-патч)</summary>
        <p class="tiny muted">Глубокое слияние в состояние игры. Пример: <code>{"treasury": 500}</code> или <code>{"config":{"boatPrice":10}}</code>. Используйте, если нужного контрола нет в интерфейсе.</p>
        <textarea id="rawPatch" placeholder='{"treasury": 500}'></textarea>
        <button class="danger mt" data-act="rawPatch">Применить патч</button>
      </details>
    </div>
  </div>`;
}

function playerEditor(p) {
  const wards = S.players.filter((x) => x.role === 'peasant' && x.lordId === p.id);
  return `<div class="card">
      <div class="card-title">
        <h3>🛠️ ${C.esc(p.name)} ${C.roleBadge(p.role)}</h3>
        <span class="tiny muted">богатство ${p.wealth} · ${p.connected ? 'онлайн' : 'офлайн'}${p.unread ? ` · ${p.unread} непрочит.` : ''}</span>
      </div>

      <div class="grid g2">
        <div><label>Имя</label><div class="row nowrap"><input class="grow" id="ed_name" value="${C.esc(p.name)}"><button class="sm ghost" data-act="rename" data-id="${p.id}">OK</button></div></div>
        <div><label>Роль</label><div class="row nowrap">
          <select class="grow" id="ed_role">${C.ROLES.map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${C.ROLE_LABELS[r]}</option>`).join('')}</select>
          <button class="sm ghost" data-act="setRole" data-id="${p.id}">OK</button></div>
          <label class="check tiny mt"><input type="checkbox" id="ed_giveSet"> выдать стандартный набор крестьянина</label>
        </div>
      </div>

      ${
        p.role === 'peasant'
          ? `<div class="row mt"><div class="grow"><label>Феодал</label>
              <select id="ed_lord"><option value="">вольный</option>
              ${S.players.filter((f) => f.role === 'feudal').map((f) => `<option value="${f.id}" ${p.lordId === f.id ? 'selected' : ''}>${C.esc(f.name)}</option>`).join('')}
              </select></div><div><label>&nbsp;</label><button class="ghost" data-act="setLord" data-id="${p.id}">Назначить</button></div></div>`
          : p.role === 'feudal'
            ? `<p class="small muted mt">Крестьян в подчинении: <b>${wards.length}</b>${wards.length ? ` (${wards.map((w) => C.esc(w.name)).join(', ')})` : ''}</p>`
            : ''
      }

      <hr>
      <div class="grid g2">
        <div>
          <label>💰 Деньги (сейчас ${p.money})</label>
          <div class="row nowrap">
            <input class="grow" type="number" min="0" id="ed_money" value="${p.money}">
            <button class="sm ghost" data-act="setMoney" data-id="${p.id}">=</button>
          </div>
          <div class="row nowrap mt">
            <input class="grow" type="number" id="ed_moneyDelta" placeholder="±">
            <button class="sm ghost" data-act="addMoney" data-id="${p.id}">±</button>
          </div>
        </div>
        <div>
          <label>🟩 Участки (сейчас ${p.plots.length})</label>
          <div class="row nowrap">
            <input class="grow" type="number" min="1" id="ed_plotCount" value="1">
            <button class="sm ghost" data-act="addPlots" data-id="${p.id}">+</button>
            <button class="sm danger" data-act="removePlots" data-id="${p.id}">−</button>
          </div>
          <button class="sm ghost mt wide" data-act="giveStandardSet" data-id="${p.id}">Выдать стандартный набор крестьянина</button>
        </div>
      </div>

      <div class="mt"><label>🌾 Культуры (текущие значения — задать; поле ± ниже)</label>
        ${C.cropInputs('ed_set', p.crops)}
        <div class="row mt"><button class="sm ghost" data-act="setCrops" data-id="${p.id}">Задать культуры</button></div>
        <label class="mt">Изменить на ±</label>
        ${C.cropInputs('ed_add')}
        <div class="row mt"><button class="sm ghost" data-act="addCrops" data-id="${p.id}">Применить ±</button></div>
      </div>

      <hr>
      <div class="grid g2">
        <div>
          <label>Флаги</label>
          <label class="check"><input type="checkbox" id="ed_hasBoat" ${p.hasBoat ? 'checked' : ''}> 🛶 есть лодка</label>
          <label class="check"><input type="checkbox" id="ed_onMarket" ${p.onMarket ? 'checked' : ''}> на Рынке</label>
          <label class="check"><input type="checkbox" id="ed_locked" ${p.locked ? 'checked' : ''}> запретить менять имя</label>
        </div>
        <div>
          <label>Санкции</label>
          <label class="check"><input type="checkbox" id="ed_noBoat" ${p.sanctions.noBoat ? 'checked' : ''}> запрет покупки лодки</label>
          <label class="check"><input type="checkbox" id="ed_noTrade" ${p.sanctions.noTrade ? 'checked' : ''}> запрет обмена</label>
          <label class="check"><input type="checkbox" id="ed_noFarm" ${p.sanctions.noFarm ? 'checked' : ''}> запрет возделывания</label>
        </div>
      </div>
      <button class="wide ghost mt" data-act="saveFlags" data-id="${p.id}">Сохранить флаги и санкции</button>

      <hr>
      <div class="grid g3">
        <div><label>Налог: собрано культур (год ${S.time.year})</label><input type="number" min="0" id="ed_taxCrops" value="${p.tax.cropsPaid}"></div>
        <div><label>Налог: собрано монет</label><input type="number" min="0" id="ed_taxMoney" value="${p.tax.moneyPaid}"></div>
        <div><label>&nbsp;</label><button class="wide ghost" data-act="setTax" data-id="${p.id}">Сохранить + разрешить сбор в сезоне</button></div>
      </div>
      ${
        p.plots.length
          ? `<hr><label>Участки: что посажено</label>
            <div class="grid gauto" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">
            ${p.plots
              .map(
                (l) => `<div class="tbl-input"><label>${l.id}</label>
                  <select id="pl_${l.id}" data-act="setPlanted" data-id="${l.id}">
                    <option value="" ${!l.planted ? 'selected' : ''}>— пусто —</option>
                    ${C.CROPS.map((c) => `<option value="${c}" ${l.planted === c ? 'selected' : ''}>${C.CROP_LABELS[c]}</option>`).join('')}
                  </select></div>`,
              )
              .join('')}</div>`
          : ''
      }

      <hr>
      <details>
        <summary>Выполнить действие от имени игрока (отладка ролевых механик)</summary>
        <p class="tiny muted">Например: <code>plant</code> с данными <code>{"crop":"carrot","count":1}</code>, <code>sellToMarket</code>, <code>ransom</code>, <code>setMarketPresence</code>.</p>
        <div class="row nowrap"><input class="grow" id="aap_type" placeholder="имя действия"><input class="grow" id="aap_data" placeholder='{"crop":"carrot"}'>
          <button class="ghost" data-act="actAsPlayer" data-id="${p.id}">Выполнить</button></div>
      </details>
    </div>`;
}

/* ---------------------------------------------------- вкладка: политика */

function tabPolitics() {
  const el = S.election;
  const ov = S.overthrow;
  return `<div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
    <div class="card">
      <div class="card-title"><h3>📜 Указы</h3></div>
      ${
        S.decrees.length
          ? `<div class="list">${S.decrees
              .map(
                (d) => `<div class="item ${d.status === 'voting' ? 'hl' : ''}">
                  <div class="spread"><b>${C.esc(d.title)}</b><span class="badge ${d.status === 'passed' ? 'green' : d.status === 'rejected' ? 'red' : ''}">${d.status}</span></div>
                  ${d.changesText ? `<div class="tiny" style="color:var(--gold2)">${C.esc(d.changesText)}</div>` : ''}
                  ${d.text ? `<div class="tiny muted">${C.esc(d.text)}</div>` : ''}
                  <div class="tiny muted mt">${d.voters.map((v) => `${C.esc(v.name)}: ${v.vote === 'for' ? '✔' : v.vote === 'against' ? '✘' : '…'}`).join(' · ') || 'бояр нет'}</div>
                  ${
                    d.status === 'voting'
                      ? `<div class="row mt">
                          <button class="sm good" data-act="decree" data-id="${d.id}" data-out="pass">Принять</button>
                          <button class="sm danger" data-act="decree" data-id="${d.id}" data-out="reject">Отклонить</button>
                          <button class="sm ghost" data-act="decree" data-id="${d.id}" data-out="cancel">Отменить</button>
                        </div>
                        ${
                          d.voters.length
                            ? `<div class="row mt">${d.voters
                                .map(
                                  (v) => `<span class="tiny">${C.esc(v.name)}:</span>
                                    <button class="sm ghost" data-act="boyarVote" data-id="${d.id}" data-b="${v.id}" data-v="for">за</button>
                                    <button class="sm ghost" data-act="boyarVote" data-id="${d.id}" data-b="${v.id}" data-v="against">против</button>`,
                                )
                                .join(' ')}</div>`
                            : ''
                        }`
                      : ''
                  }
                </div>`,
              )
              .join('')}</div>`
          : '<p class="small muted mb0">Указов нет.</p>'
      }
    </div>

    <div>
      <div class="card">
        <div class="card-title"><h3>👑 Престол</h3></div>
        <p class="small muted">Царь: <b>${C.esc((S.players.find((p) => p.role === 'tsar') || {}).name || '—')}</b></p>
        ${
          ov
            ? `<div class="item"><div class="spread"><span>Свержение: <b>${ov.status}</b></span>
                <span class="tiny muted">начал ${C.esc(ov.startedByName)}</span></div>
                <div class="tiny muted">${ov.votes.map((v) => `${C.esc(v.name)}: ${v.vote === true ? '⚔' : v.vote === false ? '✘' : '…'}`).join(' · ')}</div>
                ${ov.status === 'voting' ? `<button class="sm ghost mt" data-act="cancelOverthrow">Отменить процедуру</button>` : ''}</div>`
            : ''
        }
        <div class="row mt">
          <button class="danger" data-act="forceOverthrow">⚔️ Свергнуть царя принудительно</button>
          <button class="ghost" data-act="startElection">🗳️ Начать выборы</button>
        </div>
        ${
          el
            ? `<hr><div class="spread"><b>Выборы: ${el.status}</b><span class="tiny muted">проголосовало ${el.votedCount}/${el.voterCount}</span></div>
              <div class="list mt">${el.candidates
                .map(
                  (c) => `<div class="item"><div class="spread"><span>${C.esc(c.name)} ${C.roleBadge(c.role)}</span>
                    <span class="row nowrap"><span class="mono">${c.votes}</span>
                    ${el.status === 'voting' ? `<button class="sm ghost" data-act="finishElection" data-id="${c.id}">сделать царём</button>` : ''}</span></div></div>`,
                )
                .join('')}</div>
              ${
                el.status === 'voting'
                  ? `<div class="row mt"><button class="sm ghost" data-act="finishElection" data-id="">Завершить по голосам</button>
                     <button class="sm danger" data-act="cancelElection">Отменить выборы</button></div>`
                  : ''
              }`
            : ''
        }
      </div>

      <div class="card">
        <div class="card-title"><h3>📥 Заявки игроков (${S.requests.filter((r) => r.status === 'pending').length} активных)</h3></div>
        ${
          S.requests.length
            ? `<div class="list">${S.requests
                .slice(0, 20)
                .map(
                  (r) => `<div class="item ${r.status === 'pending' ? '' : 'dim'}">
                    <div class="spread"><span class="small">${C.esc(r.title)}</span><span class="badge ${r.status === 'pending' ? '' : 'off'}">${r.status}</span></div>
                    <div class="tiny muted">${Object.entries(r.approvals).map(([id, v]) => `${C.esc(r.approvalNames[id] || '')}: ${v}`).join(' · ')}${
                      r.needBoyar ? ` · боярин: ${r.boyarVote || '…'}` : ''
                    }${r.error ? ` · ошибка: ${C.esc(r.error)}` : ''}</div>
                    ${
                      r.status === 'pending'
                        ? `<div class="row mt">
                            <button class="sm good" data-act="request" data-id="${r.id}" data-mode="complete">Выполнить</button>
                            <button class="sm danger" data-act="request" data-id="${r.id}" data-mode="decline">Отклонить</button>
                            <button class="sm ghost" data-act="request" data-id="${r.id}" data-mode="delete">Удалить</button>
                          </div>`
                        : ''
                    }
                  </div>`,
                )
                .join('')}</div>`
            : '<p class="small muted mb0">Заявок нет.</p>'
        }
      </div>

      <div class="card">
        <div class="card-title"><h3>⚖️ Жалобы</h3></div>
        ${
          S.complaints.length
            ? `<div class="list">${S.complaints
                .map(
                  (c) => `<div class="item ${c.status === 'closed' ? 'dim' : ''}">
                    <div class="tiny muted">${C.fmtTimeOfDay(c.at)} · от ${C.esc(nameOf(c.fromId))}${c.targetId ? ` на ${C.esc(nameOf(c.targetId))}` : ''}</div>
                    ${C.esc(c.text)}</div>`,
                )
                .join('')}</div>`
            : '<p class="small muted mb0">Жалоб нет.</p>'
        }
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------ вкладка: журнал */

function tabLog() {
  const f = ui.logFilter.toLowerCase();
  const tx = S.transactions.filter(
    (t) => !f || `${t.kind} ${t.fromName} ${t.toName} ${t.note}`.toLowerCase().includes(f),
  );
  return `<div class="grid" style="grid-template-columns:1.3fr 1fr;align-items:start">
    <div class="card">
      <div class="card-title"><h3>📖 Все операции (${tx.length})</h3>
        <div class="row nowrap"><input id="logFilter" value="${C.esc(ui.logFilter)}" placeholder="фильтр" style="width:160px">
        <button class="sm ghost" data-act="applyFilter">🔍</button>
        <button class="sm danger" data-act="clearLog">Очистить</button></div></div>
      <div class="scroll-x"><table>
        <tr><th>Время</th><th>Год/сезон</th><th>Тип</th><th>От</th><th>Кому</th><th>Что</th><th>Примечание</th></tr>
        ${tx
          .map(
            (t) => `<tr>
              <td class="tiny mono">${C.fmtTimeOfDay(t.at)}</td>
              <td class="tiny">${t.year} ${C.SEASON_LABELS[t.season] || ''}</td>
              <td class="tiny">${t.kind}${t.byMaster ? ' 🎲' : ''}</td>
              <td class="tiny">${C.esc(t.fromName || '—')}</td>
              <td class="tiny">${C.esc(t.toName || '—')}</td>
              <td class="tiny">${C.bundleText(t.items)}${t.items2 ? ` ⇄ ${C.bundleText(t.items2)}` : ''}</td>
              <td class="tiny muted">${C.esc(t.note)}</td>
            </tr>`,
          )
          .join('')}
      </table></div>
    </div>
    <div class="card">
      <div class="card-title"><h3>Лента событий</h3></div>
      <div class="list">${S.feed
        .map(
          (x) => `<div class="feed-item ${x.kind}"><span class="when">${C.fmtTimeOfDay(x.at)} · ${C.SEASON_LABELS[x.season] || ''} ${x.year}</span><br>${C.esc(x.text)}</div>`,
        )
        .join('')}</div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------- обработчики */

function cfgFrom(ids) {
  const patch = {};
  for (const k of ids) {
    const el = document.getElementById(`cfg_${k}`);
    if (!el) continue;
    patch[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  return patch;
}

function handleAct(d) {
  switch (d.act) {
    /* сеть */
    case 'reloadInfo':
      loadInfo();
      break;
    case 'setPrimary':
      ui.primaryUrl = d.url;
      render();
      break;
    case 'backup':
      net.send({ type: 'master_backup' });
      break;

    /* лобби */
    case 'savePlayerRow': {
      const name = C.strVal(`nm_${d.id}`);
      const p = P(d.id);
      if (name && name !== p.name) mact('renamePlayer', { playerId: d.id, name });
      const role = C.strVal(`rl_${d.id}`);
      if (role && role !== p.role) mact('setPlayerRole', { playerId: d.id, role });
      const lordEl = document.getElementById(`ld_${d.id}`);
      if (lordEl && (lordEl.value || '') !== (p.lordId || '')) mact('setPlayerLord', { playerId: d.id, lordId: lordEl.value });
      break;
    }
    case 'kick':
      if (confirm(`Удалить игрока ${nameOf(d.id)} из сессии?`)) mact('kickPlayer', { playerId: d.id });
      break;
    case 'selectPlayer':
      ui.selPlayer = d.id;
      ui.tab = 'edit';
      render();
      break;
    case 'startGame': {
      const counts = {};
      for (const r of C.ROLES) counts[r] = C.numVal(`cnt_${r}`, 0);
      if (confirm('Начать игру? Роли и стартовые наборы будут выданы заново.')) mact('startGame', { counts });
      break;
    }
    case 'startGameKeepRoles':
      if (confirm('Начать игру с текущими ролями?')) mact('startGame', { keepRoles: true });
      break;
    case 'reassignRoles':
    case 'reassignRolesFull': {
      const counts = {};
      for (const r of C.ROLES) counts[r] = C.numVal(`cnt_${r}`, 0);
      mact('reassignRoles', { counts, applyStartingSets: d.act === 'reassignRolesFull' });
      break;
    }
    case 'backToLobby':
      if (confirm('Вернуть сессию в лобби? Всё имущество и события будут очищены, игроки останутся.')) {
        mact('backToLobby', { clearRoles: true });
      }
      break;
    case 'resetAll':
      if (confirm('ПОЛНЫЙ СБРОС: удалить всех игроков и все данные?')) mact('resetAll', {});
      break;
    case 'saveStartCfg':
      mact('setConfig', {
        patch: cfgFrom([
          'startPeasantPlots',
          'startPeasantCropEach',
          'startPeasantMoney',
          'startMerchantMoney',
          'startTsarMoney',
          'startTreasury',
          'tsarPlotsPerPeasant',
          'startFeudalMoney',
          'startBoyarMoney',
        ]),
      });
      break;

    /* время */
    case 'pause':
      mact('pause');
      break;
    case 'resume':
      mact('resume');
      break;
    case 'nextSeason':
      mact('nextSeason');
      break;
    case 'setTime':
      mact('setTime', { year: C.numVal('setYear', 1), seasonIndex: C.numVal('setSeason', 0) });
      break;
    case 'saveTimeCfg':
      mact('setConfig', { patch: cfgFrom(['seasonDurationSec', 'totalYears']), applyTimerNow: true });
      break;
    case 'setRemaining':
      mact('setSeasonRemaining', { seconds: C.numVal('remainSec', 0) });
      break;
    case 'runHarvest':
      mact('runHarvest');
      break;
    case 'resetQuotas':
      mact('resetQuotas');
      break;
    case 'resetTaxes':
      mact('resetTaxes');
      break;
    case 'recomputeResults':
      mact('recomputeResults');
      break;
    case 'finishGame':
      if (confirm('Завершить игру и подвести итоги?')) mact('finishGame');
      break;
    case 'saveSeasonFlags':
      mact('setConfig', { patch: cfgFrom(['plantOnlyInSpring', 'marketClosedInWinter', 'travelOnlyInWinter', 'taxOncePerSeason']) });
      break;

    /* экономика */
    case 'saveMarket': {
      const marketRates = {};
      const marketQuotas = {};
      for (const c of C.CROPS) {
        marketRates[c] = C.numVal(`rate_${c}`, 0);
        marketQuotas[c] = C.numVal(`quota_${c}`, 0);
      }
      mact('setConfig', { patch: { marketRates, marketQuotas } });
      break;
    }
    case 'saveEconCfg':
      mact('setConfig', {
        patch: cfgFrom([
          'boatPrice',
          'ransomPrice',
          'harvestYield',
          'feudalTaxCropsPerYear',
          'feudalTaxMoneyPerYear',
          'tsarTaxCropsPerYear',
          'tsarTaxMoneyPerYear',
          'freeTaxCropsPerYear',
          'freeTaxMoneyPerYear',
          'overthrowProtectionYears',
          'freePeasantTaxEnabled',
          'allowMerchantDowngrade',
        ]),
      });
      break;
    case 'setTreasury':
      mact('setTreasury', { value: C.numVal('treasuryVal', 0) });
      break;
    case 'addTreasury':
      mact('addTreasury', { delta: C.numVal('treasuryDelta', 0) });
      C.clearVal('treasuryDelta');
      break;
    case 'saveStateCrops':
      mact('setStateCrops', { crops: C.collectCrops('scrop') });
      break;
    case 'saveScoring':
      mact('setConfig', {
        patch: {
          scoring: {
            plotValue: C.numVal('sc_plotValue', 0),
            boatValue: C.numVal('sc_boatValue', 0),
            cropValue: C.numVal('sc_cropValue', 0),
            cropValueFromMarket: C.boolVal('sc_fromMarket'),
          },
        },
      });
      break;

    /* игрок */
    case 'rename':
      mact('renamePlayer', { playerId: d.id, name: C.strVal('ed_name') });
      break;
    case 'setRole':
      mact('setPlayerRole', { playerId: d.id, role: C.strVal('ed_role'), giveStartingSet: C.boolVal('ed_giveSet') });
      break;
    case 'setLord':
      mact('setPlayerLord', { playerId: d.id, lordId: C.strVal('ed_lord') });
      break;
    case 'setMoney':
      mact('setMoney', { playerId: d.id, value: C.numVal('ed_money', 0) });
      break;
    case 'addMoney':
      mact('addMoney', { playerId: d.id, delta: C.numVal('ed_moneyDelta', 0) });
      C.clearVal('ed_moneyDelta');
      break;
    case 'addPlots':
      mact('addPlots', { playerId: d.id, count: C.numVal('ed_plotCount', 1) });
      break;
    case 'removePlots':
      mact('removePlots', { playerId: d.id, count: C.numVal('ed_plotCount', 1) });
      break;
    case 'giveStandardSet':
      mact('giveStandardSet', { playerId: d.id, confiscate: false });
      break;
    case 'setCrops':
      mact('setCrops', { playerId: d.id, crops: C.collectCrops('ed_set') });
      break;
    case 'addCrops':
      mact('addCrops', { playerId: d.id, crops: C.collectCrops('ed_add') });
      break;
    case 'saveFlags':
      mact('setFlags', {
        playerId: d.id,
        hasBoat: C.boolVal('ed_hasBoat'),
        onMarket: C.boolVal('ed_onMarket'),
        sanctions: {
          noBoat: C.boolVal('ed_noBoat'),
          noTrade: C.boolVal('ed_noTrade'),
          noFarm: C.boolVal('ed_noFarm'),
        },
      });
      mact('lockPlayer', { playerId: d.id, locked: C.boolVal('ed_locked') });
      break;
    case 'setTax':
      mact('setTax', {
        playerId: d.id,
        cropsPaid: C.numVal('ed_taxCrops', 0),
        moneyPaid: C.numVal('ed_taxMoney', 0),
        clearSeason: true,
      });
      break;
    case 'setPlanted':
      mact('setPlotPlanted', { plotId: d.id, crop: C.strVal(`pl_${d.id}`) });
      break;
    case 'actAsPlayer': {
      let data = {};
      const raw = C.strVal('aap_data').trim();
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return C.toast('Некорректный JSON', 'error');
        }
      }
      mact('actAsPlayer', { playerId: d.id, type: C.strVal('aap_type').trim(), data });
      break;
    }

    /* передачи */
    case 'forceTransfer':
      mact('forceTransfer', {
        fromId: C.strVal('ftFrom'),
        toId: C.strVal('ftTo'),
        money: C.numVal('ftMoney', 0),
        crops: C.collectCrops('ftc'),
        plotCount: C.numVal('ftPlots', 0),
        ignoreChecks: C.boolVal('ftIgnore'),
      });
      break;
    case 'movePlots':
      mact('movePlots', { fromId: C.strVal('mpFrom'), toId: C.strVal('mpTo'), count: C.numVal('mpCount', 1) });
      break;

    /* сообщения */
    case 'announce':
      mact('announce', { text: C.strVal('annText') });
      C.clearVal('annText');
      break;
    case 'notifyPlayer':
      mact('notifyPlayer', { playerId: C.strVal('notifyWho'), text: C.strVal('notifyText') });
      C.clearVal('notifyText');
      break;
    case 'rawPatch': {
      let patch;
      try {
        patch = JSON.parse(C.strVal('rawPatch'));
      } catch (e) {
        return C.toast('Некорректный JSON', 'error');
      }
      if (confirm('Применить патч к состоянию игры?')) mact('rawPatch', { patch });
      break;
    }

    /* политика */
    case 'decree':
      mact('resolveDecree', { decreeId: d.id, outcome: d.out });
      break;
    case 'boyarVote':
      mact('setBoyarVote', { decreeId: d.id, boyarId: d.b, vote: d.v });
      break;
    case 'forceOverthrow':
      if (confirm('Свергнуть царя принудительно? Начнутся выборы.')) mact('forceOverthrow');
      break;
    case 'startElection':
      mact('startElection', {});
      break;
    case 'finishElection':
      mact('finishElection', { winnerId: d.id || null });
      break;
    case 'cancelElection':
      mact('cancelElection');
      break;
    case 'cancelOverthrow':
      mact('cancelOverthrow');
      break;
    case 'request':
      mact('handleRequest', { requestId: d.id, mode: d.mode });
      break;

    /* журнал */
    case 'applyFilter':
      ui.logFilter = C.strVal('logFilter');
      render();
      break;
    case 'clearLog':
      if (confirm('Очистить журнал операций?')) mact('clearLog');
      break;

    default:
      C.toast(`Нет обработчика: ${d.act}`, 'error');
  }
}

loadInfo();
render();
