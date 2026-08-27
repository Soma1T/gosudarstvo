'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_FILE = path.join(DATA_DIR, 'save.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return null;
    const raw = fs.readFileSync(SAVE_FILE, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[store] не удалось прочитать сохранение:', e.message);
    return null;
  }
}

let timer = null;
let pending = null;

function saveNow(state) {
  try {
    ensureDir();
    fs.writeFileSync(SAVE_FILE, JSON.stringify(state, null, 1), 'utf8');
  } catch (e) {
    console.error('[store] не удалось сохранить:', e.message);
  }
}

function saveDebounced(state, delay = 1500) {
  pending = state;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (pending) saveNow(pending);
    pending = null;
  }, delay);
}

function backup(state) {
  try {
    ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(DATA_DIR, `backup-${stamp}.json`), JSON.stringify(state, null, 1), 'utf8');
    return true;
  } catch (e) {
    console.error('[store] бэкап не удался:', e.message);
    return false;
  }
}

module.exports = { load, saveNow, saveDebounced, backup, SAVE_FILE, DATA_DIR };
