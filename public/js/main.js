import {
  BLOCK,
  BLOCK_TYPES,
  CONFIG,
  EFFECTS,
  SKILLS,
  SKILL_ORDER,
  STATUS_DEFS,
  isGoalRow,
} from '/shared/config.js';
import { GameAudio } from './audio.js';
import { effectIconSvg } from './icons.js';
import { GameRenderer } from './renderer.js';

const SESSION_KEY = 'd2f.session.v1';
const NAME_KEY = 'd2f.name.v1';

const DIRECTION_KEYS = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

const SKILL_KEYS = {
  KeyQ: 'build',
  KeyE: 'blast',
  KeyR: 'overdrive',
  KeyF: 'cryo',
  Digit1: 'build',
  Digit2: 'blast',
  Digit3: 'overdrive',
  Digit4: 'cryo',
};

const TARGETED_SKILLS = new Set(['build', 'blast', 'cryo']);

const SKILL_ICONS = {
  build: effectIconSvg('build', 'skill-glyph'),
  blast: effectIconSvg('blast', 'skill-glyph'),
  overdrive: effectIconSvg('overdrive', 'skill-glyph'),
  cryo: effectIconSvg('cryo', 'skill-glyph'),
};

const $ = (id) => document.getElementById(id);

function readStoredName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

function storeName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Ignore storage errors in privacy modes.
  }
}

const nameInput = $('name-input');
const codeInput = $('code-input');
const createBtn = $('create-btn');
const joinBtn = $('join-btn');
const menuMessage = $('menu-message');
const connectionStatus = $('connection-status');
const netBanner = $('net-banner');
const netBannerText = $('net-banner-text');

const roomCodeEl = $('room-code');
const copyCodeBtn = $('copy-code');
const lobbyMessage = $('lobby-message');
const leaveLobbyBtn = $('leave-lobby');
const slotEls = [$('slot-0'), $('slot-1')];

const timerEl = $('timer');
const statusLine = $('status-line');
const raceMarkerEls = [$('race-marker-0'), $('race-marker-1')];
const raceFillEls = [document.querySelector('.race-fill-one'), document.querySelector('.race-fill-two')];
const skillsEl = $('skills');
const countdownEl = $('countdown');
const offlineBanner = $('offline-banner');
const seamSizeEl = $('seam-size');
const toastsEl = $('toasts');
const muteBtn = $('mute-btn');
const canvas = $('game-canvas');
const stageEl = $('stage');
const flashEl = $('screen-flash');
const cheatBadgeEl = $('cheat-badge');
const fieldLogEl = $('field-log');
const statusTipEl = $('status-tip');
const examOverlay = $('exam-overlay');
const examTimerEl = $('exam-timer');
const examQuestionsEl = $('exam-questions');
const examSubmitBtn = $('exam-submit');
const devSidebar = $('dev-sidebar');
const devCloseBtn = $('dev-close');
const devEffectsEl = $('dev-effects');
const devTargetBtns = Array.from(document.querySelectorAll('.dev-target'));

const lockdownBadgeEl = $('lockdown-badge');
const resultOverlay = $('result-overlay');
const resultKicker = $('result-kicker');
const resultTitle = $('result-title');
const resultSubtitle = $('result-subtitle');
const resultStats = $('result-stats');
const rematchBtn = $('rematch-btn');
const leaveResultBtn = $('leave-result');
const rematchNote = $('rematch-note');

const screens = {
  menu: $('screen-menu'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
};

const playerCards = [0, 1].map((index) => {
  const root = $(`player-card-${index}`);
  return {
    root,
    name: root.querySelector('.player-card-name'),
    progress: root.querySelector('[data-progress]'),
    progressFill: root.querySelector('[data-progress-fill]'),
    energy: root.querySelector('[data-energy]'),
    energyFill: root.querySelector('[data-energy-fill]'),
    buffs: root.querySelector('[data-buffs]'),
  };
});

const audio = new GameAudio();
const renderer = new GameRenderer(canvas);

const state = {
  screen: 'menu',
  code: null,
  token: null,
  you: null,
  name: '',
  session: loadSession(),
  connected: false,
  needsResume: false,
  resuming: false,
  leaving: false,
  authBusy: false,
  roomPlayers: [null, null],
  players: [null, null],
  rematchReady: [false, false],
  map: null,
  snapshot: null,
  seq: -1,
  phase: 'lobby',
  result: null,
  awaitingRematch: false,
  wasCountdown: false,
  countdownValue: null,
  countdownTimer: null,
  pressedKeys: [],
  sentDir: null,
  skillButtons: new Map(),
  lastBreakSoundAt: 0,
  cheat: false,
  cheatPresses: [],
  hijackActive: false,
  lockdownActive: false,
  examId: null,
  examAnswers: [],
  submittedExamId: null,
  devOpen: false,
  devTarget: 'self',
  devPresses: [],
  targeting: null,
  targetingHover: null,
  targetingCells: [],
  targetingValid: false,
  targetingLegalCells: [],
  buildDragging: false,
  targetingPointerId: null,
};

state.name = readStoredName();
nameInput.value = state.name;
state.needsResume = Boolean(state.session);

renderer.setYou(0);

/* ── Small UI helpers ───────────────────────────────────────────────── */

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.code !== 'string' || typeof parsed.token !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveSession() {
  if (!state.code || !state.token) return;
  state.session = {
    code: state.code,
    token: state.token,
    you: state.you,
    name: state.name,
  };
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  } catch {
    // Session storage can be unavailable in privacy modes.
  }
}

function clearSession() {
  state.session = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function updateSessionIdentity() {
  if (state.session) {
    state.session.you = state.you;
    state.session.name = state.name;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    } catch {
      // Ignore.
    }
  }
}

function showMenuMessage(message, tone = 'error') {
  menuMessage.textContent = message || '';
  menuMessage.classList.toggle('is-success', tone === 'success');
  menuMessage.classList.toggle('is-info', tone === 'info');
}

function showScreen(name) {
  state.screen = name;
  for (const [key, element] of Object.entries(screens)) {
    element.classList.toggle('hidden', key !== name);
  }
  updateCheatBadge();
  if (name === 'game') {
    requestAnimationFrame(() => renderer.measure());
  }
}

function updateConnectionStatus() {
  const label = state.resuming ? 'Resuming…' : state.connected ? 'Online' : 'Offline';
  connectionStatus.textContent = label;
  connectionStatus.classList.toggle('is-offline', !state.connected);
  muteBtn.classList.toggle('is-muted', audio.muted);
  muteBtn.setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  if (state.connected) {
    if (state.resuming) {
      netBannerText.textContent = 'Restoring your match…';
      netBanner.classList.remove('hidden');
    } else {
      netBanner.classList.add('hidden');
    }
  } else {
    netBannerText.textContent = state.session ? 'Connection lost — reconnecting…' : 'Connecting to the mine…';
    netBanner.classList.remove('hidden');
  }
}

function flashScreen() {
  flashEl.classList.remove('is-active');
  // Force the animation to restart.
  void flashEl.offsetWidth;
  flashEl.classList.add('is-active');
}

function addToast(text, tone = 'gold', timeout = 3800) {
  if (!text) return;
  const node = document.createElement('div');
  node.className = `toast is-${tone}`;
  node.textContent = text;
  toastsEl.append(node);
  while (toastsEl.children.length > 4) toastsEl.firstElementChild.remove();
  window.setTimeout(() => {
    node.classList.add('is-out');
    window.setTimeout(() => node.remove(), 300);
  }, timeout);
}

/** Map-wide notices live in the blank strip above the seam. */
function addFieldLog(text, tone = 'info') {
  if (!fieldLogEl || !text) return;
  const node = document.createElement('div');
  node.className = `field-note is-${tone}`;
  node.textContent = text;
  fieldLogEl.append(node);
  while (fieldLogEl.children.length > 3) fieldLogEl.firstElementChild.remove();
  window.setTimeout(() => {
    node.classList.add('is-out');
    window.setTimeout(() => node.remove(), 280);
  }, 3600);
}

/** Miner-specific events float above that miner's head. */
function notifyPlayer(index, text, tone = 'info') {
  if (!Number.isInteger(index) || !text) return;
  renderer.addPlayerText(index, text, tone);
}

/* ── Hidden cheat mode (triple-tap C) ───────────────────────────────── */

const CHEAT_TRIPLE_WINDOW_MS = 700;

function updateCheatBadge() {
  if (!cheatBadgeEl) return;
  cheatBadgeEl.classList.toggle('hidden', !(state.cheat && state.screen === 'game'));
}

function handleCheatKey() {
  if (state.screen !== 'game' || state.phase !== 'playing' || state.result) return;
  // While the mode is on, a single C press turns it straight back off.
  if (state.cheat) {
    state.cheatPresses = [];
    requestCheat(false);
    return;
  }
  const now = performance.now();
  state.cheatPresses = state.cheatPresses.filter((at) => now - at <= CHEAT_TRIPLE_WINDOW_MS);
  state.cheatPresses.push(now);
  if (state.cheatPresses.length >= 3) {
    state.cheatPresses = [];
    requestCheat(true);
  }
}

async function requestCheat(enabled) {
  if (!state.connected || !socket) return;
  const result = await emitAck('game:cheat', { enabled }, 2500);
  if (!result.ok) {
    addToast(result.message || 'Cheat mode failed.', 'danger', 2200);
  }
}

/* ── Developer menu (triple-tap ]) ──────────────────────────────────── */

const DEV_TRIPLE_WINDOW_MS = 700;
const DEV_GROUPS = [
  ['buff', 'Buffs'],
  ['debuff', 'Debuffs'],
  ['tradeoff', 'Tradeoffs'],
];

function setDevMenu(open) {
  state.devOpen = Boolean(open);
  if (devSidebar) devSidebar.classList.toggle('hidden', !state.devOpen);
}

function handleDevKey() {
  if (state.screen !== 'game') return;
  const now = performance.now();
  state.devPresses = state.devPresses.filter((at) => now - at <= DEV_TRIPLE_WINDOW_MS);
  state.devPresses.push(now);
  if (state.devPresses.length >= 3) {
    state.devPresses = [];
    setDevMenu(!state.devOpen);
    audio.click();
  }
}

function buildDevMenu() {
  if (!devEffectsEl) return;
  devEffectsEl.replaceChildren();
  for (const [kind, label] of DEV_GROUPS) {
    const heading = document.createElement('p');
    heading.className = 'dev-group-label';
    heading.textContent = label;
    devEffectsEl.append(heading);
    for (const def of Object.values(EFFECTS)) {
      if (def.kind !== kind) continue;
      const row = document.createElement('div');
      row.className = `dev-effect is-${kind}`;
      const icon = document.createElement('span');
      icon.className = 'dev-effect-icon';
      icon.innerHTML = effectIconSvg(def.id, 'dev-glyph');
      const body = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'dev-effect-name';
      name.textContent = def.name;
      const description = document.createElement('p');
      description.className = 'dev-effect-desc';
      description.textContent = def.description || '';
      body.append(name, description);
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'dev-trigger';
      trigger.textContent = 'Trigger';
      trigger.addEventListener('click', () => triggerDevEffect(def.id));
      row.append(icon, body, trigger);
      devEffectsEl.append(row);
    }
  }
}

async function triggerDevEffect(effectId) {
  if (!state.connected || !socket) {
    addToast('Not connected.', 'danger', 1800);
    return;
  }
  const result = await emitAck(
    'dev:effect',
    { effect: effectId, target: state.devTarget },
    3000,
  );
  if (!result.ok) {
    addToast(result.message || 'Could not apply that effect.', 'danger', 2200);
  }
}

/* ── Skills ─────────────────────────────────────────────────────────── */

function buildSkillCards() {
  skillsEl.replaceChildren();
  state.skillButtons.clear();
  for (const skillId of SKILL_ORDER) {
    const skill = SKILLS[skillId];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-card is-disabled';
    button.dataset.skill = skillId;
    button.setAttribute('aria-disabled', 'true');
    button.title = `${skill.name} · ${skill.cost} energy · ${skill.cooldown}s cooldown — ${skill.blurb}`;
    button.innerHTML = `
      <span class="skill-key">${skill.key}</span>
      <span class="skill-icon">${SKILL_ICONS[skill.icon] || ''}</span>
      <span class="skill-name">${skill.name}</span>
      <span class="skill-cost">${skill.cost} energy</span>
      <span class="skill-cooldown"></span>
      <span class="skill-cd-label"></span>
    `;
    const cooldownEl = button.querySelector('.skill-cooldown');
    const labelEl = button.querySelector('.skill-cd-label');
    button.addEventListener('click', () => activateSkill(skillId));
    skillsEl.append(button);
    state.skillButtons.set(skillId, { button, cooldownEl, labelEl });
  }
}

function resetSkillCards() {
  for (const [skillId, meta] of state.skillButtons) {
    meta.button.classList.add('is-disabled');
    meta.button.classList.remove('is-broke', 'is-armed');
    meta.button.setAttribute('aria-disabled', 'true');
    meta.cooldownEl.style.height = '0%';
    meta.labelEl.textContent = '';
    const skill = SKILLS[skillId];
    meta.button.title = `${skill.name} · ${skill.cost} energy · ${skill.cooldown}s cooldown — ${skill.blurb}`;
  }
}

function updateSkillCards(snapshot) {
  const me = snapshot?.players?.[state.you];
  for (const [skillId, meta] of state.skillButtons) {
    const skill = SKILLS[skillId];
    const cooldown = me?.cooldowns?.[skillId] || 0;
    const broke = (me?.energy ?? 0) < skill.cost;
    const blocked =
      snapshot?.phase !== 'playing' || !state.connected || Boolean(state.result);
    const disabled = blocked || cooldown > 0.05 || broke;
    meta.button.classList.toggle('is-disabled', disabled);
    meta.button.classList.toggle('is-broke', broke);
    meta.button.classList.toggle('is-armed', state.targeting === skillId);
    meta.button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    const fraction = cooldown > 0 ? Math.min(1, cooldown / skill.cooldown) : 0;
    meta.cooldownEl.style.height = `${fraction * 100}%`;
    meta.labelEl.textContent = cooldown > 0.05 ? String(Math.ceil(cooldown)) : '';
  }
}

function activateSkill(skillId) {
  if (state.screen !== 'game' || state.phase !== 'playing' || state.result) return;
  if (!state.connected || !socket) {
    addToast('Connection lost — skill not sent.', 'danger');
    return;
  }
  const meta = state.skillButtons.get(skillId);
  const skill = SKILLS[skillId];
  if (!meta || !skill) return;
  if (meta.button.classList.contains('is-disabled')) {
    audio.error();
    return;
  }
  audio.unlock();

  if (!TARGETED_SKILLS.has(skillId)) {
    cancelTargeting();
    socket.emit('skill:cast', { skill: skillId });
    return;
  }

  if (state.targeting === skillId) {
    cancelTargeting();
    return;
  }

  state.targeting = skillId;
  state.targetingHover = null;
  state.targetingCells = [];
  state.targetingValid = false;
  state.targetingLegalCells = [];
  state.buildDragging = false;
  state.targetingPointerId = null;
  updateTargetingOverlay(null);
  updateSkillCards(state.snapshot);
  updateStatusLine(state.snapshot);
  audio.click();
}

function cancelTargeting() {
  const hadTargeting = Boolean(state.targeting);
  state.targeting = null;
  state.targetingHover = null;
  state.targetingCells = [];
  state.targetingValid = false;
  state.targetingLegalCells = [];
  state.buildDragging = false;
  state.targetingPointerId = null;
  stageEl.classList.remove('is-targeting');
  renderer.setTargeting(null);
  if (hadTargeting) {
    updateSkillCards(state.snapshot);
    updateStatusLine(state.snapshot);
  }
}

/* ── Mouse targeting ────────────────────────────────────────────────── */

const playerOverlapsCell = (player, col, row) => {
  if (!player) return false;
  const h = CONFIG.playerHalfSize;
  return (
    Math.abs(col + 0.5 - player.x) < 0.5 + h &&
    Math.abs(row + 0.5 - player.y) < 0.5 + h
  );
};

const distanceToCell = (player, col, row) =>
  Math.hypot(col + 0.5 - player.x, row + 0.5 - player.y);

function mapCellAt(col, row) {
  if (
    !renderer.cells ||
    !Number.isInteger(col) ||
    !Number.isInteger(row) ||
    col < 0 ||
    row < 0 ||
    col >= renderer.cols ||
    row >= renderer.rows
  ) {
    return null;
  }
  return renderer.cells[row * renderer.cols + col];
}

function isGoalTriggerTarget(col, row) {
  return (col === 0 || col === CONFIG.cols - 1) && isGoalRow(row);
}

function isBuildCellValid(col, row) {
  const players = state.snapshot?.players;
  if (!players) return false;
  if (isGoalTriggerTarget(col, row)) return false;
  if (mapCellAt(col, row) !== BLOCK.EMPTY) return false;
  const me = players[state.you];
  const opponent = players[1 - state.you];
  if (!opponent) return false;
  if (distanceToCell(opponent, col, row) > SKILLS.build.range + 1e-6) return false;
  if (playerOverlapsCell(me, col, row) || playerOverlapsCell(opponent, col, row)) {
    return false;
  }
  return true;
}

function blastBreakableCells(col, row) {
  const cells = [];
  const radius = SKILLS.blast.radius;
  for (let dc = -radius; dc <= radius; dc += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      const block = mapCellAt(col + dc, row + dr);
      if (block === null) continue;
      if (block !== BLOCK.EMPTY && block !== BLOCK.BEDROCK) {
        cells.push({ col: col + dc, row: row + dr });
      }
    }
  }
  return cells;
}

function targetingOrigin() {
  if (!state.targeting) return null;
  const skill = SKILLS[state.targeting];
  const players = state.snapshot?.players;
  if (!skill || !players) return null;
  const focus = skill.target === 'rival' ? 1 - state.you : state.you;
  const player = players[focus];
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return null;
  return { x: player.x, y: player.y };
}

function buildLegalCells() {
  if (state.targeting !== 'build') return [];
  const opponent = state.snapshot?.players?.[1 - state.you];
  if (!opponent) return [];
  const range = SKILLS.build.range;
  const cells = [];
  const minCol = Math.max(0, Math.floor(opponent.x - range));
  const maxCol = Math.min(renderer.cols - 1, Math.ceil(opponent.x + range));
  const minRow = Math.max(0, Math.floor(opponent.y - range));
  const maxRow = Math.min(renderer.rows - 1, Math.ceil(opponent.y + range));
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      if (isBuildCellValid(col, row)) cells.push({ col, row });
    }
  }
  return cells;
}

function updateTargetingOverlay(hover = state.targetingHover) {
  if (!state.targeting) {
    stageEl.classList.remove('is-targeting');
    renderer.setTargeting(null);
    return;
  }
  const skill = SKILLS[state.targeting];
  const players = state.snapshot?.players || [];
  const me = players[state.you];
  const opponent = players[1 - state.you];
  let valid = false;

  if (hover) {
    if (state.targeting === 'build') {
      valid = isBuildCellValid(hover.col, hover.row);
    } else if (state.targeting === 'blast') {
      valid =
        Boolean(me) &&
        distanceToCell(me, hover.col, hover.row) <= skill.range + 1e-6 &&
        blastBreakableCells(hover.col, hover.row).length > 0;
    } else if (state.targeting === 'cryo') {
      valid =
        Boolean(opponent) &&
        distanceToCell(opponent, hover.col, hover.row) <= skill.range + 1e-6;
    }
  }

  state.targetingHover = hover || null;
  state.targetingValid = valid;
  state.targetingLegalCells = buildLegalCells();
  stageEl.classList.add('is-targeting');
  renderer.setTargeting({
    skill: state.targeting,
    origin: targetingOrigin(),
    range: skill.range,
    hover: state.targetingHover,
    cells: state.targetingCells,
    legalCells: state.targetingLegalCells,
    valid,
  });
}

function addBuildCell(cell) {
  if (!cell || state.targeting !== 'build') return;
  if (state.targetingCells.length >= SKILLS.build.maxCells) return;
  if (
    state.targetingCells.some(
      (selected) => selected.col === cell.col && selected.row === cell.row,
    )
  ) {
    return;
  }
  if (!isBuildCellValid(cell.col, cell.row)) return;
  const last = state.targetingCells[state.targetingCells.length - 1];
  if (last && Math.abs(last.col - cell.col) + Math.abs(last.row - cell.row) !== 1) {
    return;
  }
  state.targetingCells.push({ col: cell.col, row: cell.row });
}

function onCanvasPointerDown(event) {
  if (!state.targeting) return;
  if (event.button === 2) {
    event.preventDefault();
    cancelTargeting();
    return;
  }
  if (event.button !== 0) return;
  if (state.phase !== 'playing' || state.result || !state.connected) return;
  const cell = renderer.screenToCell(event.clientX, event.clientY);
  if (!cell) return;
  event.preventDefault();
  audio.unlock();

  if (state.targeting === 'build') {
    state.buildDragging = true;
    state.targetingCells = [];
    state.targetingPointerId = event.pointerId;
    addBuildCell(cell);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a convenience; dragging still works without it.
    }
  }
  updateTargetingOverlay(cell);
}

function onCanvasPointerMove(event) {
  if (!state.targeting) return;
  const cell = renderer.screenToCell(event.clientX, event.clientY);
  if (!cell) {
    updateTargetingOverlay(null);
    return;
  }
  if (state.targeting === 'build' && state.buildDragging) {
    addBuildCell(cell);
  }
  updateTargetingOverlay(cell);
}

function onCanvasPointerUp(event) {
  if (!state.targeting || event.button !== 0) return;
  if (state.phase !== 'playing' || state.result || !state.connected) return;
  const cell = renderer.screenToCell(event.clientX, event.clientY);
  if (!cell) return;
  event.preventDefault();

  if (state.targeting === 'build') {
    if (!state.buildDragging) return;
    state.buildDragging = false;
    if (state.targetingPointerId !== null && canvas.hasPointerCapture?.(state.targetingPointerId)) {
      canvas.releasePointerCapture(state.targetingPointerId);
    }
    state.targetingPointerId = null;
    addBuildCell(cell);
    if (state.targetingCells.length === 0) {
      audio.error();
      addToast('No legal barricade cells selected.', 'danger', 2200);
      updateTargetingOverlay(cell);
      return;
    }
    const cells = state.targetingCells.map((selected) => ({
      col: selected.col,
      row: selected.row,
    }));
    socket.emit('skill:cast', { skill: 'build', cells });
    cancelTargeting();
    return;
  }

  updateTargetingOverlay(cell);
  if (!state.targetingValid) {
    audio.error();
    return;
  }
  socket.emit('skill:cast', {
    skill: state.targeting,
    target: { col: cell.col, row: cell.row },
  });
  cancelTargeting();
}

function onCanvasPointerCancel() {
  state.buildDragging = false;
  state.targetingPointerId = null;
  if (state.targeting) updateTargetingOverlay(null);
}

function onCanvasPointerLeave() {
  if (state.targeting && !state.buildDragging) {
    updateTargetingOverlay(null);
  }
}

/* ── Screen switching / session lifecycle ───────────────────────────── */

function setAuthBusy(busy) {
  state.authBusy = busy;
  createBtn.disabled = busy;
  joinBtn.disabled = busy;
  createBtn.textContent = busy ? 'Working…' : 'Create room';
  if (!busy) {
    createBtn.innerHTML = '<span>Create room</span><span class="btn-arrow" aria-hidden="true">→</span>';
  }
}

function enterRoom(result) {
  state.code = result.code;
  state.token = result.token;
  state.you = result.you;
  state.name = result.name;
  state.needsResume = false;
  state.leaving = false;
  nameInput.value = result.name;
  storeName(result.name);
  saveSession();
  if (!state.roomPlayers[state.you]) {
    state.roomPlayers[state.you] = {
      index: state.you,
      name: result.name,
      connected: true,
    };
  }
  showMenuMessage('');
  renderLobby();
  showScreen('lobby');
  updateConnectionStatus();
}

function renderLobby() {
  roomCodeEl.textContent = state.code || '-----';
  copyCodeBtn.disabled = !state.code;

  let joined = 0;
  let connected = 0;
  for (let index = 0; index < 2; index += 1) {
    const slot = slotEls[index];
    const player = state.roomPlayers[index];
    const isJoined = Boolean(player);
    const isYou = isJoined && index === state.you;
    const isOffline = isJoined && player.connected === false;
    slot.classList.toggle('is-joined', isJoined);
    slot.classList.toggle('is-you', isYou);
    slot.classList.toggle('is-offline', isOffline);
    slot.querySelector('.slot-name').textContent = isJoined ? player.name : 'Waiting…';
    slot.querySelector('.slot-status').textContent = isJoined
      ? isOffline
        ? 'Disconnected'
        : isYou
          ? 'You · ready'
          : 'In the shaft'
      : 'Empty seat';
    slot.querySelector('.slot-avatar').textContent = isJoined
      ? player.name.slice(0, 2).toUpperCase()
      : '?';
    if (isJoined) joined += 1;
    if (isJoined && player.connected) connected += 1;
  }

  if (joined < 2) {
    lobbyMessage.textContent = joined === 1 ? 'Awaiting a second miner…' : 'Awaiting miners…';
  } else if (connected < 2) {
    lobbyMessage.textContent = 'Waiting for disconnected miner to return…';
  } else {
    lobbyMessage.textContent = 'Both miners present — drills spinning up…';
  }
}

function clearCountdownTimer() {
  if (state.countdownTimer) {
    clearTimeout(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function hideCountdown() {
  clearCountdownTimer();
  countdownEl.classList.add('hidden');
  countdownEl.classList.remove('is-go', 'pop');
}

function resetGameView() {
  cancelTargeting();
  flushInput();
  renderer.stop();
  clearCountdownTimer();
  hideCountdown();
  offlineBanner.classList.add('hidden');
  resultOverlay.classList.add('hidden');
  resultOverlay.classList.remove('is-win', 'is-loss', 'is-draw');
  toastsEl.replaceChildren();
  if (fieldLogEl) fieldLogEl.replaceChildren();
  renderer.clearPlayerTexts();
  state.map = null;
  state.snapshot = null;
  state.seq = -1;
  state.phase = 'lobby';
  state.result = null;
  state.awaitingRematch = false;
  state.cheat = false;
  state.cheatPresses = [];
  state.hijackActive = false;
  state.lockdownActive = false;
  state.devPresses = [];
  setDevMenu(false);
  hideExam();
  updateCheatBadge();
  state.wasCountdown = false;
  state.countdownValue = null;
  state.rematchReady = [false, false];
  resetSkillCards();
}

function resetToMenu(message = '', tone = 'info') {
  resetGameView();
  flushInput();
  state.code = null;
  state.token = null;
  state.you = null;
  state.session = null;
  state.needsResume = false;
  state.resuming = false;
  state.leaving = false;
  state.roomPlayers = [null, null];
  state.players = [null, null];
  state.phase = 'menu';
  clearSession();
  showScreen('menu');
  if (message) showMenuMessage(message, tone);
  updateConnectionStatus();
}

async function leaveCurrentRoom() {
  if (!state.code) {
    resetToMenu();
    return;
  }
  state.leaving = true;
  flushInput();
  if (socket?.connected) {
    const result = await emitAck('room:leave', {}, 2500);
    if (!result.ok && result.error === 'timeout') {
      resetToMenu('Left the mine.', 'info');
      return;
    }
  }
  if (state.code) resetToMenu('You left the room.', 'info');
}

/* ── Lobby actions ──────────────────────────────────────────────────── */

function requestedName() {
  return nameInput.value.trim().slice(0, 16) || 'MINER';
}

async function createRoom() {
  if (state.authBusy) return;
  if (!socket?.connected) {
    showMenuMessage('Still connecting to the mine. Try again in a moment.', 'info');
    return;
  }
  const name = requestedName();
  setAuthBusy(true);
  showMenuMessage('Opening a new shaft…', 'info');
  const result = await emitAck('room:create', { name });
  setAuthBusy(false);
  if (!result.ok) {
    showMenuMessage(result.message || 'Could not create a room.', 'error');
    return;
  }
  enterRoom(result);
}

async function joinRoom() {
  if (state.authBusy) return;
  const code = codeInput.value.trim().replace(/\D/g, '');
  if (code.length !== CONFIG.roomCodeLength) {
    showMenuMessage(`Enter the full ${CONFIG.roomCodeLength}-digit room code.`, 'error');
    return;
  }
  if (!socket?.connected) {
    showMenuMessage('Still connecting to the mine. Try again in a moment.', 'info');
    return;
  }
  const name = requestedName();
  setAuthBusy(true);
  showMenuMessage('Finding that shaft…', 'info');
  const result = await emitAck('room:join', { code, name });
  setAuthBusy(false);
  if (!result.ok) {
    showMenuMessage(result.message || 'Could not join that room.', 'error');
    return;
  }
  enterRoom(result);
}

async function attemptResume() {
  if (!state.session || state.resuming) return;
  if (!socket?.connected) {
    state.needsResume = true;
    return;
  }
  state.resuming = true;
  state.needsResume = true;
  updateConnectionStatus();
  const { code, token } = state.session;
  const result = await emitAck('room:resume', { code, token }, 5000);
  state.resuming = false;
  if (!result.ok) {
    state.needsResume = false;
    state.session = null;
    clearSession();
    resetToMenu(
      result.error === 'not-found'
        ? 'That match is no longer available.'
        : result.message || 'Could not restore your match.',
      result.error === 'not-found' ? 'info' : 'error',
    );
    return;
  }
  state.code = result.code;
  state.token = result.token;
  state.you = result.you;
  state.name = result.name;
  state.needsResume = false;
  state.leaving = false;
  state.connected = true;
  updateSessionIdentity();
  updateConnectionStatus();
  updateSkillCards(state.snapshot);
}

/* ── Networking ─────────────────────────────────────────────────────── */

function emitAck(event, payload, timeout = 5000) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve({ ok: false, error: 'offline', message: 'Not connected to the mine.' });
      return;
    }
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) {
        resolve({ ok: false, error: 'timeout', message: 'The mine did not answer in time.' });
        return;
      }
      resolve(response || { ok: false, error: 'unknown', message: 'No response from the mine.' });
    });
  });
}

let socket = null;

function setupSocket() {
  if (!window.io) {
    showMenuMessage('Socket.IO failed to load. Restart the server and refresh.', 'error');
    updateConnectionStatus();
    return;
  }
  socket = window.io({
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 3500,
    timeout: 8000,
  });

  socket.on('connect', () => {
    state.connected = true;
    updateConnectionStatus();
    if (state.needsResume || (state.session && !state.code)) {
      attemptResume();
    } else {
      hideNetBannerWhenSettled();
    }
  });

  socket.on('disconnect', () => {
    state.connected = false;
    if (state.code && state.token) {
      state.needsResume = true;
      saveSession();
    }
    cancelTargeting();
    flushInput();
    updateConnectionStatus();
    updateSkillCards(state.snapshot);
  });

  socket.on('connect_error', () => {
    state.connected = false;
    updateConnectionStatus();
  });

  socket.on('room:update', onRoomUpdate);
  socket.on('room:closed', onRoomClosed);
  socket.on('game:init', onGameInit);
  socket.on('game:snapshot', onSnapshot);
  socket.on('game:fx', onFx);
  socket.on('game:over', onGameOver);
  socket.on('game:error', onGameError);

  socket.connect();
}

function hideNetBannerWhenSettled() {
  if (state.connected && !state.resuming) netBanner.classList.add('hidden');
}

function onRoomUpdate(payload) {
  if (!payload) return;
  state.code = payload.code || state.code;
  state.you = Number.isInteger(payload.you) ? payload.you : state.you;
  state.roomPlayers = Array.isArray(payload.players) ? payload.players : state.roomPlayers;
  state.rematchReady = Array.isArray(payload.rematchReady)
    ? payload.rematchReady
    : state.rematchReady;
  updateSessionIdentity();

  if (payload.phase === 'lobby' && !state.result) {
    renderLobby();
    if (!state.map) showScreen('lobby');
  } else if (state.screen === 'game') {
    updateOfflineBanner();
    updateRematchUi();
  }
}

function onRoomClosed(payload) {
  const reason = payload?.reason;
  const wasLeaving = state.leaving;
  state.leaving = false;
  let message = 'The room closed.';
  if (reason === 'left') {
    message = wasLeaving ? 'You left the room.' : 'Your rival left the mine.';
  } else if (reason === 'disconnected') {
    message = 'The room closed after a disconnect.';
  } else if (reason === 'abandoned') {
    message = 'The room closed because both miners left.';
  } else if (reason === 'server-shutdown') {
    message = 'The server closed the mine.';
  }
  resetToMenu(message, reason === 'left' && wasLeaving ? 'info' : 'error');
}

function onGameInit(payload) {
  if (!payload?.map) return;
  cancelTargeting();
  state.code = payload.code;
  state.you = payload.you;
  state.players = Array.isArray(payload.players) ? payload.players : state.players;
  state.map = payload.map;
  state.snapshot = null;
  state.seq = -1;
  state.phase = 'countdown';
  state.result = null;
  state.awaitingRematch = false;
  state.wasCountdown = false;
  state.countdownValue = null;
  state.pressedKeys = [];
  state.sentDir = null;
  state.rematchReady = [false, false];
  state.cheat = false;
  state.cheatPresses = [];
  state.hijackActive = false;
  state.lockdownActive = false;
  state.devPresses = [];
  setDevMenu(false);
  hideExam();
  updateSessionIdentity();

  hideCountdown();
  offlineBanner.classList.add('hidden');
  resultOverlay.classList.add('hidden');
  resultOverlay.classList.remove('is-win', 'is-loss', 'is-draw');
  toastsEl.replaceChildren();
  if (fieldLogEl) fieldLogEl.replaceChildren();
  renderer.clearPlayerTexts();
  rematchNote.textContent = '';
  rematchBtn.disabled = false;
  rematchBtn.textContent = 'Rematch';
  resetSkillCards();
  applyPlayerNames();

  showScreen('game');
  renderer.setYou(state.you);
  renderer.setMap(state.map);
  requestAnimationFrame(() => {
    renderer.measure();
    renderer.start();
  });
  updateHudEmpty();
  updateConnectionStatus();
  audio.unlock();
}

function onSnapshot(snapshot) {
  if (!snapshot || state.screen !== 'game') return;
  if (typeof snapshot.seq === 'number' && snapshot.seq <= state.seq) return;
  state.seq = snapshot.seq;
  state.snapshot = snapshot;
  state.phase = snapshot.phase;
  state.cheat = Boolean(snapshot.players?.[state.you]?.cheat);
  updateCheatBadge();
  const hijacked = (snapshot.players?.[state.you]?.buffs?.hijack ?? 0) > 0;
  if (state.hijackActive && !hijacked) {
    // The server ignored our inputs while Hijack was active; resend what we
    // are actually holding so movement does not stick to the locked direction.
    state.sentDir = null;
    syncDirection(true);
  }
  state.hijackActive = hijacked;
  const locked = (snapshot.lockdownMs ?? 0) > 0;
  if (state.lockdownActive && !locked) addFieldLog('GATES REOPENED', 'buff');
  state.lockdownActive = locked;
  if (snapshot.phase === 'finished') {
    flushInput();
    cancelTargeting();
  }
  renderer.updateSnapshot(snapshot);
  if (state.targeting) updateTargetingOverlay(state.targetingHover);
  updateHud(snapshot);
  updateExamUi(snapshot);
  updateSkillCards(snapshot);
  updateCountdown(snapshot);
  updateOfflineBanner();
  if (snapshot.phase === 'playing' && state.pressedKeys.length > 0) {
    // Keys held through the countdown should start moving immediately.
    syncDirection();
  }
}

function onFx(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  for (const event of events) {
    if (!event) continue;
    const own = event.player === state.you;
    switch (event.type) {
      case 'matchStart':
        audio.matchStart();
        flashScreen();
        addFieldLog('MINE OPEN — DRILL!', 'buff');
        break;
      case 'digStart':
        audio.digStart(own);
        break;
      case 'blockBreak': {
        if (event.method === 'blast') break;
        const now = performance.now();
        if (now - state.lastBreakSoundAt > 35) {
          state.lastBreakSoundAt = now;
          audio.blockBreak(own);
        }
        break;
      }
      case 'blocked':
        renderer.addBlocked(event);
        if (own) audio.blocked(true);
        break;
      case 'step':
        renderer.addStep(event);
        if (own) audio.step(true);
        break;
      case 'skill':
        handleSkillFx(event);
        break;
      case 'effect': {
        const target = Number.isInteger(event.target) ? event.target : event.player;
        const tone =
          event.kind === 'buff'
            ? 'buff'
            : event.kind === 'debuff'
              ? 'debuff'
              : event.kind === 'tradeoff'
                ? 'tradeoff'
                : 'info';
        const label = (event.name || EFFECTS[event.effect]?.name || 'EFFECT').toUpperCase();
        if (event.kind === 'terrain') {
          renderer.addLuckyBurst(event);
          audio.lucky(Boolean(event.good));
          notifyPlayer(event.player, label, event.good ? 'buff' : 'debuff');
        } else if (event.blocked) {
          notifyPlayer(target, `${label} RESISTED`, 'info');
          audio.error();
        } else {
          audio.lucky(event.kind === 'buff');
          notifyPlayer(target, label, tone);
          if (event.effect === 'lockdown') {
            addFieldLog('GATES SEALED — LOCKDOWN 8S', 'debuff');
          } else if (event.effect === 'exam') {
            addFieldLog('EXAM STARTED — 3 SUMS IN 10S', 'tradeoff');
          }
        }
        break;
      }
      case 'thawed':
        notifyPlayer(event.player, 'THAWED', 'cyan');
        break;
      case 'examStart':
        notifyPlayer(event.player, 'EXAM!', 'tradeoff');
        break;
      case 'examResult':
        notifyPlayer(
          event.player,
          event.passed ? 'EXAM PASSED · DRILL ×2' : 'EXAM FAILED · DRILL ×0.5',
          event.passed ? 'buff' : 'debuff',
        );
        addFieldLog(
          event.passed ? 'EXAM PASSED — DRILL ×2' : 'EXAM FAILED — DRILL ×0.5',
          event.passed ? 'buff' : 'debuff',
        );
        break;
      case 'cheat': {
        const rivalName = state.players[1 - state.you]?.name || 'The rival';
        addFieldLog(
          event.enabled
            ? event.player === state.you
              ? 'CHEAT MODE ON — INSTANT DRILL · BEDROCK BREAKS · RIVAL FROZEN'
              : `${rivalName.toUpperCase()} ENABLED CHEAT MODE — YOU ARE FROZEN`
            : event.player === state.you
              ? 'CHEAT MODE OFF'
              : `${rivalName.toUpperCase()} DISABLED CHEAT MODE`,
          event.enabled ? 'debuff' : 'cyan',
        );
        notifyPlayer(event.player, event.enabled ? 'CHEAT ON' : 'CHEAT OFF', 'gold');
        if (event.enabled) flashScreen();
        break;
      }
      case 'cryoBurst': {
        renderer.addCryoBurst(event);
        audio.cryoBurst(event.player === state.you, event.hit);
        const victim = 1 - event.player;
        if (event.hit) {
          notifyPlayer(victim, 'CHILLED', 'debuff');
        } else {
          notifyPlayer(victim, 'CRYO MISS', 'info');
        }
        break;
      }
      default:
        break;
    }
  }
}

function handleSkillFx(event) {
  const own = event.player === state.you;
  renderer.addSkillEffect(event);
  audio.skill(event.skill, own);
  if (event.skill === 'blast' && own) flashScreen();

  if (event.skill === 'build') {
    const count = event.cells?.length || 0;
    notifyPlayer(
      event.player,
      own ? `BUILD ×${count}` : `RIVAL WALL ×${count}`,
      own ? 'cyan' : 'debuff',
    );
  } else if (event.skill === 'blast') {
    notifyPlayer(
      event.player,
      own ? `BLAST ×${event.cells?.length || 0}` : 'RIVAL BLAST',
      own ? 'cyan' : 'debuff',
    );
  } else if (event.skill === 'overdrive') {
    notifyPlayer(event.player, own ? 'OVERDRIVE' : 'RIVAL OVERDRIVE', own ? 'buff' : 'debuff');
  } else if (event.skill === 'cryo') {
    notifyPlayer(event.player, own ? 'CRYO ARMED' : 'RIVAL CRYO', own ? 'cyan' : 'debuff');
  }
}

function onGameError(payload) {
  if (payload?.message) addToast(payload.message, 'danger', 2600);
  audio.error();
}

function onGameOver(result) {
  if (!result || state.result) return;
  showResult(result);
}

/* ── HUD ────────────────────────────────────────────────────────────── */

function applyPlayerNames() {
  for (let index = 0; index < 2; index += 1) {
    const player = state.players[index];
    const card = playerCards[index];
    if (!card) continue;
    card.name.textContent = player?.name || `MINER 0${index + 1}`;
    card.root.classList.toggle('is-you', index === state.you);
  }
}

function updateHudEmpty() {
  for (let index = 0; index < 2; index += 1) {
    const card = playerCards[index];
    card.progress.textContent = '0%';
    card.progressFill.style.width = '0%';
    card.energy.textContent = '0';
    card.energyFill.style.width = '0%';
    card.buffs.replaceChildren();
    card.root.classList.remove('is-offline');
  }
  if (raceMarkerEls[0]) raceMarkerEls[0].style.left = '0%';
  if (raceMarkerEls[1]) raceMarkerEls[1].style.left = '100%';
  if (raceFillEls[0]) raceFillEls[0].style.width = '0%';
  if (raceFillEls[1]) raceFillEls[1].style.width = '0%';
  timerEl.textContent = formatTime(CONFIG.matchSeconds * 1000);
  timerEl.classList.remove('is-urgent');
  statusLine.textContent = 'READY THE DRILLS';
  countdownEl.classList.add('hidden');
  if (lockdownBadgeEl) lockdownBadgeEl.classList.add('hidden');
}

const STATUS_CHIP_ORDER = [
  'overdrive',
  'cryo',
  'echo',
  'invert',
  'fog',
  'lag',
  'qte',
  'misfortune',
  'reject',
  'hijack',
  'balance',
  'mundane',
  'examPass',
  'examFail',
  'freeze',
  'luck',
  'exam',
];

function statusChip(id, value) {
  const def = STATUS_DEFS[id];
  if (!def) return null;
  const description = def.description || EFFECTS[id]?.description || '';
  const chip = document.createElement('span');
  chip.className = `buff-chip is-${def.kind}`;
  chip.dataset.tip = description ? `${def.name} — ${description}` : def.name;
  chip.title = chip.dataset.tip;
  const icon = document.createElement('span');
  icon.className = 'chip-icon';
  icon.innerHTML = effectIconSvg(id, 'chip-glyph');
  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = def.name;
  const text = document.createElement('span');
  text.className = 'chip-value';
  text.textContent = value;
  chip.append(icon, name, text);
  return chip;
}

function buildStatusChips(player) {
  const chips = [];
  const buffs = player.buffs || {};
  for (const id of STATUS_CHIP_ORDER) {
    if (id === 'luck') {
      if (player.luckCharges > 0) chips.push(statusChip('luck', `×${player.luckCharges}`));
      continue;
    }
    if (id === 'exam') {
      if (player.exam) {
        chips.push(statusChip('exam', `${Math.ceil((player.exam.remainingMs || 0) / 1000)}s`));
      }
      continue;
    }
    const remaining = buffs[id] || 0;
    if (remaining <= 0) continue;
    let value = `${remaining.toFixed(1)}s`;
    if (id === 'qte' && player.thaw) {
      value = `${remaining.toFixed(1)}s · ${player.thaw.taps}/${player.thaw.needed}`;
    }
    chips.push(statusChip(id, value));
  }
  return chips.filter(Boolean);
}

function setupStatusTooltip() {
  if (!statusTipEl) return;
  const hide = () => statusTipEl.classList.add('hidden');
  document.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest('.buff-chip[data-tip]');
    if (!chip) return;
    statusTipEl.textContent = chip.dataset.tip || '';
    statusTipEl.classList.remove('hidden');
    const rect = statusTipEl.getBoundingClientRect();
    const x = Math.min(window.innerWidth - rect.width - 10, event.clientX + 14);
    const y = Math.min(window.innerHeight - rect.height - 10, event.clientY + 14);
    statusTipEl.style.left = `${Math.max(10, x)}px`;
    statusTipEl.style.top = `${Math.max(10, y)}px`;
  });
  document.addEventListener('pointerout', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest('.buff-chip[data-tip]');
    if (!chip) return;
    if (event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return;
    hide();
  });
  window.addEventListener('blur', hide);
}

function updateExamSubmitState() {
  const ready =
    state.examId !== null &&
    state.examAnswers.length > 0 &&
    state.examAnswers.every((answer) => answer >= 0);
  examSubmitBtn.disabled = !ready;
  examSubmitBtn.textContent = ready ? 'Submit answers' : 'Pick one answer per sum';
}

function hideExam() {
  if (examOverlay) examOverlay.classList.add('hidden');
  state.examId = null;
  state.examAnswers = [];
  state.submittedExamId = null;
}

function renderExam(exam) {
  state.examId = exam.id;
  state.examAnswers = new Array(exam.questions.length).fill(-1);
  examQuestionsEl.replaceChildren();
  exam.questions.forEach((question, questionIndex) => {
    const block = document.createElement('div');
    block.className = 'exam-question';
    const label = document.createElement('p');
    label.className = 'exam-question-text';
    label.textContent = `${questionIndex + 1}. ${question.text}`;
    const options = document.createElement('div');
    options.className = 'exam-options';
    question.options.forEach((option, optionIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'exam-option';
      button.textContent = option;
      button.addEventListener('click', () => {
        state.examAnswers[questionIndex] = optionIndex;
        for (const node of options.children) {
          node.classList.toggle('is-picked', node === button);
        }
        updateExamSubmitState();
      });
      options.append(button);
    });
    block.append(label, options);
    examQuestionsEl.append(block);
  });
  updateExamSubmitState();
  examOverlay.classList.remove('hidden');
}

function updateExamUi(snapshot) {
  if (!examOverlay) return;
  const exam = snapshot.players?.[state.you]?.exam || null;
  if (!exam || snapshot.phase !== 'playing') {
    hideExam();
    return;
  }
  if (exam.id === state.submittedExamId) {
    // Waiting for the server to clear the exam; do not flash it back open.
    if (examOverlay) examOverlay.classList.add('hidden');
    return;
  }
  if (state.examId !== exam.id) renderExam(exam);
  examTimerEl.textContent = `${(exam.remainingMs / 1000).toFixed(1)}s`;
}

async function submitExamAnswers() {
  if (!state.examId) return;
  if (!state.examAnswers.every((answer) => answer >= 0)) return;
  const answers = state.examAnswers.slice();
  const examId = state.examId;
  state.submittedExamId = examId;
  const result = await emitAck('game:examAnswer', { answers }, 3000);
  if (!result.ok) {
    state.submittedExamId = null;
    addToast(result.message || 'Could not submit the exam.', 'danger', 2200);
    return;
  }
  hideExam();
}

function updateHud(snapshot) {
  const players = snapshot.players || [];
  for (let index = 0; index < 2; index += 1) {
    const player = players[index];
    const card = playerCards[index];
    if (!player || !card) continue;
    card.name.textContent = player.name || `MINER 0${index + 1}`;
    card.root.classList.toggle('is-you', index === state.you);
    card.root.classList.toggle('is-offline', player.connected === false);
    const progress = Math.round(Math.max(0, Math.min(1, player.progress || 0)) * 100);
    card.progress.textContent = `${progress}%`;
    card.progressFill.style.width = `${progress}%`;
    card.energy.textContent = String(Math.round(player.energy || 0));
    card.energyFill.style.width = `${Math.min(
      100,
      Math.max(0, ((player.energy || 0) / CONFIG.energy.max) * 100),
    )}%`;

    const chips = buildStatusChips(player);
    card.buffs.replaceChildren(...chips);
  }

  if (players[0] && raceMarkerEls[0]) {
    raceMarkerEls[0].style.left = `${players[0].progress * 100}%`;
    if (raceFillEls[0]) raceFillEls[0].style.width = `${players[0].progress * 100}%`;
  }
  if (players[1] && raceMarkerEls[1]) {
    raceMarkerEls[1].style.left = `${(1 - players[1].progress) * 100}%`;
    if (raceFillEls[1]) raceFillEls[1].style.width = `${players[1].progress * 100}%`;
  }

  timerEl.textContent = formatTime(snapshot.timeLeftMs);
  timerEl.classList.toggle(
    'is-urgent',
    snapshot.phase === 'playing' && snapshot.timeLeftMs <= 10_000,
  );

  const lockdownMs = snapshot.lockdownMs || 0;
  if (lockdownBadgeEl) {
    lockdownBadgeEl.classList.toggle('hidden', lockdownMs <= 0);
    if (lockdownMs > 0) {
      lockdownBadgeEl.textContent = `GATES SEALED · ${(lockdownMs / 1000).toFixed(1)}s`;
    }
  }

  updateStatusLine(snapshot);
  updateOfflineBanner();
}

function updateStatusLine(snapshot) {
  if (state.targeting) {
    if (state.targeting === 'build') {
      statusLine.textContent = `BUILD · DRAG UP TO ${SKILLS.build.maxCells} CELLS NEAR THE RIVAL · RIGHT-CLICK / ESC CANCELS`;
    } else if (state.targeting === 'blast') {
      statusLine.textContent = 'BLAST · CLICK A 3×3 AREA WITHIN 10 CELLS · RIGHT-CLICK / ESC CANCELS';
    } else if (state.targeting === 'cryo') {
      statusLine.textContent = 'CRYO · CLICK NEAR THE RIVAL FOR A DELAYED BURST · RIGHT-CLICK / ESC CANCELS';
    }
    return;
  }

  const players = snapshot?.players || [];
  const me = players[state.you];
  const opponent = players[1 - state.you];
  if (!snapshot || snapshot.phase === 'countdown') {
    statusLine.textContent = 'DRILLS LOCKED';
  } else if (snapshot.phase === 'finished') {
    statusLine.textContent = 'MATCH OVER';
  } else if (me?.buffs?.qte > 0) {
    statusLine.textContent = `FROZEN — MASH DIRECTION KEYS ${me.thaw?.taps ?? 0}/${me.thaw?.needed ?? 8}`;
  } else if (me?.buffs?.freeze > 0) {
    statusLine.textContent = 'FROZEN IN PLACE — CANNOT MOVE OR DRILL';
  } else if (me?.buffs?.hijack > 0) {
    statusLine.textContent = 'HIJACKED — DIRECTION LOCKED · DRILL ×3';
  } else if (me?.cheat) {
    statusLine.textContent = 'CHEAT MODE — INSTANT DRILL · BEDROCK BREAKS';
  } else if (opponent?.connected === false) {
    statusLine.textContent = 'RIVAL OFFLINE — MATCH CONTINUES';
  } else if (me?.mining) {
    const blockName = BLOCK_TYPES[me.mining.block]?.name || 'ROCK';
    statusLine.textContent = `DRILLING ${blockName.toUpperCase()} · ${Math.round(
      (me.mining.progress || 0) * 100,
    )}%`;
  } else if (me?.buffs?.overdrive > 0) {
    statusLine.textContent = 'OVERDRIVE — ×1.8 DRILL · ×1.25 MOVE';
  } else if (me?.buffs?.cryo > 0) {
    statusLine.textContent = 'CRYO LOCK — MOVEMENT AND DRILL SLOWED';
  } else if (me?.buffs?.invert > 0) {
    statusLine.textContent = 'CONTROLS INVERTED — DIRECTIONS ARE REVERSED';
  } else {
    statusLine.textContent = 'HOLD A DIRECTION TO MOVE · DRILLS AUTO-FIRE';
  }
}

function updateCountdown(snapshot) {
  if (snapshot.phase === 'countdown') {
    state.wasCountdown = true;
    const value = Math.max(1, Math.ceil(snapshot.countdownMs / 1000));
    if (state.countdownValue !== value) {
      state.countdownValue = value;
      clearCountdownTimer();
      countdownEl.textContent = String(value);
      countdownEl.classList.remove('hidden', 'is-go', 'pop');
      void countdownEl.offsetWidth;
      countdownEl.classList.add('pop');
      audio.countdown(value);
    }
  } else if (snapshot.phase === 'playing') {
    if (state.wasCountdown) {
      state.wasCountdown = false;
      clearCountdownTimer();
      countdownEl.textContent = 'MINE!';
      countdownEl.classList.remove('hidden', 'pop');
      countdownEl.classList.add('is-go');
      state.countdownTimer = window.setTimeout(() => {
        countdownEl.classList.add('hidden');
        countdownEl.classList.remove('is-go');
      }, 620);
    } else if (!countdownEl.classList.contains('hidden') && !countdownEl.classList.contains('is-go')) {
      countdownEl.classList.add('hidden');
    }
  } else if (snapshot.phase === 'finished') {
    hideCountdown();
  }
}

function updateOfflineBanner() {
  if (!state.snapshot || state.screen !== 'game' || state.result) {
    offlineBanner.classList.add('hidden');
    return;
  }
  const opponent = state.snapshot.players?.[1 - state.you];
  const opponentOffline =
    opponent?.connected === false ||
    (state.roomPlayers?.[1 - state.you] && state.roomPlayers[1 - state.you].connected === false);
  offlineBanner.classList.toggle('hidden', !opponentOffline);
}

/* ── Result / rematch ───────────────────────────────────────────────── */

function showResult(result) {
  if (state.result) return;
  state.result = result;
  state.phase = 'finished';
  state.awaitingRematch = false;
  cancelTargeting();
  flushInput();
  hideCountdown();
  offlineBanner.classList.add('hidden');

  const isDraw = result.winner === 'draw';
  const isWin = result.winner === state.you;
  const winner = !isDraw ? result.players?.find((player) => player.index === result.winner) : null;
  const duration = formatDuration(result.elapsedMs || 0);

  resultOverlay.classList.remove('hidden', 'is-win', 'is-loss', 'is-draw');
  resultOverlay.classList.add(isDraw ? 'is-draw' : isWin ? 'is-win' : 'is-loss');
  resultKicker.textContent =
    result.reason === 'breach' ? `GATE BREACHED · ${duration}` : `TIME EXPIRED · ${duration}`;
  resultTitle.textContent = isDraw ? 'Draw' : isWin ? 'Victory' : 'Defeat';
  const gateName = result.gate === 'upper' ? 'upper' : result.gate === 'lower' ? 'lower' : '';

  if (result.reason === 'breach') {
    resultSubtitle.textContent = isWin
      ? `You breached the ${gateName} gate first. The frontier is yours.`
      : `${winner?.name || 'The rival'} breached your ${gateName} gate first.`;
  } else if (isDraw) {
    resultSubtitle.textContent = 'The clock ran out with both miners dead level. No winner.';
  } else if (isWin) {
    resultSubtitle.textContent =
      'The clock ran out — you were closer to a rival gate when time expired.';
  } else {
    resultSubtitle.textContent = `${winner?.name || 'The rival'} was closer to a gate when time expired.`;
  }

  resultStats.replaceChildren();
  for (const player of result.players || []) {
    const card = document.createElement('article');
    card.className = 'result-player';
    if (!isDraw && player.index === result.winner) card.classList.add('is-winner');

    const header = document.createElement('header');
    header.className = 'result-player-header';
    const name = document.createElement('span');
    name.className = 'result-player-name';
    name.textContent = `${player.name}${player.index === state.you ? ' · YOU' : ''}`;
    const color = document.createElement('span');
    color.className = 'result-player-color';
    header.append(name, color);

    const rows = [
      ['Nearest gate', `${Math.round((player.progress || 0) * 100)}%`],
      ['Blocks broken', String(player.stats?.blocksMined ?? 0)],
      ['Skills used', String(player.stats?.skillsUsed ?? 0)],
      ['Cells advanced', String(player.stats?.cellsMoved ?? 0)],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      const valueEl = document.createElement('strong');
      valueEl.textContent = value;
      row.append(labelEl, valueEl);
      card.append(row);
    }
    card.prepend(header);
    resultStats.append(card);
  }

  resultOverlay.classList.remove('hidden');
  updateRematchUi();
  audio[(isDraw ? 'draw' : isWin ? 'win' : 'lose')]();
  window.setTimeout(() => rematchBtn.focus({ preventScroll: true }), 80);
}

function updateRematchUi() {
  if (!state.result) return;
  const opponent = state.roomPlayers[1 - state.you];
  const opponentReady = Boolean(state.rematchReady[1 - state.you]);
  const opponentOffline = opponent?.connected === false;
  const canRematch = Boolean(opponent?.connected) && state.connected;

  if (!state.connected) {
    rematchNote.textContent = 'Connection lost — reconnecting…';
  } else if (opponentOffline) {
    rematchNote.textContent = 'Rival offline — rematch unavailable.';
  } else if (state.awaitingRematch && opponentReady) {
    rematchNote.textContent = 'Both miners ready — starting…';
  } else if (state.awaitingRematch) {
    rematchNote.textContent = 'Waiting for rival…';
  } else if (opponentReady) {
    rematchNote.textContent = 'Rival is ready for a rematch.';
  } else {
    rematchNote.textContent = '';
  }

  if (state.awaitingRematch) {
    rematchBtn.textContent = 'Waiting for rival…';
    rematchBtn.disabled = true;
  } else {
    rematchBtn.textContent = 'Rematch';
    rematchBtn.disabled = !canRematch;
  }
  rematchBtn.setAttribute('aria-disabled', rematchBtn.disabled ? 'true' : 'false');
}

async function requestRematch() {
  if (!state.result || state.awaitingRematch) return;
  if (!state.connected || !socket) {
    addToast('Cannot rematch while disconnected.', 'danger');
    return;
  }
  state.awaitingRematch = true;
  audio.toggleReady();
  updateRematchUi();
  const result = await emitAck('game:rematch', {});
  if (!result.ok) {
    state.awaitingRematch = false;
    addToast(result.message || 'Could not request a rematch.', 'danger');
    updateRematchUi();
  }
}

/* ── Input ──────────────────────────────────────────────────────────── */

function currentDirection() {
  for (let i = state.pressedKeys.length - 1; i >= 0; i -= 1) {
    const direction = DIRECTION_KEYS[state.pressedKeys[i]];
    if (direction) return direction;
  }
  return null;
}

function canControl() {
  return (
    state.screen === 'game' &&
    state.phase === 'playing' &&
    !state.result &&
    state.connected &&
    Boolean(socket)
  );
}

function syncDirection(force = false) {
  if (!socket || !state.connected) {
    state.sentDir = null;
    return;
  }
  const direction = canControl() ? currentDirection() : null;
  if (!force && direction === state.sentDir) return;
  state.sentDir = direction;
  socket.emit('input:move', { dir: direction });
}

function clearHeldKeys() {
  state.pressedKeys = [];
}

function flushInput() {
  clearHeldKeys();
  if (socket?.connected && state.code) {
    if (state.sentDir !== null) {
      state.sentDir = null;
      socket.emit('input:move', { dir: null });
    }
  } else {
    state.sentDir = null;
  }
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function onKeyDown(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  audio.unlock();
  if (isTypingTarget(event.target)) return;
  if (state.screen !== 'game') return;

  if (event.code === 'Escape') {
    if (state.devOpen) {
      event.preventDefault();
      setDevMenu(false);
      return;
    }
    if (state.targeting) {
      event.preventDefault();
      cancelTargeting();
      return;
    }
  }

  if (event.code === 'KeyC') {
    event.preventDefault();
    if (event.repeat) return;
    handleCheatKey();
    return;
  }

  if (event.code === 'BracketRight') {
    event.preventDefault();
    if (event.repeat) return;
    handleDevKey();
    return;
  }

  const direction = DIRECTION_KEYS[event.code];
  if (direction) {
    if (state.phase !== 'playing' && state.phase !== 'countdown') return;
    event.preventDefault();
    if (event.repeat) return;
    if (
      state.phase === 'playing' &&
      (state.snapshot?.players?.[state.you]?.buffs?.qte ?? 0) > 0
    ) {
      // QTE thaw: every fresh direction tap chips away at the freeze.
      if (socket?.connected) socket.emit('game:thaw', {});
    }
    if (state.phase === 'countdown') {
      if (state.connected && !state.pressedKeys.includes(event.code)) {
        state.pressedKeys.push(event.code);
      }
      return;
    }
    if (!canControl()) return;
    if (!state.pressedKeys.includes(event.code)) state.pressedKeys.push(event.code);
    syncDirection();
    return;
  }

  const skill = SKILL_KEYS[event.code];
  if (skill) {
    event.preventDefault();
    if (event.repeat) return;
    activateSkill(skill);
  }
}

function onKeyUp(event) {
  const direction = DIRECTION_KEYS[event.code];
  if (!direction) return;
  if (state.screen === 'game') event.preventDefault();
  if (state.pressedKeys.includes(event.code)) {
    state.pressedKeys = state.pressedKeys.filter((code) => code !== event.code);
    syncDirection();
  }
}

function onWindowBlur() {
  flushInput();
}

function onVisibilityChange() {
  if (document.hidden) flushInput();
}

/* ── Menu / misc UI wiring ─────────────────────────────────────────── */

function setupMuteButton() {
  muteBtn.classList.toggle('is-muted', audio.muted);
  muteBtn.setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  muteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    audio.unlock();
    audio.toggleMuted();
    muteBtn.classList.toggle('is-muted', audio.muted);
    muteBtn.setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  });
}

async function copyRoomCode() {
  const code = state.code;
  if (!code) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      textarea.remove();
    } catch {
      copied = false;
    }
  }
  const original = copyCodeBtn.textContent;
  copyCodeBtn.textContent = copied ? 'Copied!' : 'Select & copy';
  if (!copied) window.prompt('Copy this room code:', code);
  window.setTimeout(() => {
    copyCodeBtn.textContent = original;
  }, 1500);
}

function initUi() {
  buildSkillCards();
  setupMuteButton();
  setupStatusTooltip();
  buildDevMenu();
  for (const button of devTargetBtns) {
    button.addEventListener('click', () => {
      state.devTarget = button.dataset.target === 'rival' ? 'rival' : 'self';
      for (const node of devTargetBtns) {
        node.classList.toggle('is-active', node === button);
      }
    });
  }
  if (devCloseBtn) devCloseBtn.addEventListener('click', () => setDevMenu(false));
  updateConnectionStatus();
  updateHudEmpty();
  if (seamSizeEl) seamSizeEl.textContent = `SHARED SEAM / ${CONFIG.cols} × ${CONFIG.rows}`;
  renderer.measure();

  for (const marker of raceMarkerEls) {
    if (marker) marker.textContent = '';
  }

  createBtn.addEventListener('click', () => {
    audio.click();
    createRoom();
  });
  joinBtn.addEventListener('click', () => {
    audio.click();
    joinRoom();
  });
  leaveLobbyBtn.addEventListener('click', () => {
    audio.click();
    leaveCurrentRoom();
  });
  leaveResultBtn.addEventListener('click', () => {
    audio.click();
    leaveCurrentRoom();
  });
  rematchBtn.addEventListener('click', () => {
    audio.unlock();
    requestRematch();
  });
  copyCodeBtn.addEventListener('click', () => {
    audio.click();
    copyRoomCode();
  });
  examSubmitBtn.addEventListener('click', () => {
    audio.unlock();
    submitExamAnswers();
  });

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (codeInput.value.trim()) joinRoom();
      else createRoom();
    }
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value
      .replace(/\D/g, '')
      .slice(0, CONFIG.roomCodeLength);
    showMenuMessage('');
  });
  nameInput.addEventListener('input', () => {
    showMenuMessage('');
    storeName(nameInput.value.trim().slice(0, 16));
  });
  for (const button of [createBtn, joinBtn, rematchBtn, copyCodeBtn, leaveLobbyBtn, leaveResultBtn]) {
    button.addEventListener('pointerenter', () => audio.unlock(), { once: true });
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });
  window.addEventListener('keydown', () => audio.unlock(), { capture: true });

  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('pointerup', onCanvasPointerUp);
  canvas.addEventListener('pointercancel', onCanvasPointerCancel);
  canvas.addEventListener('pointerleave', onCanvasPointerLeave);
  canvas.addEventListener('contextmenu', (event) => {
    if (!state.targeting) return;
    event.preventDefault();
    cancelTargeting();
  });

  if (window.matchMedia('(pointer: coarse)').matches) {
    document.body.classList.add('is-touch');
  }
}

initUi();
setupSocket();

// Read-only inspection hook used by the browser playtest scripts. It is only
// installed when the page is opened with ?debug=1.
if (new URLSearchParams(window.location.search).has('debug')) {
  window.__d2f = { state, renderer };
}
