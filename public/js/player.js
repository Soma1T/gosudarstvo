import * as C from './common.js';

const root = document.getElementById('root');

const TOKEN_KEY = 'gos_token';

const ui = {
  tab: 'home',
  sel: {},          // выбранные цели действий по контекстам
  joinPhase: 'lobby',
  authState: 'connecting', // connecting | join | ready | kicked
  lastError: '',
};

let S = null;
let me = null;
let net = null;
let clock = { remainingMs: 0, at: Date.now(), paused: false, time: null };

/* --------------------------------------------------------------- сеть */

function send(action, data = {}) {
  net.send({ type: 'action', action, data });
}

net = C.connect({
  onOpen() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) net.send({ type: 'auth', token });
  },
  onMessage(msg) {
    switch (msg.type) {
      case 'hello':
        ui.joinPhase = msg.phase;
        if (!localStorage.getItem(TOKEN_KEY)) {
          ui.authState = 'join';
          render();
        }
        break;
      case 'auth_failed':
        localStorage.removeItem(TOKEN_KEY);
        ui.authState = 'join';
        render();
        break;
      case 'welcome':
        localStorage.setItem(TOKEN_KEY, msg.token);
        ui.authState = 'ready';
        break;
      case 'state':
        S = msg;
        me = msg.me;
        ui.joinPhase = msg.phase;
        ui.authState = 'ready';
        if (msg.time) clock = { remainingMs: msg.time.remainingMs, at: Date.now(), paused: msg.time.paused, time: msg.time };
        render();
        break;
      case 'time':
        clock = { remainingMs: msg.time.remainingMs, at: Date.now(), paused: msg.time.paused, time: msg.time };
        if (S) {
          S.time = msg.time;
          if (S.phase !== msg.phase) {
            S.phase = msg.phase;
            render();
          }
        }
        paintClock();
        break;
      case 'kicked':
        localStorage.removeItem(TOKEN_KEY);
        ui.authState = 'kicked';
        S = null;
        render();
        break;
      case 'toast':
        C.toast(msg.message, msg.kind);
        break;
      case 'error':
        C.toast(msg.error, 'error');
        ui.lastError = msg.error;
        render();
        break;
      default:
        break;
    }
  },
});

/* ------------------------------------------------------------- часы */

function remainingNow() {
  if (!clock.time) return 0;
  if (clock.paused) return clock.remainingMs;
  return Math.max(0, clock.remainingMs - (Date.now() - clock.at));
}

function paintClock() {
  const el = document.getElementById('clockVal');
  if (!el || !clock.time) return;
  el.textContent = clock.paused ? '⏸ пауза' : C.fmtClock(remainingNow());
  const sub = document.getElementById('clockSub');
  if (sub) {
    sub.textContent = `${C.SEASON_ICONS[clock.time.season]} ${clock.time.seasonLabel} · год ${clock.time.year}/${clock.time.totalYears}`;
  }
}
setInterval(paintClock, 300);

/* ------------------------------------------------------- вспомогательное */

function byId(id) {
  return (S && S.players.find((p) => p.id === id)) || null;
}
function nameOf(id) {
  const p = byId(id);
  return p ? p.name : '—';
}
function others() {
  return S.players.filter((p) => p.id !== me.id);
}
function playersOfRole(role) {
  return S.players.filter((p) => p.role === role);
}
function season() {
  return S.time.season;
}
function myPlots() {
  return me.plots || [];
}
function pickPlots(n) {
  const sorted = myPlots().slice().sort((a, b) => (a.planted ? 1 : 0) - (b.planted ? 1 : 0));
  return sorted.slice(0, Math.max(0, n)).map((p) => p.id);
}
function tradeBlocked(other) {
  if (me.sanctions.noTrade) return 'вам запрещён обмен (санкция)';
  if (other.sanctions && other.sanctions.noTrade) return 'игроку запрещён обмен (санкция)';
  const aOn = me.role === 'merchant' && me.onMarket;
  const bOn = other.role === 'merchant' && other.onMarket;
  if (aOn !== bOn) return 'только купцы на Рынке';
  return null;
}
function setSel(key, value) {
  ui.sel[key] = value;
  render();
}

window.gosSel = setSel;

/* -------------------------------------------------------------- рендер */

function render() {
  if (ui.authState === 'join') return renderJoin();
  if (ui.authState === 'kicked') return renderKicked();
  if (!S || !me) return renderSplash('Подключение к сессии…');
  if (S.phase === 'lobby') return renderShell(renderLobby());
  if (S.phase === 'finished') return renderShell(renderResults());
  // Пока идут выборы царя, остальные действия недоступны.
  if (S.electionBlock) return renderShell(renderElectionGate(), { noTabs: true });
  return renderShell(renderTabContent());
}

function renderSplash(text) {
  C.renderInto(root, `<div class="section center" style="padding-top:80px">
    <div style="font-size:44px">👑</div>
    <h1>Государство</h1>
    <p class="muted">${C.esc(text)}</p></div>`);
}

function renderKicked() {
  C.renderInto(
    root,
    `<div class="section center" style="padding-top:60px">
      <div style="font-size:44px">🚪</div>
      <h1>Вы вне сессии</h1>
      <p class="muted">Мастер удалил вас из комнаты или сессия сброшена.</p>
      <button class="wide mt" onclick="location.reload()">Подключиться заново</button>
    </div>`,
  );
}

function renderJoin() {
  const started = ui.joinPhase !== 'lobby';
  C.renderInto(
    root,
    `<div class="section" style="padding-top:44px">
      <div class="center" style="margin-bottom:18px">
        <div style="font-size:52px">👑</div>
        <h1 style="margin-bottom:2px">ГОСУДАРСТВО</h1>
        <div class="muted small">экономико-политическая игра живого действия</div>
      </div>
      <div class="card">
        <div class="field">
          <label>Ваше имя (как вас звать в игре)</label>
          <input id="joinName" maxlength="24" placeholder="Например: Дмитрий" autocomplete="off" />
        </div>
        ${started ? `<p class="small" style="color:var(--gold2)">Игра уже началась. Вы подключитесь без роли — мастер выдаст её вручную.</p>` : ''}
        <button class="wide" id="joinBtn">${started ? 'Подключиться (игра идёт)' : 'Войти в сессию'}</button>
        ${ui.lastError ? `<p class="small mt" style="color:var(--red)">${C.esc(ui.lastError)}</p>` : ''}
      </div>
      <p class="tiny muted center">Устройство запомнит вас: при перезагрузке страницы вы вернётесь в свою роль.</p>
    </div>`,
  );
  const input = document.getElementById('joinName');
  const go = () => {
    const name = input.value.trim();
    if (!name) return C.toast('Введите имя', 'error');
    ui.lastError = '';
    net.send({ type: 'join', name, force: started });
  };
  document.getElementById('joinBtn').onclick = go;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
  input.focus();
}

const TABS = [
  { id: 'home', ic: '🏠', label: 'Обзор' },
  { id: 'role', ic: '⚙️', label: 'Действия' },
  { id: 'trade', ic: '🤝', label: 'Обмен' },
  { id: 'politics', ic: '📜', label: 'Политика' },
  { id: 'rules', ic: '📕', label: 'Правила' },
];

function renderShell(inner, { noTabs = false } = {}) {
  const unread = (me.notifications || []).filter((n) => !n.read).length;
  const pending = (S.requests || []).filter(
    (r) => r.status === 'pending' && (r.approvals[me.id] === 'pending' || (r.needBoyar && me.role === 'boyar' && !r.boyarVote)),
  ).length;
  const votes = (S.decrees || []).filter((d) => d.status === 'voting' && me.role === 'boyar' && !d.votes[me.id]).length;

  const badgeFor = (id) => {
    if (id === 'home' && unread) return '<span class="dot"></span>';
    if (id === 'trade' && pending) return '<span class="dot"></span>';
    if (id === 'politics' && votes) return '<span class="dot"></span>';
    return '';
  };

  C.renderInto(
    root,
    `<div class="app">
      <div class="topbar">
        <div class="grow">
          <div class="brand">Государство</div>
          <div class="who">${C.esc(me.name)} ${C.roleBadge(me.role)}</div>
        </div>
        <div class="clock">
          <div class="big" id="clockVal">—</div>
          <div class="sub" id="clockSub"></div>
        </div>
      </div>
      <div class="section">${inner}</div>
    </div>
    ${
      S.phase === 'running' && !noTabs
        ? `<div class="tabs">${TABS.map(
            (t) => `<button class="${ui.tab === t.id ? 'on' : ''}" data-tab="${t.id}">
              <span class="ic">${t.ic}</span>${t.label}${badgeFor(t.id)}</button>`,
          ).join('')}</div>`
        : ''
    }`,
  );
  paintClock();
  root.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      ui.tab = b.dataset.tab;
      if (ui.tab === 'home' && unread) send('readNotifications');
      render();
    };
  });
  bindActions();
}

/* ------------------------------------------------------------- лобби */

function renderLobby() {
  return `<div class="card center">
      <div style="font-size:40px">⏳</div>
      <h2>Вы в сессии</h2>
      <p class="muted small">Ждём мастера. Роль выдадут автоматически при старте игры.</p>
      <div class="field mt" style="max-width:280px;margin:14px auto 0">
        <label>Изменить имя</label>
        <div class="row nowrap">
          <input id="lobbyName" class="grow" maxlength="24" value="${C.esc(me.name)}" />
          <button class="sm" data-act="setName">OK</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title"><h3>В комнате: ${S.players.length}</h3></div>
      <div class="list">${S.players
        .map(
          (p) => `<div class="item ${p.id === me.id ? 'hl' : ''}">
            <div class="spread"><span>${p.connected ? '🟢' : '⚪'} ${C.esc(p.name)}${p.id === me.id ? ' <span class="tiny muted">(вы)</span>' : ''}</span>
            ${p.role ? C.roleBadge(p.role) : ''}</div></div>`,
        )
        .join('')}</div>
    </div>
    ${feedCard(8)}`;
}

/* --------------------------------------------------- выборы: блокировка */

function renderElectionGate() {
  const el = S.election;
  if (!el) return '<div class="card center"><h2>Выборы царя</h2></div>';
  const isCandidate = el.candidates.some((c) => c.id === me.id);
  return `<div class="card center">
      <div style="font-size:44px">🗳️</div>
      <h2>Выборы царя</h2>
      <p class="small" style="color:var(--gold2)">${C.esc(S.electionBlock)}</p>
      <p class="tiny muted mb0">Проголосовало ${el.votedCount} из ${el.voterCount}. Остальные действия заблокированы.</p>
    </div>
    <div class="card">
      <div class="card-title"><h3>Кандидаты</h3></div>
      ${
        isCandidate
          ? '<p class="small muted">Вы кандидат на престол — кандидаты не голосуют. Дождитесь результата выборов.</p>'
          : '<p class="small muted">Выберите нового царя, чтобы продолжить игру.</p>'
      }
      <div class="list">${el.candidates
        .map(
          (c) => `<div class="item"><div class="spread">
            <span><b>${C.esc(c.name)}</b> ${C.roleBadge(c.role)} <span class="tiny muted">голосов: ${c.votes}</span></span>
            ${isCandidate ? '' : `<button class="sm" data-act="voteElection" data-id="${c.id}">Голосовать</button>`}
          </div></div>`,
        )
        .join('')}</div>
    </div>
    ${feedCard(6)}`;
}

/* -------------------------------------------------------------- итоги */

function renderResults() {
  const r = S.results;
  if (!r) return `<div class="card center"><h2>Игра завершена</h2><p class="muted">Итоги считаются…</p></div>`;
  const mine = r.rows.findIndex((x) => x.id === me.id);
  return `<div class="card center">
      <div style="font-size:40px">🏁</div>
      <h2>Игра завершена</h2>
      <p class="muted small">Государственная казна: <b>${r.treasury}</b> монет</p>
      ${mine >= 0 ? `<p>Ваше место: <b>${mine + 1}</b> из ${r.rows.length}. Личные монеты: <b>${r.rows[mine].money}</b></p>` : ''}
    </div>
    <div class="card">
      <div class="card-title"><h3>Личные монеты</h3><span class="tiny muted">только монеты идут в зачёт</span></div>
      <div class="scroll-x"><table>
        <tr><th>#</th><th>Игрок</th><th>Роль</th><th>Монеты</th></tr>
        ${r.rows
          .map(
            (row, i) => `<tr${row.id === me.id ? ' style="color:var(--gold2)"' : ''}>
            <td>${i + 1}</td><td>${C.esc(row.name)}</td><td class="tiny">${C.ROLE_LABELS[row.role] || '—'}</td>
            <td class="mono"><b>${row.money}</b></td></tr>`,
          )
          .join('')}
      </table></div>
    </div>
    ${feedCard(12)}`;
}

/* ------------------------------------------------------------ вкладки */

function renderTabContent() {
  switch (ui.tab) {
    case 'role':
      return renderRoleTab();
    case 'trade':
      return renderTradeTab();
    case 'politics':
      return renderPoliticsTab();
    case 'rules':
      return renderRulesTab();
    default:
      return renderHome();
  }
}

/* --------------------------------------------------------------- обзор */

const SEASON_HINTS = {
  peasant: {
    spring: 'Весна — можно сажать культуры на своих участках (1 культура на участок).',
    summer: 'Лето — время сделок и политики. Посадка недоступна.',
    autumn: 'Осень — урожай собран автоматически. Феодал может собрать налог.',
    winter: 'Зима — торговля на материке. Море открыто (для купцов).',
  },
  feudal: {
    spring: 'Весна — крестьяне сажают. Следите за их участками.',
    summer: 'Лето — время сделок и политики.',
    autumn: 'Осень — можно собрать налог с крестьян (в пределах годового лимита).',
    winter: 'Зима — торговля на материке.',
  },
  merchant: {
    spring: 'Весна — Рынок принимает культуры: можно продавать системе, если вы на Рынке. Море закрыто.',
    summer: 'Лето — Рынок принимает культуры: можно продавать системе, если вы на Рынке. Море закрыто.',
    autumn: 'Осень — море открыто: можно отплыть на Рынок или вернуться. Рынок культуры не принимает.',
    winter: 'Зима — море открыто: можно отплыть на Рынок или вернуться. Рынок культуры не принимает.',
  },
  boyar: {
    spring: 'Весна — продавайте лодки, следите за указами.',
    summer: 'Лето — время политики: указы, подтверждения переходов.',
    autumn: 'Осень — сбор налога с вольных крестьян (если введён указ).',
    winter: 'Зима — торговля на материке.',
  },
  tsar: {
    spring: 'Весна — раздача участков крестьянам через ваш фонд.',
    summer: 'Лето — политика: указы, назначения.',
    autumn: 'Осень — можно собрать налог с феодалов.',
    winter: 'Зима — торговля на материке.',
  },
};

function renderHome() {
  const notifs = me.notifications || [];
  const sanc = [];
  if (me.sanctions.noBoat) sanc.push('запрет покупки лодки');
  if (me.sanctions.noTrade) sanc.push('запрет обмена');
  if (me.sanctions.noFarm) sanc.push('запрет возделывания земли');

  return `<div class="card">
      <div class="card-title">
        <h2 style="margin:0">${C.ROLE_ICONS[me.role] || ''} ${C.ROLE_LABELS[me.role] || 'Без роли'}</h2>
        ${me.role === 'merchant' ? `<span class="badge ${me.onMarket ? 'green' : 'off'}">${me.onMarket ? 'на Рынке' : 'на материке'}</span>` : ''}
      </div>
      <div class="grid g2">
        <div class="stat"><div class="v">${me.money}</div><div class="k">монет</div></div>
        <div class="stat"><div class="v">${myPlots().length}</div><div class="k">участков</div></div>
      </div>
      <div class="grid g4 mt">
        ${C.CROPS.map(
          (c) => `<div class="stat"><div class="v">${me.crops[c] || 0}</div><div class="k">${C.CROP_ICONS[c]} ${C.CROP_LABELS[c]}</div></div>`,
        ).join('')}
      </div>
      <p class="small muted mt mb0">${C.esc((SEASON_HINTS[me.role] || {})[season()] || '')}</p>
    </div>

    <div class="card tight">
      <div class="small">
        ${me.role === 'peasant' ? (me.lordId ? `Феодал: <b>${C.esc(me.lordName)}</b> · выкуп ${S.config.ransomPrice} монет` : 'Вы <b>вольный крестьянин</b>') : ''}
        ${me.role === 'feudal' ? `Крестьян в подчинении: <b>${(S.wards || []).length}</b>` : ''}
        ${me.role === 'tsar' ? `Казна: <b>${S.treasury}</b> монет · фонд участков: <b>${myPlots().length}</b>` : ''}
        ${me.role === 'boyar' ? `Лодки: <b>∞</b> · цена ${S.config.boatPrice} монет · казна: <b>${S.treasury}</b>` : ''}
        ${me.hasBoat ? ' · 🛶 лодка' : ''}
      </div>
      ${sanc.length ? `<div class="small mt" style="color:var(--red)">⚠ Санкции: ${sanc.join(', ')}${me.sanctions.notes ? ` (${C.esc(me.sanctions.notes)})` : ''}</div>` : ''}
    </div>

    ${plotsCard()}

    <div class="card">
      <div class="card-title"><h3>Уведомления</h3>${notifs.length ? `<button class="sm ghost" data-act="clearNotifs">прочитано</button>` : ''}</div>
      ${
        notifs.length
          ? `<div class="list">${notifs
              .slice(0, 14)
              .map(
                (n) => `<div class="item ${n.read ? 'dim' : ''}"><div class="tiny muted">${C.fmtTimeOfDay(n.at)}</div>${C.esc(n.text)}</div>`,
              )
              .join('')}</div>`
          : '<p class="small muted mb0">Пока ничего.</p>'
      }
    </div>
    ${feedCard(10)}`;
}

function plotsCard() {
  const plots = myPlots();
  if (!plots.length && me.role !== 'peasant') return '';
  return `<div class="card">
      <div class="card-title"><h3>Участки (${plots.length})</h3>
        <span class="tiny muted">${me.role === 'peasant' ? 'урожай: 1 → ' + S.config.harvestYield : 'на хранении'}</span></div>
      ${
        plots.length
          ? `<div class="grid gauto" style="grid-template-columns:repeat(auto-fill,minmax(84px,1fr))">${plots
              .map(
                (p) => `<div class="plot ${p.planted ? 'planted' : ''}">
                  <div class="id">${p.id}</div>
                  <div>${p.planted ? `${C.CROP_ICONS[p.planted]} ${C.CROP_LABELS[p.planted]}` : '— пусто —'}</div>
                </div>`,
              )
              .join('')}</div>`
          : '<p class="small muted mb0">Нет участков.</p>'
      }
      ${me.role !== 'peasant' && plots.length ? '<p class="tiny muted mt mb0">Вы не можете возделывать землю — участки только хранятся и передаются крестьянам.</p>' : ''}
    </div>`;
}

function feedCard(limit) {
  const feed = (S.feed || []).slice(0, limit);
  if (!feed.length) return '';
  return `<div class="card">
    <div class="card-title"><h3>Лента событий</h3></div>
    <div class="list">${feed
      .map(
        (f) => `<div class="feed-item ${f.kind}"><span class="when">${C.fmtTimeOfDay(f.at)} · ${C.SEASON_LABELS[f.season] || ''} ${f.year}</span><br>${C.esc(f.text)}</div>`,
      )
      .join('')}</div></div>`;
}

/* --------------------------------------------------- вкладка «Действия» */

function renderRoleTab() {
  switch (me.role) {
    case 'peasant':
      return peasantPanel();
    case 'feudal':
      return feudalPanel();
    case 'merchant':
      return merchantPanel();
    case 'boyar':
      return boyarPanel();
    case 'tsar':
      return tsarPanel();
    default:
      return `<div class="card center"><h3>Роль не назначена</h3><p class="muted small">Дождитесь, пока мастер выдаст вам роль.</p></div>`;
  }
}

/* ----- крестьянин ----- */

function peasantPanel() {
  const free = myPlots().filter((p) => !p.planted).length;
  const canPlant = !S.config.plantOnlyInSpring || season() === 'spring';
  const feudals = playersOfRole('feudal').filter((f) => f.id !== me.lordId);
  const boyarsList = playersOfRole('boyar');

  return `${plotsVisual()}
    <div class="card">
      <div class="card-title"><h3>🌱 Посадка</h3><span class="tiny muted">свободных участков: ${free}</span></div>
      ${
        canPlant
          ? me.sanctions.noFarm
            ? `<p class="small" style="color:var(--red)">Вам запрещено возделывать землю (санкция).</p>`
            : `<div class="grid g2">
                <div><label>Культура</label>
                  <select id="plantCrop">${C.CROPS.map(
                    (c) => `<option value="${c}">${C.CROP_ICONS[c]} ${C.CROP_LABELS[c]} (есть ${me.crops[c] || 0})</option>`,
                  ).join('')}</select></div>
                <div><label>Сколько участков</label><input type="number" id="plantCount" min="1" max="${Math.max(1, free)}" value="${Math.max(1, Math.min(free, 1))}" inputmode="numeric"></div>
              </div>
              <button class="wide mt" data-act="plant" ${free ? '' : 'disabled'}>Посадить</button>
              <p class="tiny muted mt mb0">1 посаженная культура → ${S.config.harvestYield} собранных Осенью.</p>`
          : `<p class="small muted mb0">Сажать можно только Весной. Сейчас ${C.SEASON_LABELS[season()]}.</p>`
      }
    </div>

    <div class="card">
      <div class="card-title"><h3>⛵ Купить лодку</h3><span class="tiny muted">${S.config.boatPrice} монет</span></div>
      ${
        me.sanctions.noBoat
          ? `<p class="small" style="color:var(--red)">Вам запрещено покупать лодку (санкция).</p>`
          : boyarsList.length
            ? `<p class="small muted">Покупка лодки делает вас <b>купцом</b>. Участки перейдут по вашему выбору, вернуться в крестьяне нельзя.</p>
               <div class="field"><label>У кого покупаете</label>
                 <select id="boatBoyar">${boyarsList.map((b) => `<option value="${b.id}">${C.esc(b.name)}</option>`).join('')}</select></div>
               <div class="field"><label>Кому передать ваши участки (${myPlots().length})</label>
                 <select id="boatPlotTarget">
                   ${me.lordId ? `<option value="lord">Феодалу — ${C.esc(me.lordName)}</option>` : ''}
                   <option value="tsar">Царю (в казну)</option>
                 </select>
                 ${!me.lordId ? '<p class="tiny muted">Вольный крестьянин передаёт участки только царю.</p>' : ''}
               </div>
               <button class="wide" data-act="requestBoat" ${me.money >= S.config.boatPrice ? '' : 'disabled'}>
                 ${me.money >= S.config.boatPrice ? 'Запросить покупку лодки' : `Не хватает ${S.config.boatPrice - me.money} монет`}
               </button>`
            : `<p class="small muted mb0">В игре нет бояр — лодку купить не у кого.</p>`
      }
    </div>

    ${
      me.lordId
        ? `<div class="card">
            <div class="card-title"><h3>🔓 Выкуп из зависимости</h3><span class="tiny muted">${S.config.ransomPrice} монет</span></div>
            <p class="small muted">Ваш феодал: <b>${C.esc(me.lordName)}</b>. После выкупа вы станете вольным крестьянином.</p>
            <p class="small" style="color:var(--gold2)">⚠ Все ваши участки (${myPlots().length}) останутся феодалу — землю придётся получать заново.</p>
            <button class="wide" data-act="ransom" ${me.money >= S.config.ransomPrice ? '' : 'disabled'}>
              ${me.money >= S.config.ransomPrice ? `Выкупиться за ${S.config.ransomPrice}` : `Не хватает ${S.config.ransomPrice - me.money} монет`}
            </button>
          </div>
          <div class="card">
            <div class="card-title"><h3>🔁 Перейти к другому феодалу</h3></div>
            ${
              feudals.length
                ? `<p class="tiny muted">Нужны согласия текущего и нового феодала и подтверждение любого боярина.</p>
                   <div class="field"><select id="newLord">${feudals.map((f) => `<option value="${f.id}">${C.esc(f.name)}</option>`).join('')}</select></div>
                   <button class="wide ghost" data-act="requestLordChange">Отправить запрос</button>`
                : '<p class="small muted mb0">Других феодалов нет.</p>'
            }
          </div>`
        : `<div class="card">
            <div class="card-title"><h3>🛡️ Пойти под покровительство</h3></div>
            <p class="small muted">Вы вольный крестьянин${S.config.freePeasantTaxEnabled ? ' — введён указ о налоге для вольных, его собирают бояре' : ''}.</p>
            ${
              playersOfRole('feudal').length
                ? `<div class="field"><select id="patronFeudal">${playersOfRole('feudal')
                    .map((f) => `<option value="${f.id}">${C.esc(f.name)}</option>`)
                    .join('')}</select></div>
                   <button class="wide ghost" data-act="requestPatronage">Попросить покровительства</button>`
                : '<p class="small muted mb0">Феодалов нет.</p>'
            }
          </div>`
    }
    ${taxInfoCard()}`;
}

/** Наглядная карта участков крестьянина: прямоугольники с посаженной культурой. */
function plotsVisual() {
  const plots = myPlots();
  const planted = plots.filter((p) => p.planted).length;
  return `<div class="card">
      <div class="card-title"><h3>🟩 Мои участки</h3>
        <span class="tiny muted">${plots.length ? `засеяно ${planted} из ${plots.length}` : 'участков нет'}</span></div>
      ${
        plots.length
          ? `<div class="plot-map">${plots
              .map(
                (p) => `<div class="plot-cell ${p.planted ? 'sown' : ''}">
                  <div class="plot-cell-id">${p.id}</div>
                  <div class="plot-cell-ico">${p.planted ? C.CROP_ICONS[p.planted] : '·'}</div>
                  <div class="plot-cell-name">${p.planted ? C.CROP_LABELS[p.planted] : 'пусто'}</div>
                </div>`,
              )
              .join('')}</div>
             <p class="tiny muted mt mb0">Осенью каждая посадка даёт ${S.config.harvestYield} культуры, участок снова становится пустым.</p>`
          : '<p class="small muted mb0">У вас нет участков. Получить их можно от феодала или царя.</p>'
      }
    </div>`;
}

function taxInfoCard() {
  const t = me.tax || {};
  const limits =
    me.role === 'peasant'
      ? me.lordId
        ? { c: S.config.feudalTaxCropsPerYear, m: S.config.feudalTaxMoneyPerYear, who: 'феодалу' }
        : S.config.freePeasantTaxEnabled
          ? { c: S.config.freeTaxCropsPerYear, m: S.config.freeTaxMoneyPerYear, who: 'государству' }
          : null
      : me.role === 'feudal'
        ? { c: S.config.tsarTaxCropsPerYear, m: S.config.tsarTaxMoneyPerYear, who: 'царю' }
        : null;
  if (!limits) return '';
  return `<div class="card tight">
    <div class="small"><b>Налог ${limits.who}</b> — лимит на год: ${limits.c} культур + ${limits.m} монет.
    Уже удержано за год ${S.time.year}: ${t.cropsPaid || 0} культур, ${t.moneyPaid || 0} монет.</div></div>`;
}

/* ----- феодал ----- */

function feudalPanel() {
  const wards = S.wards || [];
  const freePeasants = playersOfRole('peasant').filter((p) => !p.lordId);
  const sel = ui.sel.tax;
  return `${taxCollectCard('Крестьяне в подчинении', wards, sel)}
    <div class="card">
      <div class="card-title"><h3>🛡️ Взять под покровительство</h3></div>
      ${
        freePeasants.length
          ? `<div class="field"><select id="patronPeasant">${freePeasants
              .map((p) => `<option value="${p.id}">${C.esc(p.name)}</option>`)
              .join('')}</select></div>
             <button class="wide ghost" data-act="offerPatronage">Предложить покровительство</button>`
          : '<p class="small muted mb0">Вольных крестьян нет.</p>'
      }
    </div>
    <div class="card">
      <div class="card-title"><h3>🟩 Участки на хранении: ${myPlots().length}</h3></div>
      <p class="small muted mb0">Возделывать землю вы не можете. Передайте участки крестьянам через вкладку «Обмен».</p>
    </div>
    ${requestsCard(true)}
    ${taxInfoCard()}`;
}

function taxCollectCard(title, wards, sel) {
  const w = wards.find((x) => x.id === sel) || null;
  return `<div class="card">
      <div class="card-title"><h3>🧾 ${title} (${wards.length})</h3></div>
      ${
        wards.length
          ? `<div class="list">${wards
              .map((x) => {
                const left = x.taxLeft;
                const info = left
                  ? left.collectedThisSeason
                    ? '<span class="badge off">в этом сезоне собрано</span>'
                    : `<span class="badge ${left.crops || left.money ? 'green' : 'off'}">осталось: ${left.crops}🌾 / ${left.money}💰</span>`
                  : `<span class="badge red">${C.esc(x.taxError || '—')}</span>`;
                return `<div class="item ${sel === x.id ? 'hl' : ''}">
                  <div class="spread">
                    <span>${x.connected ? '🟢' : '⚪'} <b>${C.esc(x.name)}</b> <span class="tiny muted">${x.plots} уч.</span></span>
                    ${info}
                  </div>
                  <button class="sm ghost mt" onclick="gosSel('tax','${sel === x.id ? '' : x.id}')">${sel === x.id ? 'Скрыть' : 'Собрать налог'}</button>
                  ${
                    sel === x.id
                      ? `<div class="mt">
                          ${C.cropInputs('taxc')}
                          <div class="field mt"><label>💰 Монеты (макс ${left ? left.money : 0})</label>
                            <input type="number" id="taxMoney" min="0" max="${left ? left.money : 0}" placeholder="0" inputmode="numeric"></div>
                          <button class="wide good" data-act="collectTax" data-id="${x.id}">Списать налог</button>
                          <p class="tiny muted mt mb0">Списание автоматическое, игрок получит уведомление. Лимит на год: ${left ? left.crops : 0} культур и ${left ? left.money : 0} монет осталось.</p>
                        </div>`
                      : ''
                  }
                </div>`;
              })
              .join('')}</div>`
          : '<p class="small muted mb0">Некого облагать налогом.</p>'
      }
    </div>`;
}

/* ----- купец ----- */

function merchantPanel() {
  const m = S.market;
  const canTravel = m.travelOpen;
  const travelSeasons = (S.config.travelSeasons || []).map((s) => C.SEASON_LABELS[s]).join(' и ');
  const marketSeasons = (S.config.marketOpenSeasons || []).map((s) => C.SEASON_LABELS[s]).join(' и ');
  return `<div class="card">
      <div class="card-title"><h3>⛵ Статус</h3>
        <span class="badge ${me.onMarket ? 'green' : 'off'}">${me.onMarket ? 'на Рынке' : 'на материке'}</span></div>
      <p class="small muted">Море открыто ${travelSeasons} — только в эти сезоны можно отплыть на Рынок или вернуться.
        Пока вы на Рынке, обмениваться с вами могут только купцы, которые тоже на Рынке.</p>
      <button class="wide ${me.onMarket ? 'ghost' : ''}" data-act="toggleMarket" ${canTravel ? '' : 'disabled'}>
        ${canTravel ? (me.onMarket ? 'Вернуться на материк' : 'Отправиться на Рынок') : `Море закрыто (сейчас ${C.SEASON_LABELS[season()]})`}
      </button>
      ${m.merchantsOnMarket.length ? `<p class="tiny muted mt mb0">На Рынке: ${m.merchantsOnMarket.map((x) => C.esc(x.name)).join(', ')}</p>` : ''}
    </div>

    <div class="card">
      <div class="card-title"><h3>🏪 Продажа системе</h3>
        <span class="badge ${m.open ? 'green' : 'red'}">${m.open ? 'Рынок принимает' : 'Рынок закрыт'}</span></div>
      ${
        !me.onMarket
          ? `<p class="small muted mb0">Курс и квоты видны только на Рынке. Чтобы узнать их и продавать, нужно физически быть в зоне Рынка и иметь статус «на Рынке» (отплыть можно ${travelSeasons}).</p>`
          : !m.open
            ? `<p class="small muted mb0">Сейчас ${C.SEASON_LABELS[season()]} — Рынок культуры не принимает, курс скрыт. Рынок работает ${marketSeasons}: дождитесь открытия, оставаясь на Рынке. Пока можно торговать с другими купцами на Рынке.</p>`
            : `<div class="list">${C.CROPS.map(
                (c) => `<div class="item">
                  <div class="spread">
                    <span>${C.CROP_ICONS[c]} <b>${C.CROP_LABELS[c]}</b> <span class="tiny muted">у вас ${me.crops[c] || 0}</span></span>
                    <span class="tiny">курс <b>${m.rates[c]}</b> · квота ${m.quotaLeft[c]}/${m.quotas[c]}</span>
                  </div>
                  <div class="row nowrap mt">
                    <input class="grow" type="number" id="sell_${c}" min="1" max="${Math.min(me.crops[c] || 0, m.quotaLeft[c])}" placeholder="кол-во" inputmode="numeric">
                    <button class="sm good" data-act="sell" data-crop="${c}" ${(me.crops[c] || 0) && m.quotaLeft[c] ? '' : 'disabled'}>Продать</button>
                  </div>
                </div>`,
              ).join('')}</div>
              <p class="tiny muted mt mb0">Деньги в игре появляются только здесь. Купец не может покупать у системы.</p>`
      }
    </div>
    <div class="card tight"><p class="small muted mb0">Купец не может владеть землёй и не может вернуться в крестьяне. Торговать с игроками можно в любой сезон через вкладку «Обмен».</p></div>`;
}

/* ----- боярин ----- */

function boyarPanel() {
  const peasants = playersOfRole('peasant');
  const wards = S.wards || [];
  const lordChanges = (S.requests || []).filter((r) => r.status === 'pending' && r.needBoyar && !r.boyarVote);
  return `<div class="card">
      <div class="card-title"><h3>⛵ Продажа лодок</h3><span class="tiny muted">${S.config.boatPrice} монет · доход личный</span></div>
      ${
        peasants.length
          ? `<div class="field"><select id="boatPeasant">${peasants
              .map((p) => `<option value="${p.id}">${C.esc(p.name)}${p.sanctions && p.sanctions.noBoat ? ' (запрет)' : ''}${p.lordId ? ` — у ${C.esc(nameOf(p.lordId))}` : ' — вольный'}</option>`)
              .join('')}</select></div>
             <button class="wide" data-act="offerBoat">Предложить лодку</button>
             <p class="tiny muted mt mb0">Крестьянин подтвердит покупку сам. Запас лодок бесконечен.</p>`
          : '<p class="small muted mb0">Крестьян нет.</p>'
      }
    </div>

    <div class="card">
      <div class="card-title"><h3>✅ Подтверждение переходов</h3>${lordChanges.length ? `<span class="badge red">${lordChanges.length}</span>` : ''}</div>
      ${
        lordChanges.length
          ? `<div class="list">${lordChanges
              .map(
                (r) => `<div class="item"><div class="small">${C.esc(r.title)}</div>
                  <div class="tiny muted">Согласия феодалов: ${Object.entries(r.approvals)
                    .map(([id, v]) => `${C.esc(r.approvalNames[id] || '—')}: ${v === 'yes' ? '✔' : v === 'no' ? '✘' : '…'}`)
                    .join(' · ')}</div>
                  <div class="row mt"><button class="sm good grow" data-act="respond" data-id="${r.id}" data-ok="1">Подтвердить</button>
                  <button class="sm danger grow" data-act="respond" data-id="${r.id}" data-ok="0">Отказать</button></div></div>`,
              )
              .join('')}</div>`
          : '<p class="small muted mb0">Нет заявок на подтверждение.</p>'
      }
    </div>

    ${S.config.freePeasantTaxEnabled ? taxCollectCard('Налог с вольных крестьян → казна', wards, ui.sel.tax) : ''}

    <div class="card">
      <div class="card-title"><h3>⚖️ Жалоба царю</h3></div>
      <div class="field"><label>На кого</label>
        <select id="complainTarget"><option value="">— без указания —</option>
        ${others().map((p) => `<option value="${p.id}">${C.esc(p.name)} (${C.ROLE_LABELS[p.role] || '—'})</option>`).join('')}</select></div>
      <div class="field"><label>Что нарушено</label><textarea id="complainText" placeholder="Например: вольный крестьянин не платит налог"></textarea></div>
      <button class="wide ghost" data-act="complain">Отправить жалобу</button>
    </div>

    <div class="card tight"><p class="small muted mb0">Голосования по указам и свержение царя — во вкладке «Политика». Казна: <b>${S.treasury}</b> монет.</p></div>`;
}

/* ----- царь ----- */

function tsarPanel() {
  const wards = S.wards || [];
  const appointable = others().filter((p) => p.role !== 'tsar');
  return `${taxCollectCard('Налог с феодалов', wards, ui.sel.tax)}

    <div class="card">
      <div class="card-title"><h3>🏛️ Казна</h3><span class="badge">${S.treasury} монет</span></div>
      <p class="small muted">Культуры в казне: ${C.cropsText(S.stateCrops, { zero: true })} · участков в гос. фонде без владельца: ${S.stateFundPlots || 0}</p>
      <div class="field"><label>Кому выдать из казны</label>
        <select id="payTo">${others().map((p) => `<option value="${p.id}">${C.esc(p.name)} (${C.ROLE_LABELS[p.role] || '—'})</option>`).join('')}</select></div>
      <div class="field"><label>💰 Монеты</label><input type="number" id="payMoney" min="0" placeholder="0" inputmode="numeric"></div>
      ${C.cropInputs('payc')}
      <button class="wide mt" data-act="treasuryPay">Выдать из казны</button>
      <hr>
      <div class="row nowrap">
        <input class="grow" type="number" id="depositAmount" min="0" placeholder="Внести личные монеты в казну" inputmode="numeric">
        <button class="sm ghost" data-act="treasuryDeposit">Внести</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><h3>👥 Назначения и разжалования</h3></div>
      <div class="field"><label>Игрок</label>
        <select id="appointTarget">${appointable
          .map((p) => `<option value="${p.id}">${C.esc(p.name)} — ${C.ROLE_LABELS[p.role] || 'без роли'}${p.protectedUntilYear >= S.time.year ? ' 🛡защищён' : ''}</option>`)
          .join('')}</select></div>
      <div class="grid g2">
        <button class="ghost" data-act="appoint" data-role="feudal">Назначить феодалом</button>
        <button class="ghost" data-act="appoint" data-role="boyar">Назначить боярином</button>
        <button class="ghost" data-act="dismiss" data-role="feudal">Разжаловать в феодалы</button>
        <button class="danger" data-act="dismiss" data-role="peasant">Разжаловать в крестьяне</button>
      </div>
      <p class="tiny muted mt mb0">Разжаловать боярина можно ${S.config.boyarDismissPerSeason} раз в сезон${
        S.boyarDismiss ? ` (в этом сезоне осталось: ${S.boyarDismiss.left})` : ''
      }. Боярин → крестьянин: стандартный набор, личное конфискуется в казну. Феодал → крестьянин: ресурсы сохраняет, его крестьяне становятся вольными.</p>
    </div>

    ${decreeFormCard()}

    <div class="card">
      <div class="card-title"><h3>⚖️ Жалобы бояр</h3></div>
      ${
        (S.complaints || []).length
          ? `<div class="list">${S.complaints
              .slice(0, 10)
              .map(
                (c) => `<div class="item ${c.status === 'closed' ? 'dim' : ''}">
                  <div class="tiny muted">${C.fmtTimeOfDay(c.at)} · год ${c.year} · от ${C.esc(nameOf(c.fromId))}${c.targetId ? ` на ${C.esc(nameOf(c.targetId))}` : ''}</div>
                  ${C.esc(c.text)}
                  ${c.status === 'open' ? `<button class="sm ghost mt" data-act="resolveComplaint" data-id="${c.id}">Закрыть</button>` : ''}
                </div>`,
              )
              .join('')}</div>`
          : '<p class="small muted mb0">Жалоб нет.</p>'
      }
    </div>
    <div class="card tight"><p class="small muted mb0">Участки государства — ваши ${myPlots().length} участков. Передавайте их крестьянам и феодалам через вкладку «Обмен».</p></div>`;
}

function decreeFormCard() {
  const cfgFields = [
    ['boatPrice', 'Цена лодки', S.config.boatPrice],
    ['ransomPrice', 'Цена выкупа крестьянина', S.config.ransomPrice],
    ['feudalTaxCropsPerYear', 'Лимит феодала: культур/год', S.config.feudalTaxCropsPerYear],
    ['feudalTaxMoneyPerYear', 'Лимит феодала: монет/год', S.config.feudalTaxMoneyPerYear],
    ['tsarTaxCropsPerYear', 'Лимит царя: культур/год', S.config.tsarTaxCropsPerYear],
    ['tsarTaxMoneyPerYear', 'Лимит царя: монет/год', S.config.tsarTaxMoneyPerYear],
    ['freeTaxCropsPerYear', 'Налог вольных: культур/год', S.config.freeTaxCropsPerYear],
    ['freeTaxMoneyPerYear', 'Налог вольных: монет/год', S.config.freeTaxMoneyPerYear],
  ];
  return `<div class="card">
      <div class="card-title"><h3>📜 Издать указ</h3></div>
      <div class="field"><label>Название указа</label><input id="decreeTitle" maxlength="80" placeholder="Например: О цене лодок"></div>
      <div class="field"><label>Текст (необязательно)</label><textarea id="decreeText" maxlength="500" placeholder="Формулировка указа"></textarea></div>
      <p class="tiny muted">Заполняйте только те параметры, которые меняете. Пустое поле = без изменений.</p>
      <div class="grid g2">
        ${cfgFields
          .map(
            ([k, label, cur]) => `<div><label>${label} <span class="muted">(сейчас ${cur})</span></label>
              <input type="number" min="0" id="dec_${k}" placeholder="${cur}" inputmode="numeric"></div>`,
          )
          .join('')}
      </div>
      <label class="check mt"><input type="checkbox" id="dec_freeTax" ${S.config.freePeasantTaxEnabled ? 'checked' : ''}> Налог для вольных крестьян введён</label>
      <hr>
      <h4 style="font-size:13px;color:var(--gold2)">Персональные санкции</h4>
      <div class="field"><select id="sancTarget"><option value="">— без санкций —</option>
        ${others().map((p) => `<option value="${p.id}">${C.esc(p.name)} (${C.ROLE_LABELS[p.role] || '—'})</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="sanc_noBoat"> Запрет покупки лодки</label>
      <label class="check"><input type="checkbox" id="sanc_noTrade"> Запрет обмена с игроками</label>
      <label class="check"><input type="checkbox" id="sanc_noFarm"> Запрет возделывания земли</label>
      <p class="tiny muted">Снять санкции: выберите игрока, оставьте галочки пустыми и издайте указ.</p>
      <button class="wide" data-act="createDecree">Объявить указ (бояре голосуют)</button>
    </div>`;
}

/* ---------------------------------------------------- вкладка «Обмен» */

function renderTradeTab() {
  const target = ui.sel.trade ? byId(ui.sel.trade) : null;
  const list = others();
  const groups = ['tsar', 'boyar', 'feudal', 'merchant', 'peasant'];

  return `${myStockCard()}
    <div class="card">
      <div class="card-title"><h3>🤝 С кем обмен</h3>${target ? `<button class="sm ghost" onclick="gosSel('trade','')">Сменить</button>` : ''}</div>
      ${
        target
          ? `<div class="item hl"><div class="spread"><span><b>${C.esc(target.name)}</b> ${C.roleBadge(target.role)}</span>
              ${target.role === 'merchant' ? `<span class="badge ${target.onMarket ? 'green' : 'off'}">${target.onMarket ? 'на Рынке' : 'материк'}</span>` : ''}</div>
              ${tradeBlocked(target) ? `<div class="small mt" style="color:var(--red)">Обмен невозможен: ${tradeBlocked(target)}</div>` : ''}</div>`
          : `<div class="list">${groups
              .map((role) => {
                const rp = list.filter((p) => p.role === role);
                if (!rp.length) return '';
                return `<div><div class="tiny muted" style="margin:6px 0 2px">${C.ROLE_LABELS[role]}</div>
                  ${rp
                    .map((p) => {
                      const blocked = tradeBlocked(p);
                      return `<div class="item ${blocked ? 'dim' : ''}" style="margin-bottom:6px">
                        <div class="spread">
                          <span>${p.connected ? '🟢' : '⚪'} <b>${C.esc(p.name)}</b>
                            ${p.role === 'merchant' && p.onMarket ? '<span class="badge green">Рынок</span>' : ''}</span>
                          <button class="sm ${blocked ? 'ghost' : ''}" onclick="gosSel('trade','${p.id}')">Выбрать</button>
                        </div>
                        ${blocked ? `<div class="tiny" style="color:var(--red)">${blocked}</div>` : ''}
                      </div>`;
                    })
                    .join('')}</div>`;
              })
              .join('')}</div>`
      }
    </div>

    ${target && !tradeBlocked(target) ? `<div class="card">${offerForm(target)}</div>` : ''}
    ${requestsCard(false)}`;
}

/** Мои личные запасы — подсказка на экране обмена. */
function myStockCard() {
  return `<div class="card tight">
      <div class="card-title" style="margin-bottom:6px"><h3>🎒 Мои запасы</h3>
        <span class="tiny muted">только личное имущество</span></div>
      <div class="grid g3">
        <div class="stat"><div class="v">${me.money}</div><div class="k">💰 монет</div></div>
        <div class="stat"><div class="v">${myPlots().length}</div><div class="k">🟩 участков</div></div>
        <div class="stat"><div class="v">${me.hasBoat ? '🛶' : '—'}</div><div class="k">лодка</div></div>
      </div>
      <div class="grid g4 mt">
        ${C.CROPS.map(
          (c) => `<div class="stat"><div class="v">${me.crops[c] || 0}</div><div class="k">${C.CROP_ICONS[c]} ${C.CROP_LABELS[c]}</div></div>`,
        ).join('')}
      </div>
    </div>`;
}

function bundleFields(prefix, { withPlots = true, plotMax = 0, title = '' } = {}) {
  return `${title ? `<h4 style="font-size:13px;color:var(--gold2)">${title}</h4>` : ''}
    <div class="field"><label>💰 Монеты</label><input type="number" min="0" id="${prefix}Money" placeholder="0" inputmode="numeric"></div>
    ${C.cropInputs(prefix + 'c')}
    ${
      withPlots
        ? `<div class="field mt"><label>🟩 Участков (у вас ${plotMax}; передаются сначала незасеянные)</label>
            <input type="number" min="0" max="${plotMax}" id="${prefix}Plots" placeholder="0" inputmode="numeric"></div>`
        : ''
    }`;
}

function offerForm(target) {
  const canGetPlots = ['peasant', 'feudal', 'tsar'].includes(target.role);
  const iCanGetPlots = ['peasant', 'feudal', 'tsar'].includes(me.role);
  const targetHasPlots = ['peasant', 'feudal', 'tsar'].includes(target.role) && (target.plotsCount || 0) > 0;
  return `<p class="small muted">Заполните, что отдаёте и что просите взамен.
      Если <b>ничего не просите</b> — это просто передача, она пройдёт сразу и без подтверждения.</p>
    ${bundleFields('og', { withPlots: canGetPlots && myPlots().length > 0, plotMax: myPlots().length, title: 'Вы отдаёте' })}
    ${!canGetPlots ? `<p class="tiny muted">${C.ROLE_LABELS[target.role]} не может владеть землёй — участки передать нельзя.</p>` : ''}
    <hr>
    <h4 style="font-size:13px;color:var(--gold2)">Вы просите взамен</h4>
    <div class="field"><label>💰 Монеты</label><input type="number" min="0" id="owMoney" placeholder="0" inputmode="numeric"></div>
    ${C.cropInputs('owc')}
    ${
      iCanGetPlots && targetHasPlots
        ? `<div class="field mt"><label>🟩 Участков (у игрока ${target.plotsCount})</label>
            <input type="number" min="0" max="${target.plotsCount}" id="owPlots" placeholder="0" inputmode="numeric"></div>`
        : ''
    }
    <button class="wide mt" data-act="tradeOffer" data-id="${target.id}">Обменяться с ${C.esc(target.name)}</button>`;
}

function requestsCard(onlyMine) {
  const reqs = (S.requests || []).filter((r) => r.status === 'pending');
  const incoming = reqs.filter((r) => r.approvals[me.id] === 'pending');
  const outgoing = reqs.filter((r) => r.initiatorId === me.id);
  const boyarNeed = me.role === 'boyar' ? reqs.filter((r) => r.needBoyar && !r.boyarVote) : [];
  const recent = (S.requests || []).filter((r) => r.status !== 'pending').slice(0, 6);
  if (!incoming.length && !outgoing.length && !boyarNeed.length && !recent.length) return '';

  const block = (title, items, kind) =>
    items.length
      ? `<div class="card">
          <div class="card-title"><h3>${title}</h3><span class="badge">${items.length}</span></div>
          <div class="list">${items
            .map(
              (r) => `<div class="item">
                <div class="small">${C.esc(r.title)}</div>
                <div class="tiny muted">${new Date(r.createdAt).toLocaleTimeString('ru-RU')} · инициатор ${C.esc(r.initiatorName)}</div>
                ${
                  kind === 'act'
                    ? `<div class="row mt"><button class="sm good grow" data-act="respond" data-id="${r.id}" data-ok="1">Принять</button>
                       <button class="sm danger grow" data-act="respond" data-id="${r.id}" data-ok="0">Отклонить</button></div>`
                    : kind === 'cancel'
                      ? `<div class="tiny muted mt">Ожидает: ${Object.entries(r.approvals)
                          .map(([id, v]) => `${C.esc(r.approvalNames[id] || '')} ${v === 'yes' ? '✔' : v === 'no' ? '✘' : '…'}`)
                          .join(', ')}${r.needBoyar ? ` · боярин ${r.boyarVote === 'yes' ? '✔' : '…'}` : ''}</div>
                         <button class="sm ghost mt" data-act="cancelRequest" data-id="${r.id}">Отменить</button>`
                      : ''
                }
              </div>`,
            )
            .join('')}</div></div>`
      : '';

  return `${block('📥 Требуют вашего решения', incoming, 'act')}
    ${block('✅ Требуют подтверждения боярина', boyarNeed, 'act')}
    ${block('📤 Ваши заявки', outgoing, 'cancel')}
    ${
      !onlyMine && recent.length
        ? `<div class="card"><div class="card-title"><h3>История заявок</h3></div>
            <div class="list">${recent
              .map(
                (r) => `<div class="item dim"><div class="small">${C.esc(r.title)}</div>
                  <div class="tiny muted">${
                    { done: 'выполнено', declined: 'отклонено', cancelled: 'отменено', failed: 'ошибка' }[r.status] || r.status
                  }${r.error ? `: ${C.esc(r.error)}` : ''}</div></div>`,
              )
              .join('')}</div></div>`
        : ''
    }`;
}

/* ------------------------------------------------ вкладка «Политика» */

function renderPoliticsTab() {
  const el = S.election;
  const ov = S.overthrow;
  const decrees = S.decrees || [];
  return `${
    el && el.status === 'voting'
      ? `<div class="card">
          <div class="card-title"><h3>🗳️ Выборы царя</h3><span class="badge">${el.votedCount}/${el.voterCount}</span></div>
          ${
            el.candidates.some((c) => c.id === me.id)
              ? '<p class="small muted">Вы кандидат — кандидаты не голосуют.</p>'
              : '<p class="small muted">Выберите нового царя.</p>'
          }
          <div class="list">${el.candidates
            .map(
              (c) => `<div class="item"><div class="spread">
                <span><b>${C.esc(c.name)}</b> ${C.roleBadge(c.role)} <span class="tiny muted">голосов: ${c.votes}</span></span>
                ${el.candidates.some((x) => x.id === me.id) ? '' : `<button class="sm" data-act="voteElection" data-id="${c.id}">Голосовать</button>`}
              </div></div>`,
            )
            .join('')}</div>
        </div>`
      : ''
  }
  ${
    ov && ov.status === 'voting'
      ? `<div class="card">
          <div class="card-title"><h3>⚔️ Свержение царя</h3><span class="badge red">идёт</span></div>
          <p class="small muted">Начал: ${C.esc(ov.startedByName)}. Нужно единогласие всех бояр.</p>
          <div class="list">${ov.votes
            .map(
              (v) => `<div class="item tiny"><div class="spread"><span>${C.esc(v.name)}</span>
                <span>${v.vote === true ? '⚔️ за' : v.vote === false ? '✘ против' : '… не голосовал'}</span></div></div>`,
            )
            .join('')}</div>
          ${
            me.role === 'boyar'
              ? `<div class="row mt"><button class="sm danger grow" data-act="voteOverthrow" data-v="1">За свержение</button>
                 <button class="sm ghost grow" data-act="voteOverthrow" data-v="0">Против</button></div>`
              : ''
          }
        </div>`
      : me.role === 'boyar'
        ? `<div class="card">
            <div class="card-title"><h3>⚔️ Свержение царя</h3></div>
            <p class="small muted">Требуется единогласие всех бояр. Царь станет крестьянином, его личные средства уйдут в казну, затем выборы.</p>
            <button class="wide danger" data-act="startOverthrow">Начать процедуру свержения</button>
          </div>`
        : ''
  }

  <div class="card">
    <div class="card-title"><h3>📜 Указы</h3><span class="tiny muted">указ отклоняется, если против больше половины бояр</span></div>
    ${
      decrees.length
        ? `<div class="list">${decrees
            .map((d) => {
              const my = d.votes[me.id];
              const statusBadge = {
                voting: '<span class="badge">голосование</span>',
                passed: '<span class="badge green">принят</span>',
                rejected: '<span class="badge red">отклонён</span>',
                cancelled: '<span class="badge off">отменён</span>',
              }[d.status];
              return `<div class="item ${d.status === 'voting' ? 'hl' : ''}">
                <div class="spread"><span><b>${C.esc(d.title)}</b></span>${statusBadge}</div>
                ${d.text ? `<div class="small">${C.esc(d.text)}</div>` : ''}
                ${d.changesText ? `<div class="tiny" style="color:var(--gold2)">${C.esc(d.changesText)}</div>` : ''}
                <div class="tiny muted mt">${d.voters
                  .map((v) => `${C.esc(v.name)}: ${v.vote === 'for' ? '✔' : v.vote === 'against' ? '✘' : '…'}`)
                  .join(' · ') || 'бояр нет — указ вступает в силу сразу'}</div>
                ${
                  d.status === 'voting' && me.role === 'boyar'
                    ? `<div class="row mt"><button class="sm ${my === 'for' ? 'good' : 'ghost'} grow" data-act="voteDecree" data-id="${d.id}" data-v="for">За</button>
                       <button class="sm ${my === 'against' ? 'danger' : 'ghost'} grow" data-act="voteDecree" data-id="${d.id}" data-v="against">Против</button></div>`
                    : ''
                }
                ${
                  d.status === 'voting' && me.role === 'tsar'
                    ? `<button class="sm ghost mt" data-act="closeDecreeVoting" data-id="${d.id}">Закрыть голосование</button>`
                    : ''
                }
              </div>`;
            })
            .join('')}</div>`
        : '<p class="small muted mb0">Указов пока нет.</p>'
    }
  </div>

  ${
    me.role === 'merchant' && S.market.rates
      ? `<div class="card">
          <div class="card-title"><h3>🏪 Рынок (видно только вам)</h3></div>
          <div class="scroll-x"><table>
            <tr><td>Курс культур</td><td class="mono">${C.CROPS.map((c) => `${C.CROP_ICONS[c]}${S.market.rates[c]}`).join(' ')}</td></tr>
            <tr><td>Квоты (осталось)</td><td class="mono">${C.CROPS.map((c) => `${C.CROP_ICONS[c]}${S.market.quotaLeft[c]}`).join(' ')}</td></tr>
          </table></div>
        </div>`
      : ''
  }
  ${feedCard(14)}`;
}

/* --------------------------------------------------- вкладка «Правила» */

/** Правила для конкретной роли: цель, что можно, когда. */
function roleRules() {
  const cfg = S.config;
  const travel = (cfg.travelSeasons || []).map((s) => C.SEASON_LABELS[s]).join(' и ');
  const marketOpen = (cfg.marketOpenSeasons || []).map((s) => C.SEASON_LABELS[s]).join(' и ');

  const common = {
    goal: 'Собрать как можно больше <b>личных монет</b> к концу игры. В зачёт идут только монеты — культуры, участки и лодка не считаются.',
    can: [
      'Обмениваться с любым игроком через вкладку «Обмен»: выберите игрока, укажите что отдаёте и что просите. Если ничего не просите взамен — передача пройдёт сразу.',
      'Пока купец находится на Рынке, обмениваться с ним могут только купцы, которые тоже на Рынке.',
    ],
    when: [
      ['🌱 Весна', 'крестьяне сажают культуры; Рынок принимает культуры'],
      ['☀️ Лето', 'время сделок и политики; Рынок принимает культуры'],
      ['🍂 Осень', `урожай собирается сам (1 → ${cfg.harvestYield}); феодалы и царь собирают налог; море открыто; Рынок закрыт`],
      ['❄️ Зима', 'море открыто; Рынок закрыт; торговля на материке'],
    ],
  };

  const byRole = {
    peasant: {
      title: 'Вы возделываете землю — единственный, кто это может',
      can: [
        `<b>Сажать культуры</b> Весной: 1 культура на 1 участок. Осенью каждая посадка даёт ${cfg.harvestYield} культуры.`,
        `<b>Выкупиться</b> у феодала за ${cfg.ransomPrice} монет и стать вольным. Внимание: <b>все ваши участки останутся феодалу</b>.`,
        'Перейти к другому феодалу — нужны согласия обоих феодалов и подтверждение боярина.',
        'Вольным: попросить покровительства у феодала.',
        `<b>Купить лодку</b> у боярина за ${cfg.boatPrice} монет и стать купцом. Обратно в крестьяне вернуться нельзя, участки уйдут феодалу или царю по вашему выбору.`,
      ],
      pay: `Если вы принадлежите феодалу, он забирает налог — не больше ${cfg.feudalTaxCropsPerYear} культур и ${cfg.feudalTaxMoneyPerYear} монет за год.${
        cfg.freePeasantTaxEnabled ? ` Вольные платят государству: ${cfg.freeTaxCropsPerYear} культур и ${cfg.freeTaxMoneyPerYear} монет за год (собирают бояре).` : ''
      }`,
      cant: ['Сажать без свободного участка и вне Весны.', 'Иметь лодку и остаться крестьянином.'],
    },
    feudal: {
      title: 'Вы кормитесь налогом со своих крестьян',
      can: [
        `<b>Собирать налог</b> со своих крестьян: не больше ${cfg.feudalTaxCropsPerYear} культур и ${cfg.feudalTaxMoneyPerYear} монет с каждого за год, не чаще раза в сезон. Списание автоматическое.`,
        'Брать вольных крестьян под покровительство (по их согласию) и подтверждать уход своих крестьян.',
        'Хранить участки и передавать их крестьянам — только крестьянин может их возделывать.',
        'Быть назначенным боярином или избранным царём.',
      ],
      pay: `Царь собирает налог с вас: до ${cfg.tsarTaxCropsPerYear} культур и ${cfg.tsarTaxMoneyPerYear} монет за год.`,
      cant: ['Возделывать землю.', 'Иметь лодку.'],
    },
    merchant: {
      title: 'Вы единственный источник монет в игре',
      can: [
        `<b>Отплыть на Рынок или вернуться</b> — только когда открыто море: ${travel}.`,
        `<b>Продавать культуры системе</b> — только находясь на Рынке и только когда Рынок принимает: ${marketOpen}.`,
        '<b>Курс и квоты</b> вы видите только когда вы на Рынке и Рынок открыт. Чтобы узнать курс — отплывите и дождитесь открытия Рынка, оставаясь там.',
        'Торговать с другими игроками в любой сезон; на Рынке — только с купцами, которые тоже на Рынке.',
      ],
      pay: 'Налогов не платите.',
      cant: ['Владеть землёй.', 'Покупать что-либо у системы.', 'Вернуться в крестьяне.'],
    },
    boyar: {
      title: 'Вы торгуете лодками и держите царя в руках',
      can: [
        `<b>Продавать лодки</b> крестьянам за ${cfg.boatPrice} монет — доход идёт лично вам, запас лодок бесконечен.`,
        'Подтверждать переход крестьянина от одного феодала к другому.',
        'Голосовать по указам царя. Указ отклоняется, только если против <b>строго больше половины</b> бояр (при равенстве голосов указ принят).',
        '<b>Свергать царя</b> — нужно единогласие всех бояр. После свержения проходят выборы, а участники свержения защищены от разжалования.',
        'Жаловаться царю на нарушителей.',
        cfg.freePeasantTaxEnabled ? 'Собирать налог с вольных крестьян в казну (указ введён).' : 'Собирать налог с вольных крестьян — если царь введёт такой указ.',
      ],
      pay: 'Налогов не платите.',
      cant: ['Владеть землёй.', 'Быть купцом или крестьянином (только через разжалование).'],
    },
    tsar: {
      title: 'Вы правите государством и распоряжаетесь казной',
      can: [
        `<b>Собирать налог с феодалов</b>: до ${cfg.tsarTaxCropsPerYear} культур и ${cfg.tsarTaxMoneyPerYear} монет с каждого за год, не чаще раза в сезон.`,
        'Распоряжаться казной: выдавать монеты и культуры, вносить свои личные монеты.',
        'Назначать феодалов и бояр, разжаловать их.',
        `<b>Разжаловать боярина можно не чаще ${cfg.boyarDismissPerSeason} раза в сезон.</b> Бояре, свергавшие царя, защищены от разжалования.`,
        'Издавать указы: менять цены и лимиты налогов, вводить персональные санкции. Бояре голосуют.',
        'Раздавать участки из государственного фонда — возделывать их смогут только крестьяне.',
      ],
      pay: 'Налогов не платите, но бояре могут вас свергнуть — тогда личные монеты и культуры уйдут в казну, а вы станете крестьянином.',
      cant: ['Возделывать землю.', 'Иметь лодку.', 'Видеть курс Рынка — его знают только купцы на Рынке.'],
    },
  };

  return { common, role: byRole[me.role] || null };
}

function renderRulesTab() {
  const { common, role } = roleRules();
  const bullets = (arr) => `<ul style="padding-left:20px;margin:0">${arr.filter(Boolean).map((x) => `<li class="small" style="margin-bottom:5px">${x}</li>`).join('')}</ul>`;

  return `<div class="card">
      <div class="card-title"><h2 style="margin:0">${C.ROLE_ICONS[me.role] || '📕'} ${C.ROLE_LABELS[me.role] || 'Без роли'}</h2>
        <span class="tiny muted">год ${S.time.year} из ${S.time.totalYears}</span></div>
      ${role ? `<p class="small" style="color:var(--gold2)">${role.title}</p>` : ''}
      <h3>🎯 Цель</h3>
      <p class="small mb0">${common.goal}</p>
    </div>

    ${
      role
        ? `<div class="card">
            <div class="card-title"><h3>✅ Что вы можете</h3></div>
            ${bullets(role.can)}
          </div>
          <div class="card">
            <div class="card-title"><h3>🚫 Что нельзя</h3></div>
            ${bullets(role.cant)}
            <hr>
            <h3>🧾 Налоги</h3>
            <p class="small mb0">${role.pay}</p>
          </div>`
        : '<div class="card"><p class="small muted mb0">Роль пока не назначена — дождитесь мастера.</p></div>'
    }

    <div class="card">
      <div class="card-title"><h3>📆 Когда что происходит</h3></div>
      <div class="scroll-x"><table>
        ${common.when
          .map(
            ([s, text]) => `<tr${C.SEASON_LABELS[season()] && s.includes(C.SEASON_LABELS[season()]) ? ' style="color:var(--gold2)"' : ''}>
              <td class="nowrap">${s}</td><td class="small">${text}</td></tr>`,
          )
          .join('')}
      </table></div>
      <p class="tiny muted mt mb0">Сезон длится ${Math.round(S.time.seasonDurationSec / 60)} мин, 4 сезона = 1 год, всего ${S.time.totalYears} лет.</p>
    </div>

    <div class="card">
      <div class="card-title"><h3>🤝 Общие правила обмена</h3></div>
      ${bullets(common.can)}
    </div>

    <div class="card">
      <div class="card-title"><h3>📊 Что известно всем</h3></div>
      <div class="scroll-x"><table>
        <tr><td>Цена лодки</td><td class="mono">${S.config.boatPrice}</td></tr>
        <tr><td>Цена выкупа крестьянина</td><td class="mono">${S.config.ransomPrice}</td></tr>
        <tr><td>Урожайность</td><td class="mono">1 → ${S.config.harvestYield}</td></tr>
        <tr><td>Лимит налога феодала (год)</td><td class="mono">${S.config.feudalTaxCropsPerYear} 🌾 + ${S.config.feudalTaxMoneyPerYear} 💰</td></tr>
        <tr><td>Лимит налога царя (год)</td><td class="mono">${S.config.tsarTaxCropsPerYear} 🌾 + ${S.config.tsarTaxMoneyPerYear} 💰</td></tr>
        <tr><td>Налог вольных крестьян</td><td class="mono">${S.config.freePeasantTaxEnabled ? `${S.config.freeTaxCropsPerYear} 🌾 + ${S.config.freeTaxMoneyPerYear} 💰` : 'не введён'}</td></tr>
        <tr><td>Курс культур на Рынке</td><td class="mono">${me.role === 'merchant' ? 'виден только на открытом Рынке' : 'знают только купцы'}</td></tr>
      </table></div>
    </div>`;
}

/* ------------------------------------------------------ обработчики */

function bindActions() {
  root.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = () => handleAct(el.dataset);
  });
}

function handleAct(d) {
  const act = d.act;
  switch (act) {
    case 'setName':
      send('setName', { name: C.strVal('lobbyName') });
      break;
    case 'clearNotifs':
      send('readNotifications');
      break;

    case 'plant':
      send('plant', { crop: C.strVal('plantCrop'), count: C.numVal('plantCount', 1) });
      break;
    case 'requestBoat':
      send('requestBoat', { boyarId: C.strVal('boatBoyar'), plotTarget: C.strVal('boatPlotTarget') });
      break;
    case 'ransom':
      send('ransom');
      break;
    case 'requestPatronage':
      send('requestPatronage', { feudalId: C.strVal('patronFeudal') });
      break;
    case 'requestLordChange':
      send('requestLordChange', { newLordId: C.strVal('newLord') });
      break;

    case 'offerPatronage':
      send('offerPatronage', { peasantId: C.strVal('patronPeasant') });
      break;
    case 'collectTax': {
      send('collectTax', { payerId: d.id, money: C.numVal('taxMoney', 0), crops: C.collectCrops('taxc') });
      ui.sel.tax = '';
      break;
    }

    case 'toggleMarket':
      send('setMarketPresence', { onMarket: !me.onMarket });
      break;
    case 'sell':
      send('sellToMarket', { crop: d.crop, qty: C.numVal(`sell_${d.crop}`, 0) });
      C.clearVal(`sell_${d.crop}`);
      break;

    case 'offerBoat':
      send('offerBoat', { peasantId: C.strVal('boatPeasant') });
      break;
    case 'complain':
      send('complain', { targetId: C.strVal('complainTarget'), text: C.strVal('complainText') });
      C.clearVal('complainText');
      break;
    case 'voteDecree':
      send('voteDecree', { decreeId: d.id, vote: d.v });
      break;
    case 'startOverthrow':
      if (confirm('Начать процедуру свержения царя?')) send('startOverthrow');
      break;
    case 'voteOverthrow':
      send('voteOverthrow', { value: d.v === '1' });
      break;

    case 'treasuryPay':
      send('treasuryPay', { toId: C.strVal('payTo'), amount: C.numVal('payMoney', 0), crops: C.collectCrops('payc') });
      break;
    case 'treasuryDeposit':
      send('treasuryDeposit', { amount: C.numVal('depositAmount', 0) });
      C.clearVal('depositAmount');
      break;
    case 'appoint':
      send('appoint', { playerId: C.strVal('appointTarget'), role: d.role });
      break;
    case 'dismiss':
      send('dismiss', { playerId: C.strVal('appointTarget'), toRole: d.role });
      break;
    case 'createDecree': {
      const changes = {};
      for (const k of [
        'boatPrice',
        'ransomPrice',
        'feudalTaxCropsPerYear',
        'feudalTaxMoneyPerYear',
        'tsarTaxCropsPerYear',
        'tsarTaxMoneyPerYear',
        'freeTaxCropsPerYear',
        'freeTaxMoneyPerYear',
      ]) {
        const v = C.strVal(`dec_${k}`);
        if (v !== '') changes[k] = Number(v);
      }
      const freeTax = C.boolVal('dec_freeTax');
      if (freeTax !== S.config.freePeasantTaxEnabled) changes.freePeasantTaxEnabled = freeTax;
      const targetId = C.strVal('sancTarget');
      send('createDecree', {
        title: C.strVal('decreeTitle'),
        text: C.strVal('decreeText'),
        changes,
        sanction: targetId
          ? {
              targetId,
              noBoat: C.boolVal('sanc_noBoat'),
              noTrade: C.boolVal('sanc_noTrade'),
              noFarm: C.boolVal('sanc_noFarm'),
            }
          : null,
      });
      break;
    }
    case 'closeDecreeVoting':
      send('closeDecreeVoting', { decreeId: d.id });
      break;
    case 'resolveComplaint':
      send('resolveComplaint', { complaintId: d.id });
      break;
    case 'voteElection':
      send('voteElection', { candidateId: d.id });
      break;

    case 'tradeOffer': {
      send('tradeOffer', {
        toId: d.id,
        give: { money: C.numVal('ogMoney', 0), crops: C.collectCrops('ogc'), plots: pickPlots(C.numVal('ogPlots', 0)) },
        want: { money: C.numVal('owMoney', 0), crops: C.collectCrops('owc'), plotCount: C.numVal('owPlots', 0) },
      });
      break;
    }
    case 'respond':
      send('respondRequest', { requestId: d.id, approve: d.ok === '1' });
      break;
    case 'cancelRequest':
      send('cancelRequest', { requestId: d.id });
      break;
    default:
      C.toast(`Неизвестное действие: ${act}`, 'error');
  }
}

renderSplash('Подключение…');
