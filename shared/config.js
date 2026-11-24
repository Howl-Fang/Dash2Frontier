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
    // Deliberately very quick: the gamble is the effect, not the dig time.
    mineTime: 0.3,
    color: '#3d2a63',
    edge: '#1b1233',
    accent: '#ffd76a',
    hardness: 0,
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
    cooldown: 16,
    target: 'rival',
    range: 9,
    maxCells: 3,
    blurb: 'Drag to place up to 3 barricades near the rival.',
    icon: 'barricade',
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
    blurb: 'A delayed frost burst near the rival. Chills for 4s.',
    icon: 'cryo',
  },
});

export const SKILL_ORDER = Object.freeze(['build', 'blast', 'overdrive', 'cryo']);

// Lucky blocks roll one of these effects when they are mined. `radius` is in
// cells around the block (1 = 3×3, 3 = 7×7); timed buffs live on the player.
export const LUCKY_EFFECTS = Object.freeze({
  soften: {
    id: 'soften',
    name: 'Soften',
    good: true,
    radius: 3,
    blurb: '7×7 rock around the block turns to soil.',
  },
  echo: {
    id: 'echo',
    name: 'Echo Form',
    good: true,
    duration: 8,
    blurb: 'Two blocks break per dig for 8s.',
  },
  wall: {
    id: 'wall',
    name: 'Wall',
    good: true,
    blurb: 'Your whole column turns to obsidian, except your cell.',
  },
  harden: {
    id: 'harden',
    name: 'Harden',
    good: false,
    radius: 1,
    blurb: '3×3 rock around the block turns to obsidian.',
  },
  invert: {
    id: 'invert',
    name: 'Invert',
    good: false,
    duration: 6,
    blurb: 'Movement controls are reversed for 6s.',
  },
});

export const LUCKY_EFFECT_ORDER = Object.freeze([
  'soften',
  'echo',
  'wall',
  'harden',
  'invert',
]);

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
  snapshotHz: 30,
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
  map: Object.freeze({
    bedrockChance: 0.075,
    veinCount: 10,
    veinMin: 5,
    veinMax: 13,
    clusterCount: 9,
    clusterMin: 3,
    clusterMax: 8,
    // Lucky blocks are seeded in the top and bottom stretches of the map.
    luckyCount: 10,
    luckyBands: Object.freeze([
      Object.freeze([1, 6]),
      Object.freeze([21, 26]),
    ]),
    minPathSeconds: 140,
    maxPathSeconds: 210,
    minDetourExtraCells: 3,
    maxAttempts: 60,
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
