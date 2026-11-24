// Shared between the Node server and the browser. Keep this file free of
// Node- or DOM-only APIs.

export const BLOCK = Object.freeze({
  EMPTY: -1,
  SOIL: 0,
  SANDSTONE: 1,
  GRANITE: 2,
  OBSIDIAN: 3,
  BEDROCK: 4,
  BARRICADE: 5,
  LUCKY: 6,
  ICE: 7,
});

// Indexed by block id. `hardness` is used by the renderer for texture detail.
export const BLOCK_TYPES = Object.freeze([
  {
    id: BLOCK.SOIL,
    name: 'Soil',
    mineTime: 1.0,
    color: '#8b5a3c',
    edge: '#5c3826',
    accent: '#b87a52',
    hardness: 0,
  },
  {
    id: BLOCK.SANDSTONE,
    name: 'Sandstone',
    mineTime: 1.8,
    color: '#b9864a',
    edge: '#7c542b',
    accent: '#e0b06b',
    hardness: 1,
  },
  {
    id: BLOCK.GRANITE,
    name: 'Granite',
    mineTime: 2.8,
    color: '#667382',
    edge: '#3d4753',
    accent: '#93a1ad',
    hardness: 2,
  },
  {
    id: BLOCK.OBSIDIAN,
    name: 'Obsidian',
    mineTime: 4.0,
    color: '#493663',
    edge: '#281b3a',
    accent: '#8b6fb5',
    hardness: 3,
  },
  {
    id: BLOCK.BEDROCK,
    name: 'Bedrock',
    mineTime: Infinity,
    color: '#272831',
    edge: '#111218',
    accent: '#4c4e5c',
    hardness: 4,
  },
  {
    id: BLOCK.BARRICADE,
    name: 'Barricade',
    mineTime: 5.0,
    color: '#c58b24',
    edge: '#6e460b',
    accent: '#ffd76a',
    hardness: 3,
  },
  {
    id: BLOCK.LUCKY,
    name: 'Lucky Block',
    // Clusters scale this by their cell count: 1 cell 0.3 s, 3 cells 0.9 s.
    mineTime: 0.3,
    color: '#3d2a63',
    edge: '#1b1233',
    accent: '#ffd76a',
    hardness: 0,
  },
  {
    // Frostbite ice: as tough as obsidian, made by the empowered Cryo.
    id: BLOCK.ICE,
    name: 'Hard Ice',
    mineTime: 4.0,
    color: '#2d6c86',
    edge: '#123a4a',
    accent: '#a9ecff',
    hardness: 3,
  },
]);

export const SOLID_BLOCKS = new Set(
  BLOCK_TYPES.filter((block) => block.id !== BLOCK.EMPTY).map((block) => block.id),
);

// Skills are defined once for the server and the client. Targeted skills are
// aimed with the mouse; `target` says what the aiming circle is centred on.
export const SKILLS = Object.freeze({
  build: {
    id: 'build',
    name: 'Build',
    key: 'Q',
    cost: 35,
    cooldown: 10,
    target: 'rival',
    range: 9,
    maxCells: 3,
    megaWidth: 3,
    blurb: 'Drag to place up to 3 barricades near the rival. Overwrites rock.',
    icon: 'build',
  },
  blast: {
    id: 'blast',
    name: 'Blast',
    key: 'E',
    cost: 50,
    cooldown: 25,
    target: 'self',
    range: 10,
    radius: 1,
    megaRadius: 3,
    blurb: 'Blow a 3×3 hole within 10 cells of yourself.',
    icon: 'blast',
  },
  overdrive: {
    id: 'overdrive',
    name: 'Overdrive',
    key: 'R',
    cost: 30,
    cooldown: 18,
    target: 'self',
    duration: 5,
    mineMultiplier: 1.8,
    moveMultiplier: 1.25,
    hyperMultiplier: 5,
    blurb: '5s: ×1.8 drill speed and ×1.25 movement.',
    icon: 'overdrive',
  },
  cryo: {
    id: 'cryo',
    name: 'Cryo',
    key: 'F',
    cost: 30,
    cooldown: 18,
    target: 'rival',
    range: 9,
    radius: 2,
    delay: 0.45,
    duration: 4,
    mineMultiplier: 0.45,
    moveMultiplier: 0.6,
    frostbiteRadius: 2,
    blurb: 'A delayed frost burst near the rival. Chills for 4s.',
    icon: 'cryo',
  },
});

export const SKILL_ORDER = Object.freeze(['build', 'blast', 'overdrive', 'cryo']);

// Lucky blocks roll one of these effects. `kind` decides who usually receives
// it; terrain effects rewrite the map around the block instead of a player.
// Icons live in public/js/icons.js so this file stays DOM-free.
export const EFFECTS = Object.freeze({
  echo: {
    id: 'echo',
    name: 'Echo Form',
    kind: 'buff',
    duration: 8,
    description: 'Each dig breaks two blocks in a line for 8s.',
  },
  reject: {
    id: 'reject',
    name: 'Reject',
    kind: 'buff',
    duration: 12,
    description: 'Debuffs cannot be applied for 12s.',
  },
  luck: {
    id: 'luck',
    name: 'Luck',
    kind: 'buff',
    charges: 2,
    description: 'The next 2 lucky blocks you mine are guaranteed buffs.',
  },
  apotheosis: {
    id: 'apotheosis',
    name: 'Apotheosis',
    kind: 'buff',
    charges: 1,
    description:
      'Your next skill is empowered: MegaBuild, HyperDrive, Frostbite or GigaBlast.',
  },
  invert: {
    id: 'invert',
    name: 'Invert',
    kind: 'debuff',
    duration: 6,
    description: 'Movement and facing are reversed for 6s.',
  },
  fog: {
    id: 'fog',
    name: 'Fog',
    kind: 'debuff',
    duration: 8,
    description: 'Vision is limited to the area around you for 8s.',
  },
  drain: {
    id: 'drain',
    name: 'Drain',
    kind: 'debuff',
    description: 'Instantly drains all energy.',
  },
  lag: {
    id: 'lag',
    name: 'Lag',
    kind: 'debuff',
    duration: 10,
    cooldownMultiplier: 1.8,
    description: 'Skill cooldowns are 1.8× longer for 10s.',
  },
  freeze: {
    id: 'freeze',
    name: 'Freeze',
    kind: 'debuff',
    duration: 6,
    // QTE meter: each tap adds progress, progress decays constantly so the
    // player has to mash instead of tapping eight times slowly.
    startProgress: 0.12,
    tapGain: 0.16,
    decayPerSecond: 0.3,
    description: 'Frozen in place. Mash direction keys to fill the thaw ring.',
  },
  misfortune: {
    id: 'misfortune',
    name: 'Misfortune',
    kind: 'debuff',
    duration: 12,
    description: 'Lucky blocks you mine only debuff you for 12s.',
  },
  lockdown: {
    id: 'lockdown',
    name: 'Lockdown',
    kind: 'tradeoff',
    duration: 8,
    description: 'Both target gates are sealed for 8s — for everyone.',
  },
  hijack: {
    id: 'hijack',
    name: 'Hijack',
    kind: 'tradeoff',
    duration: 10,
    mineMultiplier: 3,
    description: 'Locked in one direction for 10s, but drill ×3.',
  },
  exam: {
    id: 'exam',
    name: 'Exam',
    kind: 'tradeoff',
    description: 'Solve 3 sums in 10s: pass drill ×2, fail drill ×0.5.',
  },
  balance: {
    id: 'balance',
    name: 'Balance',
    kind: 'tradeoff',
    duration: 5,
    behindMultiplier: 3,
    aheadDivisor: 3,
    description: 'Behind on progress: drill ×3, ahead: ÷3, for 5s.',
  },
  mundane: {
    id: 'mundane',
    name: 'Mundane',
    kind: 'tradeoff',
    duration: 15,
    description: 'Immune to all buffs and debuffs for 15s.',
  },
  soften: {
    id: 'soften',
    name: 'Soften',
    kind: 'terrain',
    good: true,
    radius: 3,
    description: '7×7 rock around the block turns to soil.',
  },
  wall: {
    id: 'wall',
    name: 'Wall',
    kind: 'terrain',
    good: true,
    description: 'Your whole column turns to obsidian, except your cell.',
  },
  harden: {
    id: 'harden',
    name: 'Harden',
    kind: 'terrain',
    good: false,
    radius: 1,
    description: '3×3 rock around the block turns to obsidian.',
  },
});

// Player-visible status catalogue. `buffKey` maps a status to the timer stored
// on the player; skill buffs (Overdrive/Cryo) and cheat freeze live here too so
// the HUD can render every active effect with one icon set.
export const STATUS_DEFS = Object.freeze({
  overdrive: {
    id: 'overdrive',
    name: 'Overdrive',
    short: 'BOOST',
    kind: 'buff',
    description: 'Drill ×1.8 and movement ×1.25.',
  },
  echo: { id: 'echo', name: 'Echo Form', short: 'ECHO', kind: 'buff' },
  reject: { id: 'reject', name: 'Reject', short: 'WARD', kind: 'buff' },
  luck: {
    id: 'luck',
    name: 'Luck',
    short: 'LUCK',
    kind: 'buff',
    description: 'The next lucky blocks you mine are guaranteed buffs.',
  },
  apotheosis: {
    id: 'apotheosis',
    name: 'Apotheosis',
    short: 'APO',
    kind: 'buff',
    description: 'Your next skill cast is empowered.',
  },
  hyper: {
    id: 'hyper',
    name: 'HyperDrive',
    short: 'HYPER',
    kind: 'buff',
    description: 'HyperDrive: drill and movement ×5.',
  },
  examPass: {
    id: 'examPass',
    name: 'Exam Passed',
    short: 'PASS',
    kind: 'buff',
    description: 'Drill ×2 after passing the exam.',
  },
  cryo: {
    id: 'cryo',
    name: 'Chilled',
    short: 'CHILL',
    kind: 'debuff',
    description: 'Cryo slow: drill ×0.45 and movement ×0.6.',
  },
  invert: { id: 'invert', name: 'Invert', short: 'FLIP', kind: 'debuff' },
  fog: { id: 'fog', name: 'Fog', short: 'FOG', kind: 'debuff' },
  lag: { id: 'lag', name: 'Lag', short: 'LAG', kind: 'debuff' },
  qte: {
    id: 'qte',
    name: 'Frozen',
    short: 'ICE',
    kind: 'debuff',
    description: 'Cannot move or drill. Mash direction keys to break free.',
  },
  misfortune: {
    id: 'misfortune',
    name: 'Misfortune',
    short: 'DOOM',
    kind: 'debuff',
  },
  examFail: {
    id: 'examFail',
    name: 'Exam Failed',
    short: 'FAIL',
    kind: 'debuff',
    description: 'Drill ×0.5 after failing the exam.',
  },
  freeze: {
    id: 'freeze',
    name: 'Hard Frozen',
    short: 'LOCK',
    kind: 'debuff',
    description: 'Cheat-mode freeze: cannot move or drill.',
  },
  hijack: { id: 'hijack', name: 'Hijack', short: 'STEER', kind: 'tradeoff' },
  exam: {
    id: 'exam',
    name: 'Exam',
    short: 'EXAM',
    kind: 'tradeoff',
    description: 'Answer 3 sums before the timer runs out.',
  },
  balance: { id: 'balance', name: 'Balance', short: 'RISK', kind: 'tradeoff' },
  mundane: { id: 'mundane', name: 'Mundane', short: 'NULL', kind: 'tradeoff' },
});

// Weighted roll table. Weights are tuned so buffs, debuffs, tradeoffs and
// terrain each show up regularly.
export const LUCKY_ROLL_TABLE = Object.freeze([
  { effect: 'echo', weight: 16 },
  { effect: 'reject', weight: 7 },
  { effect: 'luck', weight: 10 },
  { effect: 'apotheosis', weight: 8 },
  { effect: 'invert', weight: 8 },
  { effect: 'fog', weight: 10 },
  { effect: 'drain', weight: 8 },
  { effect: 'lag', weight: 8 },
  { effect: 'freeze', weight: 8 },
  { effect: 'misfortune', weight: 6 },
  { effect: 'lockdown', weight: 6 },
  { effect: 'hijack', weight: 9 },
  { effect: 'exam', weight: 8 },
  { effect: 'balance', weight: 7 },
  { effect: 'mundane', weight: 5 },
  { effect: 'soften', weight: 10 },
  { effect: 'wall', weight: 9 },
  { effect: 'harden', weight: 10 },
]);

export const LUCKY_BUFF_POOL = Object.freeze(['echo', 'reject', 'luck', 'apotheosis']);
export const LUCKY_DEBUFF_POOL = Object.freeze([
  'invert',
  'fog',
  'drain',
  'lag',
  'freeze',
  'misfortune',
]);

const LUCKY_ROLL_TOTAL = LUCKY_ROLL_TABLE.reduce((sum, entry) => sum + entry.weight, 0);

/** Map a 0–1 roll to one entry of the weighted table. */
export function luckyEffectForRoll(roll) {
  const value = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  const cursor = value * LUCKY_ROLL_TOTAL;
  let acc = 0;
  for (const entry of LUCKY_ROLL_TABLE) {
    acc += entry.weight;
    if (cursor < acc) return entry.effect;
  }
  return LUCKY_ROLL_TABLE[LUCKY_ROLL_TABLE.length - 1].effect;
}

/** Pick one entry of a pool from a 0–1 roll. */
export function pickFromPool(pool, roll) {
  if (!pool || pool.length === 0) return null;
  const value = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return pool[Math.floor(value * pool.length)];
}

export const CONFIG = Object.freeze({
  port: 8000,
  cols: 72,
  rows: 28,
  // Each player's spawn row differs: (0, 13) and (71, 14) are a 180° mirror.
  playerRows: [13, 14],
  startCols: [0, 71],
  goalCols: [71, 0],
  // Only the upper and lower stretches of each baseline are gates. The middle
  // stretch (where both players spawn) is deliberately not a destination.
  goalBands: Object.freeze([Object.freeze([0, 6]), Object.freeze([21, 27])]),
  goalDepth: 2,
  startPocket: Object.freeze({ cols: [0, 1], rows: [12, 15] }),
  matchSeconds: 240,
  countdownSeconds: 3,
  tickMs: 33,
  // State broadcasts are throttled below the simulation rate and smoothed by
  // client-side prediction, which keeps slow links comfortable.
  snapshotHz: 20,
  // Continuous movement. Positions are measured in grid units and refer to the
  // centre of the miner's collision box.
  moveSpeed: 4.4,
  playerHalfSize: 0.32,
  laneAssistSpeed: 8,
  laneTolerance: 0.47,
  contactSlack: 0.09,
  roomCodeLength: 5,
  roomCodeDigits: '0123456789',
  maxRooms: 250,
  energy: Object.freeze({
    start: 50,
    max: 100,
    regenPerSecond: 2.5,
    perBlock: 2,
    perBlastBlock: 1,
  }),
  // Hidden cheat mode (triple-tap C). Freezing is a hard immobilise, not Cryo.
  cheat: Object.freeze({
    freezeSeconds: 6,
  }),
  // Lucky-block debuffs mostly hit the rival; this is the chance to hit self.
  luckySelfDebuffChance: 0.2,
  exam: Object.freeze({
    seconds: 10,
    questions: 3,
    passDuration: 20,
    failDuration: 20,
    passMultiplier: 2,
    failMultiplier: 0.5,
  }),
  map: Object.freeze({
    bedrockChance: 0.09,
    veinCount: 10,
    veinMin: 5,
    veinMax: 13,
    clusterCount: 9,
    clusterMin: 3,
    clusterMax: 8,
    // Lucky blocks are seeded in the top and bottom stretches of the map, in
    // clusters of 1–3 cells.
    luckyCount: 28,
    luckyBands: Object.freeze([
      Object.freeze([1, 6]),
      Object.freeze([21, 26]),
    ]),
    minPathSeconds: 140,
    maxPathSeconds: 210,
    minDetourExtraCells: 3,
    // The centre pattern can open shortcuts or plug routes, so generation
    // retries until a validated route exists before using the fallback.
    maxAttempts: 200,
  }),
});

export const DIRECTIONS = Object.freeze({
  up: { dc: 0, dr: -1, dx: 0, dy: -1 },
  down: { dc: 0, dr: 1, dx: 0, dy: 1 },
  left: { dc: -1, dr: 0, dx: -1, dy: 0 },
  right: { dc: 1, dr: 0, dx: 1, dy: 0 },
});

export const DIRECTION_NAMES = Object.freeze(['up', 'down', 'left', 'right']);

export const oppositeDirection = (direction) => {
  switch (direction) {
    case 'up':
      return 'down';
    case 'down':
      return 'up';
    case 'left':
      return 'right';
    case 'right':
      return 'left';
    default:
      return null;
  }
};

export const goalDirectionForPlayer = (index) => (index === 0 ? 'right' : 'left');

export function isGoalRow(row, config = CONFIG) {
  return config.goalBands.some(([low, high]) => row >= low && row <= high);
}

/** True for the outermost baseline cells that actually score a breach. */
export function isGoalTriggerCell(col, row, config = CONFIG) {
  return (col === 0 || col === config.cols - 1) && isGoalRow(row, config);
}

export function isStartPocketCell(col, row, config = CONFIG) {
  const { cols, rows } = config.startPocket;
  const inLeft = col >= cols[0] && col <= cols[1] && row >= rows[0] && row <= rows[1];
  const inRight = col >= config.cols - 1 - cols[1] && col <= config.cols - 1 - cols[0];
  const mirrorRow = (value) => config.rows - 1 - value;
  return (
    inLeft ||
    (inRight && row >= mirrorRow(rows[1]) && row <= mirrorRow(rows[0]))
  );
}

/**
 * Shortest planar distance from a point to the opponent's two gate zones.
 * Used for the HUD progress bar and for resolving a timeout.
 */
export function distanceToGoalZone(config, playerIndex, x, y) {
  const goalCol = config.goalCols[playerIndex];
  let best = Infinity;
  for (const [low, high] of config.goalBands) {
    const dx = x < goalCol ? goalCol - x : x > goalCol + 1 ? x - (goalCol + 1) : 0;
    const dy = y < low ? low - y : y > high + 1 ? y - (high + 1) : 0;
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}
