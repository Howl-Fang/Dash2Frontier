import { BLOCK, BLOCK_TYPES, CONFIG } from '../shared/config.js';

export const cellIndex = (col, row, cols) => row * cols + col;

export function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

// Small deterministic PRNG so a map can be reproduced from its seed.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randomInt = (random, min, max) => min + Math.floor(random() * (max - min + 1));

function pickBaseBlock(random, bedrockChance) {
  const roll = random();
  if (roll < 0.39) return BLOCK.SOIL;
  if (roll < 0.68) return BLOCK.SANDSTONE;
  if (roll < 0.87) return BLOCK.GRANITE;
  if (roll < 1 - bedrockChance) return BLOCK.OBSIDIAN;
  return BLOCK.BEDROCK;
}

function addVeins(cells, cols, rows, random, mapConfig) {
  const half = Math.floor(cols / 2);
  const veinTypes = [BLOCK.GRANITE, BLOCK.GRANITE, BLOCK.OBSIDIAN];
  const steps = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  for (let vein = 0; vein < mapConfig.veinCount; vein += 1) {
    let col = Math.floor(random() * half);
    let row = Math.floor(random() * rows);
    const type = veinTypes[Math.floor(random() * veinTypes.length)];
    const length =
      mapConfig.veinMin + Math.floor(random() * (mapConfig.veinMax - mapConfig.veinMin + 1));

    for (let step = 0; step < length; step += 1) {
      cells[cellIndex(col, row, cols)] = type;
      const direction = steps[Math.floor(random() * steps.length)];
      col = Math.min(half - 1, Math.max(0, col + direction[0]));
      row = Math.min(rows - 1, Math.max(0, row + direction[1]));
    }
  }
}

/**
 * Irregular bedrock knots so routes cannot be memorised as clean corridors.
 * Long fault lines and shelves were removed: they chopped the seam into
 * hard-to-reach pockets and buried lucky blocks behind unbreakable walls.
 */
function addClusters(cells, cols, rows, random, mapConfig) {
  const half = Math.floor(cols / 2);
  for (let cluster = 0; cluster < mapConfig.clusterCount; cluster += 1) {
    const centerCol = randomInt(random, 2, half - 3);
    const centerRow = randomInt(random, 2, rows - 3);
    const radius = randomInt(random, 1, 2);
    for (let dc = -radius; dc <= radius; dc += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        if (Math.abs(dc) + Math.abs(dr) > radius + 1) continue;
        if (random() < 0.28) continue;
        const col = centerCol + dc;
        const row = centerRow + dr;
        if (col < 0 || col >= half || row < 0 || row >= rows) continue;
        cells[cellIndex(col, row, cols)] = BLOCK.BEDROCK;
      }
    }
  }
}

function mirrorHalf(cells, cols, rows) {
  const half = Math.floor(cols / 2);
  for (let col = 0; col < half; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const mirrorCol = cols - 1 - col;
      const mirrorRow = rows - 1 - row;
      cells[cellIndex(mirrorCol, mirrorRow, cols)] = cells[cellIndex(col, row, cols)];
    }
  }
}

function carveStartPockets(cells, cols, rows, pocket) {
  const [colStart, colEnd] = pocket.cols;
  const [rowStart, rowEnd] = pocket.rows;
  for (let col = colStart; col <= colEnd; col += 1) {
    for (let row = rowStart; row <= rowEnd; row += 1) {
      cells[cellIndex(col, row, cols)] = BLOCK.EMPTY;
      cells[cellIndex(cols - 1 - col, rows - 1 - row, cols)] = BLOCK.EMPTY;
    }
  }
}

function carveGoalAlcoves(cells, config) {
  const { cols, goalBands, goalDepth } = config;
  for (const [low, high] of goalBands) {
    for (let depth = 0; depth < goalDepth; depth += 1) {
      for (let row = low; row <= high; row += 1) {
        cells[cellIndex(depth, row, cols)] = BLOCK.EMPTY;
        cells[cellIndex(cols - 1 - depth, row, cols)] = BLOCK.EMPTY;
      }
    }
  }
}

/**
 * The middle of each baseline is sealed with bedrock. The only open edge cells
 * are the two scoring gates (and the spawn pockets, which do not score).
 */
function sealNonGoalBaselines(cells, config) {
  const { cols, rows, goalBands } = config;
  const [pocketLow, pocketHigh] = config.startPocket.rows;
  const inPocket = (row) => row >= pocketLow && row <= pocketHigh;
  for (let row = 0; row < rows; row += 1) {
    if (inPocket(row)) continue;
    if (goalBands.some(([low, high]) => row >= low && row <= high)) continue;
    cells[cellIndex(0, row, cols)] = BLOCK.BEDROCK;
    cells[cellIndex(cols - 1, row, cols)] = BLOCK.BEDROCK;
  }
}

/**
 * Scatter lucky blocks through the top and bottom stretches of the map. Blocks
 * come in contiguous clusters of 1–3 cells: bigger clusters take longer to dig
 * but fire several outcomes at once. They only replace diggable rock, never
 * bedrock or an already-open cell, and every placement is mirrored 180° so both
 * miners get the same gambles.
 */
function addLuckyBlocks(cells, cols, rows, random, mapConfig) {
  const bands = mapConfig.luckyBands || CONFIG.map.luckyBands;
  const count = mapConfig.luckyCount ?? 0;
  if (count <= 0 || !Array.isArray(bands) || bands.length === 0) return;

  const half = Math.floor(cols / 2);
  // Stay away from the gate alcoves on the outer two columns.
  const minCol = Math.min(2, half - 1);
  const maxCol = Math.max(minCol, half - 2);
  const placed = new Set();
  let placedCount = 0;
  let attempts = 0;

  const pickSize = () => {
    const roll = random();
    if (roll < 0.55) return 1;
    if (roll < 0.85) return 2;
    return 3;
  };

  while (placedCount < count && attempts < count * 60) {
    attempts += 1;
    const band = bands[Math.floor(random() * bands.length)];
    const size = pickSize();
    const horizontal = random() < 0.5;
    const rowLimit = horizontal ? band[1] : band[1] - (size - 1);
    const colLimit = horizontal ? maxCol - (size - 1) : maxCol;
    if (rowLimit < band[0] || colLimit < minCol) continue;
    const startRow = randomInt(random, band[0], rowLimit);
    const startCol = randomInt(random, minCol, colLimit);

    const cluster = [];
    const mirrored = [];
    let valid = true;
    for (let i = 0; i < size; i += 1) {
      const col = horizontal ? startCol + i : startCol;
      const row = horizontal ? startRow : startRow + i;
      const index = cellIndex(col, row, cols);
      const mirrorIndex = cellIndex(cols - 1 - col, rows - 1 - row, cols);
      const block = cells[index];
      if (block === BLOCK.EMPTY || block === BLOCK.BEDROCK || block === BLOCK.LUCKY) {
        valid = false;
        break;
      }
      if (placed.has(index) || placed.has(mirrorIndex)) {
        valid = false;
        break;
      }
      cluster.push(index);
      mirrored.push(mirrorIndex);
    }
    if (!valid) continue;

    for (const index of cluster) cells[index] = BLOCK.LUCKY;
    for (const index of mirrored) cells[index] = BLOCK.LUCKY;
    for (const index of [...cluster, ...mirrored]) placed.add(index);
    placedCount += 1;
  }
}

/**
 * A centrepiece pattern stitched into the final map. It runs after everything
 * else and rewrites every non-bedrock cell it covers, so a pattern can delete
 * lucky blocks or open shortcuts; the generator re-validates the route after
 * applying it. Exactly one pattern is chosen per map.
 */
function applyCenterPattern(cells, cols, rows, random) {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const roll = random();
  const pattern = roll < 0.34 ? 'taiji' : roll < 0.67 ? 'rings' : 'space';

  if (pattern === 'space') {
    // A six-column vertical void through the middle of the seam.
    const low = Math.floor(cx) - 2;
    for (let col = low; col < low + 6; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const index = cellIndex(col, row, cols);
        if (cells[index] !== BLOCK.BEDROCK) cells[index] = BLOCK.EMPTY;
      }
    }
    return pattern;
  }

  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const index = cellIndex(col, row, cols);
      if (cells[index] === BLOCK.BEDROCK) continue;
      const dx = col - cx;
      const dy = row - cy;

      if (pattern === 'taiji') {
        const radius = 4.9;
        if (Math.hypot(dx, dy) > radius) continue;
        // Two eyes sit on the vertical axis, so the poles read top-to-bottom
        // and the whole figure is 180° rotationally symmetric.
        const inTopEye = Math.hypot(dx, dy + radius / 2) <= radius / 2;
        const inBottomEye = Math.hypot(dx, dy - radius / 2) <= radius / 2;
        let granite;
        if (inTopEye) granite = true;
        else if (inBottomEye) granite = false;
        else granite = dx >= 0;
        cells[index] = granite ? BLOCK.GRANITE : BLOCK.SOIL;
      } else {
        // Eight concentric rings alternating soil and obsidian.
        const distance = Math.hypot(dx, dy);
        const ring = Math.round(distance);
        if (ring < 1 || ring > 8) continue;
        cells[index] = ring % 2 === 0 ? BLOCK.SOIL : BLOCK.OBSIDIAN;
      }
    }
  }
  return pattern;
}

function canPass(block) {
  return block !== BLOCK.BEDROCK;
}

function resolvedMapConfig(config) {
  return { ...CONFIG.map, ...(config?.map || {}) };
}

function resolvedConfig(config) {
  return { ...CONFIG, ...(config || {}), map: resolvedMapConfig(config) };
}

/**
 * Dijkstra analysis from one spawn. It records the cheapest route to *both*
 * gate bands on the enemy baseline, plus how much the route detours from the
 * Manhattan minimum.
 */
export function analyzeMap(
  map,
  {
    startCol,
    startRow,
    goalCol,
    goalBands = CONFIG.goalBands,
    moveSeconds = 1 / CONFIG.moveSpeed,
  } = {},
) {
  const { cols, rows, cells } = map;
  const start = cellIndex(startCol, startRow, cols);
  const activeBands = goalBands
    .map(([low, high]) => [Math.max(0, low), Math.min(rows - 1, high)])
    .filter(([low, high]) => low <= high);
  const gates = activeBands.map((band) => ({
    band,
    reachable: false,
    pathSeconds: Infinity,
    pathCells: Infinity,
    goalRow: null,
    detourExtraCells: Infinity,
  }));

  const totalCells = cols * rows;
  const dist = new Float64Array(totalCells);
  const depth = new Int32Array(totalCells);
  dist.fill(Infinity);
  depth.fill(0x7fffffff);
  dist[start] = 0;
  depth[start] = 0;

  const heap = [];
  const push = (cost, steps, index) => {
    heap.push([cost, steps, index]);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const a = heap[parent];
      const b = heap[child];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])) break;
      heap[parent] = b;
      heap[child] = a;
      child = parent;
    }
  };

  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (
          left < heap.length &&
          (heap[left][0] < heap[smallest][0] ||
            (heap[left][0] === heap[smallest][0] && heap[left][1] < heap[smallest][1]))
        ) {
          smallest = left;
        }
        if (
          right < heap.length &&
          (heap[right][0] < heap[smallest][0] ||
            (heap[right][0] === heap[smallest][0] && heap[right][1] < heap[smallest][1]))
        ) {
          smallest = right;
        }
        if (smallest === parent) break;
        [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
        parent = smallest;
      }
    }
    return top;
  };

  const offsets = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  let found = 0;
  push(0, 0, start);

  while (heap.length > 0 && found < gates.length) {
    const [cost, steps, index] = pop();
    if (cost > dist[index] || (cost === dist[index] && steps > depth[index])) continue;
    const col = index % cols;
    const row = Math.floor(index / cols);

    if (col === goalCol) {
      const bandIndex = activeBands.findIndex(([low, high]) => row >= low && row <= high);
      if (bandIndex >= 0 && !gates[bandIndex].reachable) {
        const [low, high] = activeBands[bandIndex];
        const manhattan = Math.abs(goalCol - startCol) + Math.abs(row - startRow);
        gates[bandIndex] = {
          band: [low, high],
          reachable: true,
          pathSeconds: cost,
          pathCells: steps,
          goalRow: row,
          detourExtraCells: Math.max(0, steps - manhattan),
        };
        found += 1;
        if (found === gates.length) break;
      }
    }

    for (const [dc, dr] of offsets) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) continue;
      const nextIndex = cellIndex(nextCol, nextRow, cols);
      const block = cells[nextIndex];
      if (!canPass(block)) continue;
      const mineTime = block === BLOCK.EMPTY ? 0 : BLOCK_TYPES[block].mineTime;
      const nextCost = cost + moveSeconds + mineTime;
      const nextSteps = steps + 1;
      if (
        nextCost < dist[nextIndex] - 1e-9 ||
        (Math.abs(nextCost - dist[nextIndex]) <= 1e-9 && nextSteps < depth[nextIndex])
      ) {
        dist[nextIndex] = nextCost;
        depth[nextIndex] = nextSteps;
        push(nextCost, nextSteps, nextIndex);
      }
    }
  }

  const foundGates = gates.filter((gate) => gate.reachable);
  const best = foundGates.reduce(
    (current, gate) => (gate.pathSeconds < current.pathSeconds ? gate : current),
    { pathSeconds: Infinity, pathCells: Infinity, detourExtraCells: Infinity, goalRow: null },
  );

  return {
    // Both gate bands must be reachable for a map to be considered fair.
    reachable: gates.length > 0 && gates.every((gate) => gate.reachable),
    gates,
    pathSeconds: best.pathSeconds,
    pathCells: best.pathCells,
    detourExtraCells: best.detourExtraCells,
    goalRow: best.goalRow,
  };
}

function buildRawMap(cols, rows, random, config) {
  const mapConfig = config.map;
  const cells = new Array(cols * rows);
  const half = Math.floor(cols / 2);
  for (let col = 0; col < half; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      cells[cellIndex(col, row, cols)] = pickBaseBlock(random, mapConfig.bedrockChance);
    }
  }
  addVeins(cells, cols, rows, random, mapConfig);
  addClusters(cells, cols, rows, random, mapConfig);
  mirrorHalf(cells, cols, rows);
  carveStartPockets(cells, cols, rows, config.startPocket);
  carveGoalAlcoves(cells, config);
  sealNonGoalBaselines(cells, config);
  addLuckyBlocks(cells, cols, rows, random, mapConfig);
  const pattern = applyCenterPattern(cells, cols, rows, random);
  return { cols, rows, cells, pattern };
}

function analysisFor(map, config, playerIndex) {
  return analyzeMap(map, {
    startCol: config.startCols[playerIndex],
    startRow: config.playerRows[playerIndex],
    goalCol: config.goalCols[playerIndex],
    goalBands: config.goalBands,
    moveSeconds: 1 / config.moveSpeed,
  });
}

function routeIsPlayable(analysis, mapConfig) {
  if (!analysis.reachable) return false;
  if (!Number.isFinite(analysis.pathSeconds)) return false;
  return (
    analysis.pathSeconds >= mapConfig.minPathSeconds &&
    analysis.pathSeconds <= mapConfig.maxPathSeconds
  );
}

function routeScore(analysis, mapConfig) {
  if (!Number.isFinite(analysis.pathSeconds)) return Infinity;
  const midpoint = (mapConfig.minPathSeconds + mapConfig.maxPathSeconds) / 2;
  const bandPenalty = Math.abs(analysis.pathSeconds - midpoint);
  const detourPenalty =
    analysis.detourExtraCells < mapConfig.minDetourExtraCells
      ? (mapConfig.minDetourExtraCells - analysis.detourExtraCells) * 30
      : 0;
  return bandPenalty + detourPenalty;
}

/**
 * Guaranteed-solvable fallback. The cross tunnels are carved with 180°
 * symmetry, so both spawns can always reach both gates even if every random
 * seed up to `maxAttempts` failed the normal validator.
 */
function buildFallbackMap(config) {
  const mapConfig = { ...config.map, clusterCount: 0, veinCount: 0 };
  const map = buildRawMap(config.cols, config.rows, mulberry32(0x5eed), {
    ...config,
    map: mapConfig,
  });
  const { cols, rows } = map;
  const midCol = Math.floor(cols / 2);
  for (let col = 2; col <= cols - 3; col += 1) {
    map.cells[cellIndex(col, 13, cols)] = BLOCK.EMPTY;
    map.cells[cellIndex(col, 14, cols)] = BLOCK.EMPTY;
    map.cells[cellIndex(col, 3, cols)] = BLOCK.EMPTY;
    map.cells[cellIndex(col, 24, cols)] = BLOCK.EMPTY;
  }
  for (let row = 3; row <= 24; row += 1) {
    map.cells[cellIndex(midCol - 1, row, cols)] = BLOCK.EMPTY;
    map.cells[cellIndex(midCol, row, cols)] = BLOCK.EMPTY;
  }
  sealNonGoalBaselines(map.cells, config);
  return map;
}

/**
 * Generate a fair, connected map. The left half is generated and rotated 180°
 * onto the right half, then both upper and lower gates are validated from both
 * spawns. Regeneration continues until the route time and detour are playable.
 */
export function generateMap({ seed = randomSeed(), config = CONFIG } = {}) {
  const resolved = resolvedConfig(config);
  const mapConfig = resolved.map;
  const random = mulberry32(seed);

  let best = null;
  let bestScore = Infinity;

  for (let attempt = 1; attempt <= mapConfig.maxAttempts; attempt += 1) {
    const map = buildRawMap(resolved.cols, resolved.rows, random, resolved);
    // The centrepiece pattern is applied before validation, so a shortcut or a
    // granite plug can never slip through unchecked.
    const p1 = analysisFor(map, resolved, 0);
    const p2 = analysisFor(map, resolved, 1);
    const playable =
      routeIsPlayable(p1, mapConfig) &&
      routeIsPlayable(p2, mapConfig) &&
      p1.detourExtraCells >= mapConfig.minDetourExtraCells &&
      p2.detourExtraCells >= mapConfig.minDetourExtraCells;

    const score = routeScore(p1, mapConfig) + routeScore(p2, mapConfig);
    if (score < bestScore) {
      bestScore = score;
      best = { ...map, seed, attempts: attempt, p1, p2 };
    }
    if (playable) {
      return {
        ...map,
        seed,
        attempts: attempt,
        pathSeconds: p1.pathSeconds,
        pathSecondsP2: p2.pathSeconds,
        pathCells: p1.pathCells,
        detourExtraCells: p1.detourExtraCells,
        gates: p1.gates,
      };
    }
  }

  // No random attempt satisfied the route band. Fall back to the carved cross
  // tunnels, which are guaranteed to connect both spawns to both gates; a
  // pattern is still applied but its shortcuts cannot break connectivity.
  const map = buildFallbackMap(resolved);
  const p1 = analysisFor(map, resolved, 0);
  const p2 = analysisFor(map, resolved, 1);
  return {
    ...map,
    seed,
    attempts: mapConfig.maxAttempts + 1,
    pathSeconds: p1.pathSeconds,
    pathSecondsP2: p2.pathSeconds,
    pathCells: p1.pathCells,
    detourExtraCells: p1.detourExtraCells,
    gates: p1.gates,
    fallback: true,
    bestAttempt: best ? best.attempts : null,
    bestScore,
  };
}

/**
 * Strict 180° symmetry, with one documented exception: the Taiji centrepiece
 * swaps soil and granite under rotation (its poles are top/bottom). Callers pass
 * `allowTaijiSwap` for maps whose `pattern` is `taiji`.
 */
export function isSymmetric(map, { allowTaijiSwap = false } = {}) {
  const { cols, rows, cells } = map;
  const swap = new Set([
    `${BLOCK.SOIL},${BLOCK.GRANITE}`,
    `${BLOCK.GRANITE},${BLOCK.SOIL}`,
  ]);
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const a = cells[cellIndex(col, row, cols)];
      const b = cells[cellIndex(cols - 1 - col, rows - 1 - row, cols)];
      if (a === b) continue;
      if (allowTaijiSwap && swap.has(`${a},${b}`)) continue;
      return false;
    }
  }
  return true;
}
