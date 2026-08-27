/* Общие утилиты для интерфейсов игрока и мастера. */

export const CROPS = ['carrot', 'potato', 'beet', 'pea'];

export const CROP_LABELS = {
  carrot: 'Морковь',
  potato: 'Картошка',
  beet: 'Свёкла',
  pea: 'Горох',
};

export const CROP_ICONS = {
  carrot: '🥕',
  potato: '🥔',
  beet: '🟣',
  pea: '🟢',
};

export const ROLE_LABELS = {
  tsar: 'Царь',
  boyar: 'Боярин',
  feudal: 'Феодал',
  merchant: 'Купец',
  peasant: 'Крестьянин',
};

export const ROLE_ICONS = {
  tsar: '👑',
  boyar: '🎩',
  feudal: '🛡️',
  merchant: '⛵',
  peasant: '🌾',
};

export const SEASON_LABELS = {
  spring: 'Весна',
  summer: 'Лето',
  autumn: 'Осень',
  winter: 'Зима',
};

export const SEASON_ICONS = {
  spring: '🌱',
  summer: '☀️',
  autumn: '🍂',
  winter: '❄️',
};

export const ROLES = ['tsar', 'boyar', 'feudal', 'merchant', 'peasant'];

export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtTimeOfDay(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function cropsText(crops, { zero = false } = {}) {
  const parts = [];
  for (const c of CROPS) {
    const n = (crops && crops[c]) || 0;
    if (!n && !zero) continue;
    parts.push(`${CROP_ICONS[c]} ${n}`);
  }
  return parts.length ? parts.join('  ') : '—';
}

export function bundleText(items) {
  if (!items) return '—';
  const parts = [];
  if (items.money) parts.push(`💰 ${items.money}`);
  for (const c of CROPS) if (items.crops && items.crops[c]) parts.push(`${CROP_ICONS[c]} ${items.crops[c]}`);
  if (items.plots && items.plots.length) parts.push(`🟩 ${items.plots.length}`);
  return parts.length ? parts.join('  ') : '—';
}

export function roleBadge(role, extra = '') {
  if (!role) return `<span class="badge off">без роли</span>`;
  return `<span class="badge ${role}">${ROLE_ICONS[role]} ${ROLE_LABELS[role]}${extra}</span>`;
}

/* ------------------------------------------------------------- уведомления */

let toastWrap = null;
export function toast(message, kind = '') {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, kind === 'error' ? 4200 : 2400);
}

/* ------------------------------------------------------------- соединение */

export function connect(handlers) {
  let ws = null;
  let closedBanner = null;
  let retry = 0;
  let queue = [];

  function setBanner(text) {
    if (text) {
      if (!closedBanner) {
        closedBanner = document.createElement('div');
        closedBanner.className = 'conn';
        document.body.appendChild(closedBanner);
      }
      closedBanner.textContent = text;
    } else if (closedBanner) {
      closedBanner.remove();
      closedBanner = null;
    }
  }

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      setBanner(null);
      const q = queue;
      queue = [];
      for (const m of q) ws.send(JSON.stringify(m));
      if (handlers.onOpen) handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (handlers.onMessage) handlers.onMessage(msg);
    };
    ws.onclose = () => {
      setBanner('Нет связи с сервером — переподключение…');
      retry++;
      setTimeout(open, Math.min(4000, 400 * retry));
    };
    ws.onerror = () => {};
  }

  open();

  return {
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      else queue.push(obj);
    },
    get ready() {
      return ws && ws.readyState === WebSocket.OPEN;
    },
  };
}

/* --------------------------------------------------- рендер с сохранением фокуса */

/**
 * Перерисовывает контейнер, сохраняя фокус, значение и позицию курсора
 * в активном поле (важно, чтобы ввод не сбрасывался при обновлении состояния).
 */
export function renderInto(container, html) {
  const active = document.activeElement;
  const keep =
    active && container.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
      ? {
          id: active.id,
          value: active.value,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  const scroll = window.scrollY;
  container.innerHTML = html;
  if (keep && keep.id) {
    const el = container.querySelector(`#${CSS.escape(keep.id)}`);
    if (el) {
      if (el.tagName !== 'SELECT') el.value = keep.value;
      el.focus({ preventScroll: true });
      try {
        if (el.setSelectionRange && keep.start !== null) el.setSelectionRange(keep.start, keep.end);
      } catch (e) {
        /* number inputs могут не поддерживать */
      }
      window.scrollTo({ top: scroll });
    }
  }
}

/** Читает значение поля по id, приводя к целому неотрицательному числу. */
export function numVal(id, def = 0) {
  const el = document.getElementById(id);
  if (!el) return def;
  const n = Math.floor(Number(el.value));
  return Number.isFinite(n) ? n : def;
}

export function strVal(id, def = '') {
  const el = document.getElementById(id);
  return el ? el.value : def;
}

export function boolVal(id) {
  const el = document.getElementById(id);
  return el ? !!el.checked : false;
}

export function clearVal(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = false;
    else el.value = '';
  }
}

/** Собирает набор культур из полей с префиксом. */
export function collectCrops(prefix) {
  const crops = {};
  for (const c of CROPS) crops[c] = numVal(`${prefix}_${c}`, 0);
  return crops;
}

export function cropInputs(prefix, values = null, { small = false } = {}) {
  return `<div class="grid g4">${CROPS.map(
    (c) => `<div><label>${CROP_ICONS[c]} ${CROP_LABELS[c]}</label>
      <input type="number" min="0" step="1" id="${prefix}_${c}" ${small ? 'class="sm"' : ''}
        value="${values ? (values[c] ?? '') : ''}" placeholder="0" inputmode="numeric"></div>`,
  ).join('')}</div>`;
}
