import test from 'node:test';
import assert from 'node:assert/strict';

import { BLOCK, CONFIG } from '../shared/config.js';
import { Game } from '../server/game.js';
import { cellIndex } from '../server/map.js';

const makeMap = (cols = 12, rows = 28, fill = BLOCK.EMPTY) => ({
  cols,
  rows,
  cells: new Array(cols * rows).fill(fill),
});

const testConfig = (overrides = {}) => ({
  ...CONFIG,
  cols: 12,
  rows: 28,
  startCols: [0, 11],
  playerRows: [13, 14],
  goalCols: [11, 0],
  countdownSeconds: 0,
  matchSeconds: 100,
  energy: {
    start: 50,
    max: 100,
    regenPerSecond: 0,
    perBlock: 2,
    perBlastBlock: 1,
  },
  ...overrides,
});

const newGame = ({ map = makeMap(), config = testConfig(), names = ['P1', 'P2'] } = {}) =>
  new Game({
    map,
    players: names.map((name) => ({ name })),
    config,
  });

const luckyGame = ({
  map = makeMap(),
  config = testConfig(),
  random = () => 0,
  names = ['P1', 'P2'],
} = {}) =>
  new Game({
    map,
    players: names.map((name) => ({ name })),
    config,
    random,
  });

const set = (map, col, row, block) => {
  map.cells[cellIndex(col, row, map.cols)] = block;
};

const get = (game, col, row) => game.map.cells[cellIndex(col, row, game.map.cols)];

const advance = (game, seconds, dt = 0.02) => {
  const steps = Math.max(1, Math.ceil(seconds / dt));
  for (let i = 0; i < steps; i += 1) game.update(dt);
};

const advanceUntil = (game, predicate, maxSeconds = 8, dt = 0.02) => {
  const steps = Math.ceil(maxSeconds / dt);
  for (let i = 0; i < steps; i += 1) {
    game.update(dt);
    if (predicate()) return true;
  }
  return false;
};

const close = (actual, expected, tolerance = 0.02) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

test('a zero countdown starts the match immediately', () => {
  const game = newGame();
  assert.equal(game.phase, 'playing');
  assert.equal(game.timeLeft, 100);
});

test('countdown blocks actions until it ends', () => {
  const game = newGame({ config: testConfig({ countdownSeconds: 1, matchSeconds: 10 }) });
  assert.equal(game.phase, 'countdown');
  game.setDirection(0, 'right');
  assert.equal(game.getPlayer(0).x, 0.5);
  game.update(1);
  assert.equal(game.phase, 'playing');
  assert.ok(game.takeEvents().find((item) => item.type === 'matchStart'));
});

test('movement is continuous rather than cell snapped', () => {
  const game = newGame();
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 0.5);
  close(player.x, 0.5 + CONFIG.moveSpeed * 0.5, 0.03);
  assert.notEqual(player.x, Math.round(player.x));
  assert.equal(player.y, 13.5);
});

test('lane assist centres the miner in a one-cell tunnel', () => {
  const game = newGame();
  const player = game.getPlayer(0);
  player.y = 13.9;
  game.setDirection(0, 'right');
  advance(game, 0.25);
  close(player.y, 13.5, 0.03);
});

test('solid blocks stop the collision box flush against their face', () => {
  const map = makeMap();
  set(map, 3, 13, BLOCK.BEDROCK);
  const game = newGame({ map });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 2);
  assert.ok(player.x < 3);
  close(player.x, 3 - CONFIG.playerHalfSize, 0.01);
  assert.equal(player.mining, null);
  assert.equal(get(game, 3, 13), BLOCK.BEDROCK);
});

test('facing a block mines it automatically while the direction is held', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.SOIL);
  const game = newGame({ map });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 0.2);
  assert.ok(player.mining);
  assert.equal(player.mining.block, BLOCK.SOIL);

  advance(game, 1.4);
  assert.equal(get(game, 1, 13), BLOCK.EMPTY);
  assert.equal(player.stats.blocksMined, 1);
  // Holding the direction carries the miner through the opening afterwards.
  assert.ok(player.x > 1.5);
});

test('mining continues after release and does not auto-step into the cleared cell', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.GRANITE);
  const game = newGame({ map });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 0.6);
  const heldX = player.x;
  assert.ok(player.mining);
  assert.ok(heldX < 1);

  game.setDirection(0, null);
  advance(game, 3);
  assert.equal(get(game, 1, 13), BLOCK.EMPTY);
  assert.equal(player.stats.blocksMined, 1);
  close(player.x, heldX, 1e-9);
  assert.ok(player.x < 1);
});

test('turning away cancels a dig and can start a different block', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.GRANITE);
  set(map, 0, 12, BLOCK.SOIL);
  const game = newGame({ map });
  const player = game.getPlayer(0);

  game.setDirection(0, 'right');
  advance(game, 0.8);
  assert.equal(player.mining.block, BLOCK.GRANITE);
  assert.ok(player.mining.elapsed > 0.4);

  game.setDirection(0, 'up');
  advance(game, 0.15);
  assert.ok(player.mining);
  assert.equal(player.mining.block, BLOCK.SOIL);
  assert.ok(player.mining.elapsed < 0.2);
  assert.equal(get(game, 1, 13), BLOCK.GRANITE);

  game.setDirection(0, null);
  advance(game, 2);
  assert.equal(get(game, 0, 12), BLOCK.EMPTY);
  assert.equal(get(game, 1, 13), BLOCK.GRANITE);
  assert.equal(player.stats.blocksMined, 1);
});

test('bedrock cannot be mined or walked through', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.BEDROCK);
  const game = newGame({ map });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 1);
  assert.equal(player.mining, null);
  assert.equal(get(game, 1, 13), BLOCK.BEDROCK);
  assert.ok(player.x < 1);
});

test('the middle of the rival baseline is not a goal', () => {
  const game = newGame();
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advanceUntil(game, () => player.x > 11.5, 5);
  assert.ok(player.x > 11.5);
  assert.equal(Math.floor(player.y), 13);
  assert.equal(game.phase, 'playing');
  assert.equal(game.winner, null);
  assert.ok(game.snapshot().players[0].progress > 0);
});

test('breaching an upper gate wins the match', () => {
  const game = newGame();
  const player = game.getPlayer(0);
  game.setDirection(0, 'up');
  advanceUntil(game, () => player.y <= 3.55, 5);
  game.setDirection(0, 'right');
  assert.ok(advanceUntil(game, () => game.phase === 'finished', 5));
  assert.equal(game.winner, 0);
  assert.equal(game.reason, 'breach');
  assert.equal(game.gate, 'upper');
  assert.equal(game.snapshot().players[0].progress, 1);
});

test('timeout awards the player whose route is further along', () => {
  const game = newGame({ config: testConfig({ matchSeconds: 0.4 }) });
  game.setDirection(0, 'right');
  advance(game, 1);
  assert.equal(game.phase, 'finished');
  assert.equal(game.reason, 'timeout');
  assert.equal(game.winner, 0);
});

test('timeout is a draw when both routes are level', () => {
  const game = newGame({ config: testConfig({ matchSeconds: 0.1 }) });
  advance(game, 0.5);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winner, 'draw');
  assert.equal(game.gate, null);
});

test('Build places several barricades near the rival and spends resources', () => {
  const game = newGame();
  const result = game.castSkill(0, 'build', {
    cells: [
      { col: 9, row: 13 },
      { col: 9, row: 14 },
      { col: 10, row: 13 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.cells.length, 3);
  assert.equal(get(game, 9, 13), BLOCK.BARRICADE);
  assert.equal(get(game, 9, 14), BLOCK.BARRICADE);
  assert.equal(get(game, 10, 13), BLOCK.BARRICADE);
  assert.equal(game.getPlayer(0).energy, 15);
  assert.equal(game.getPlayer(0).cooldowns.build, 16);
  assert.equal(game.getPlayer(0).stats.skillsUsed, 1);
});

test('Build rejects the whole cast without spending on an invalid cell', () => {
  const game = newGame();
  const result = game.castSkill(0, 'build', {
    cells: [
      { col: 9, row: 13 },
      { col: 1, row: 1 },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'target');
  assert.equal(get(game, 9, 13), BLOCK.EMPTY);
  assert.equal(game.getPlayer(0).energy, 50);

  const onPlayer = game.castSkill(0, 'build', { cells: [{ col: 11, row: 14 }] });
  assert.equal(onPlayer.ok, false);
  assert.equal(onPlayer.error, 'target');
  assert.equal(game.getPlayer(0).energy, 50);

  const tooMany = game.castSkill(0, 'build', {
    cells: [
      { col: 9, row: 12 },
      { col: 9, row: 13 },
      { col: 9, row: 14 },
      { col: 10, row: 13 },
    ],
  });
  assert.equal(tooMany.ok, false);
});

test('Build cannot seal a scoring gate cell', () => {
  const game = newGame();
  const rival = game.getPlayer(1);
  game.setDirection(1, 'up');
  advanceUntil(game, () => rival.y <= 0.55, 5);
  const result = game.castSkill(0, 'build', { cells: [{ col: 11, row: 1 }] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'target');
});

test('Blast clears a 3×3 area, spares bedrock, and does not move the miner', () => {
  const map = makeMap();
  for (let col = 1; col <= 3; col += 1) {
    for (let row = 12; row <= 14; row += 1) set(map, col, row, BLOCK.SOIL);
  }
  set(map, 2, 13, BLOCK.BEDROCK);
  const game = newGame({ map });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 0.1);
  const xBefore = player.x;

  const result = game.castSkill(0, 'blast', { target: { col: 2, row: 13 } });
  assert.equal(result.ok, true);
  assert.equal(result.cells.length, 8);
  assert.equal(get(game, 2, 13), BLOCK.BEDROCK);
  assert.equal(get(game, 1, 12), BLOCK.EMPTY);
  assert.equal(get(game, 3, 14), BLOCK.EMPTY);
  close(player.x, xBefore, 1e-9);
  assert.equal(player.mining, null);
  assert.equal(player.stats.blocksMined, 8);
});

test('Blast fails without spending out of range or with nothing breakable', () => {
  const game = newGame();
  const outOfRange = game.castSkill(0, 'blast', { target: { col: 11, row: 27 } });
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error, 'target');
  assert.equal(game.getPlayer(0).energy, 50);

  const empty = game.castSkill(0, 'blast', { target: { col: 2, row: 13 } });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'target');
  assert.equal(game.getPlayer(0).energy, 50);
});

test('Cryo arms a telegraph and catches a stationary rival after the delay', () => {
  const game = newGame();
  const rival = game.getPlayer(1);
  const result = game.castSkill(0, 'cryo', { target: { col: 10, row: 14 } });
  assert.equal(result.ok, true);
  const armed = game.snapshot();
  assert.equal(armed.effects.cryo.length, 1);
  assert.ok(armed.effects.cryo[0].remainingMs > 0);
  assert.equal(rival.buffs.cryo, 0);

  advance(game, 0.5);
  assert.ok(rival.buffs.cryo > 0);
  const burst = game.takeEvents().find((event) => event.type === 'cryoBurst');
  assert.ok(burst);
  assert.equal(burst.hit, true);
});

test('Cryo can miss if the rival leaves the burst radius', () => {
  const game = newGame();
  const rival = game.getPlayer(1);
  assert.equal(game.castSkill(0, 'cryo', { target: { col: 8, row: 14 } }).ok, true);
  game.setDirection(1, 'up');
  advance(game, 0.5);
  assert.equal(rival.buffs.cryo, 0);
  const burst = game.takeEvents().find((event) => event.type === 'cryoBurst');
  assert.ok(burst);
  assert.equal(burst.hit, false);
});

test('Cryo cannot be aimed away from the rival', () => {
  const game = newGame();
  const result = game.castSkill(0, 'cryo', { target: { col: 0, row: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'target');
  assert.equal(game.getPlayer(0).energy, 50);
});

test('Overdrive speeds up both movement and mining, then expires', () => {
  // Movement in open tunnel.
  const normalMove = newGame();
  normalMove.setDirection(0, 'right');
  advance(normalMove, 0.5);
  const normalX = normalMove.getPlayer(0).x;

  const boostedMove = newGame();
  assert.equal(boostedMove.castSkill(0, 'overdrive', {}).ok, true);
  boostedMove.setDirection(0, 'right');
  advance(boostedMove, 0.5);
  assert.ok(boostedMove.getPlayer(0).x > normalX + 0.2);

  // Mining against the same block.
  const mineMap = makeMap();
  set(mineMap, 1, 13, BLOCK.SOIL);
  const normalDig = newGame({ map: { ...mineMap, cells: [...mineMap.cells] } });
  normalDig.setDirection(0, 'right');
  advance(normalDig, 0.35);
  const normalProgress = normalDig.getPlayer(0).mining?.elapsed || 0;

  const boostedDig = newGame({ map: { ...mineMap, cells: [...mineMap.cells] } });
  assert.equal(boostedDig.castSkill(0, 'overdrive', {}).ok, true);
  boostedDig.setDirection(0, 'right');
  advance(boostedDig, 0.35);
  assert.ok((boostedDig.getPlayer(0).mining?.elapsed || 0) > normalProgress * 1.3);
  assert.ok(boostedDig.snapshot().players[0].buffs.overdrive > 4);

  advance(boostedDig, 6);
  assert.equal(boostedDig.getPlayer(0).buffs.overdrive, 0);
});

test('skills reject insufficient energy, cooldowns, and wrong phases', () => {
  const game = newGame();
  game.getPlayer(0).energy = 0;
  assert.equal(game.castSkill(0, 'overdrive', {}).error, 'energy');

  game.getPlayer(0).energy = 100;
  assert.equal(game.castSkill(0, 'overdrive', {}).ok, true);
  assert.equal(game.castSkill(0, 'overdrive', {}).error, 'cooldown');

  const countdown = newGame({ config: testConfig({ countdownSeconds: 3 }) });
  const result = countdown.castSkill(0, 'overdrive', {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'phase');
});

test('snapshots report continuous positions, mining progress, and map changes once', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.SOIL);
  const game = newGame({ map });
  game.setDirection(0, 'right');
  advance(game, 1.4);

  const first = game.snapshot();
  assert.equal(first.blocks.length, 1);
  assert.equal(first.blocks[0].block, BLOCK.EMPTY);
  assert.ok(first.players[0].x > 1);
  assert.equal(first.players[0].y, 13.5);
  // Per-tick snapshots no longer carry lifetime stats; they stay on the game.
  assert.equal(first.players[0].stats, undefined);
  assert.equal(game.getPlayer(0).stats.blocksMined, 1);
  assert.deepEqual(first.players[0].buffs, {});

  const second = game.snapshot();
  assert.equal(second.blocks.length, 0);
  assert.ok(second.seq > first.seq);
});

test('players can disconnect and later resume', () => {
  const game = newGame();
  game.setConnected(0, false);
  assert.equal(game.setDirection(0, 'right').error, 'inactive');
  game.update(0.5);
  assert.equal(game.getPlayer(0).x, 0.5);

  game.setConnected(0, true);
  game.setDirection(0, 'right');
  advance(game, 0.2);
  assert.ok(game.getPlayer(0).x > 0.5);
});

/* ── Lucky blocks ───────────────────────────────────────────────────── */

test('a lucky block digs quickly and Soften turns a 7×7 patch to soil', () => {
  const map = makeMap();
  for (let col = 0; col <= 4; col += 1) {
    for (let row = 10; row <= 16; row += 1) set(map, col, row, BLOCK.GRANITE);
  }
  set(map, 0, 13, BLOCK.EMPTY);
  set(map, 1, 13, BLOCK.LUCKY);

  const game = luckyGame({ map, random: () => 0.85 });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 0.35);

  assert.equal(get(game, 1, 13), BLOCK.EMPTY);
  const lucky = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(lucky);
  assert.equal(lucky.effect, 'soften');
  assert.equal(lucky.kind, 'terrain');
  assert.equal(lucky.good, true);
  assert.equal(get(game, 2, 14), BLOCK.SOIL);
  // Baseline columns are never rewritten by a gamble.
  assert.equal(get(game, 0, 12), BLOCK.GRANITE);
  assert.ok(player.stats.blocksMined >= 1);
});

test('Echo Form breaks two blocks in a single dig', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.LUCKY);
  set(map, 2, 13, BLOCK.GRANITE);
  set(map, 3, 13, BLOCK.GRANITE);
  set(map, 4, 13, BLOCK.GRANITE);

  const game = luckyGame({ map, random: () => 0.05 });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  advance(game, 0.4);

  assert.equal(get(game, 1, 13), BLOCK.EMPTY);
  assert.ok(player.buffs.echo > 0);
  // The lucky dig itself rolls Echo and instantly clears the next face.
  assert.equal(get(game, 2, 13), BLOCK.EMPTY);

  assert.ok(advanceUntil(game, () => get(game, 3, 13) === BLOCK.EMPTY, 6));
  assert.equal(get(game, 4, 13), BLOCK.EMPTY);
  const breaks = game.takeEvents().filter((event) => event.type === 'blockBreak');
  assert.ok(breaks.some((event) => event.method === 'echo'));
});

test('Harden turns the surrounding 3×3 into obsidian', () => {
  const map = makeMap();
  for (let dc = -1; dc <= 1; dc += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      set(map, 1 + dc, 13 + dr, BLOCK.SOIL);
    }
  }
  set(map, 0, 13, BLOCK.EMPTY);
  set(map, 1, 13, BLOCK.LUCKY);

  const game = luckyGame({ map, random: () => 0.97 });
  game.setDirection(0, 'right');
  advance(game, 0.4);

  const lucky = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(lucky);
  assert.equal(lucky.effect, 'harden');
  assert.equal(lucky.kind, 'terrain');
  assert.equal(lucky.good, false);
  assert.equal(get(game, 2, 14), BLOCK.OBSIDIAN);
  assert.equal(get(game, 0, 12), BLOCK.SOIL);
});

test('Wall turns the miner column into obsidian except their own cell', () => {
  const map = makeMap();
  set(map, 2, 13, BLOCK.LUCKY);

  const game = luckyGame({ map, random: () => 0.9 });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  assert.ok(advanceUntil(game, () => get(game, 2, 13) === BLOCK.EMPTY, 3));

  const lucky = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(lucky);
  assert.equal(lucky.effect, 'wall');
  assert.equal(lucky.kind, 'terrain');
  assert.equal(Math.floor(player.x), 1);
  assert.equal(get(game, 1, 5), BLOCK.OBSIDIAN);
  assert.equal(get(game, 1, 12), BLOCK.OBSIDIAN);
  assert.equal(get(game, 1, 13), BLOCK.EMPTY);
  assert.equal(get(game, 0, 5), BLOCK.EMPTY);
});

test('Invert reverses movement and facing for a timed window', () => {
  const map = makeMap();
  set(map, 2, 13, BLOCK.LUCKY);

  const rolls = [0.25, 0.1];
  const game = luckyGame({ map, random: () => rolls.shift() ?? 0.5 });
  const player = game.getPlayer(0);
  game.setDirection(0, 'right');
  assert.ok(advanceUntil(game, () => player.buffs.invert > 0, 3));

  const lucky = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(lucky);
  assert.equal(lucky.effect, 'invert');
  assert.equal(lucky.kind, 'debuff');
  assert.equal(lucky.target, 0);

  const xBefore = player.x;
  advance(game, 0.15);
  assert.equal(player.facing, 'left');
  assert.ok(player.x < xBefore);
});

/* ── Cheat mode ─────────────────────────────────────────────────────── */

test('cheat mode instantly mines bedrock and hard-freezes the rival', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.BEDROCK);
  set(map, 2, 13, BLOCK.BEDROCK);
  const game = newGame({ map });
  const rival = game.getPlayer(1);

  const enabled = game.setCheat(0, true);
  assert.equal(enabled.ok, true);
  assert.ok(rival.buffs.freeze > 0);
  assert.ok(game.takeEvents().some((event) => event.type === 'cheat' && event.enabled));

  game.setDirection(0, 'right');
  game.setDirection(1, 'right');
  advance(game, 0.1);
  assert.equal(get(game, 1, 13), BLOCK.EMPTY);
  assert.equal(rival.x, 11.5);

  assert.ok(advanceUntil(game, () => get(game, 2, 13) === BLOCK.EMPTY, 2));

  advance(game, 6.2);
  assert.equal(rival.buffs.freeze, 0);
  assert.ok(rival.x > 11.5);
});

test('turning cheat mode off restores normal mining rules', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.BEDROCK);
  const game = newGame({ map });

  assert.equal(game.setCheat(0, true).ok, true);
  assert.equal(game.setCheat(0, false).ok, true);
  assert.equal(game.getPlayer(0).cheat, false);

  game.setDirection(0, 'right');
  advance(game, 0.5);
  assert.equal(get(game, 1, 13), BLOCK.BEDROCK);
  assert.equal(game.getPlayer(0).mining, null);
});

/* ── Buffs, debuffs and tradeoffs ───────────────────────────────────── */

test('lucky debuffs usually land on the rival', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.LUCKY);
  const game = luckyGame({ map, random: () => 0.25 });
  game.setDirection(0, 'right');
  advance(game, 0.4);

  const effect = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(effect);
  assert.equal(effect.effect, 'invert');
  assert.equal(effect.kind, 'debuff');
  assert.equal(effect.target, 1);
  assert.ok(game.getPlayer(1).buffs.invert > 0);
  assert.equal(game.getPlayer(0).buffs.invert, 0);
});

test('Luck guarantees buffs for the next two lucky blocks', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.LUCKY);
  set(map, 2, 13, BLOCK.GRANITE);
  set(map, 3, 13, BLOCK.LUCKY);

  const game = luckyGame({ map, random: () => 0 });
  const player = game.getPlayer(0);
  assert.equal(game.applyDevEffect(0, 'luck', 'self').ok, true);
  assert.equal(player.luckCharges, 2);

  game.setDirection(0, 'right');
  advance(game, 0.4);
  const first = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(first);
  assert.equal(first.kind, 'buff');
  assert.equal(first.target, 0);
  assert.equal(player.luckCharges, 1);

  assert.ok(advanceUntil(game, () => get(game, 3, 13) === BLOCK.EMPTY, 6));
  const second = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(second);
  assert.equal(second.kind, 'buff');
  assert.equal(second.target, 0);
  assert.equal(player.luckCharges, 0);
});

test('Misfortune forces lucky results to debuff its owner', () => {
  const map = makeMap();
  set(map, 1, 13, BLOCK.LUCKY);

  const game = luckyGame({ map, random: () => 0 });
  assert.equal(game.applyDevEffect(0, 'misfortune', 'self').ok, true);
  game.takeEvents();

  game.setDirection(0, 'right');
  advance(game, 0.4);
  const effect = game.takeEvents().find((event) => event.type === 'effect');
  assert.ok(effect);
  assert.equal(effect.kind, 'debuff');
  assert.equal(effect.target, 0);
  assert.equal(effect.effect, 'invert');
  assert.ok(game.getPlayer(0).buffs.invert > 0);
});

test('Reject blocks debuffs and Mundane blocks both directions', () => {
  const game = newGame();
  const player = game.getPlayer(0);
  player.energy = 80;

  assert.equal(game.applyDevEffect(0, 'reject', 'self').ok, true);
  const rejected = game.applyDevEffect(0, 'drain', 'self');
  assert.equal(rejected.blocked, true);
  assert.equal(player.energy, 80);

  const game2 = newGame();
  assert.equal(game2.applyDevEffect(0, 'mundane', 'self').ok, true);
  assert.equal(game2.applyDevEffect(0, 'echo', 'self').blocked, true);
  assert.equal(game2.applyDevEffect(0, 'invert', 'self').blocked, true);
  assert.equal(game2.getPlayer(0).buffs.echo, 0);
});

test('Drain empties all energy instantly', () => {
  const game = newGame();
  game.getPlayer(0).energy = 90;
  assert.equal(game.applyDevEffect(1, 'drain', 'rival').ok, true);
  assert.equal(game.getPlayer(0).energy, 0);
});

test('Lag lengthens skill cooldowns', () => {
  const game = newGame();
  assert.equal(game.applyDevEffect(0, 'lag', 'self').ok, true);
  assert.equal(game.castSkill(0, 'overdrive', {}).ok, true);
  assert.ok(game.getPlayer(0).cooldowns.overdrive > 18 * 1.7);
});

test('QTE freeze immobilises until enough direction taps thaw it', () => {
  const game = newGame();
  const victim = game.getPlayer(1);
  assert.equal(game.applyDevEffect(0, 'freeze', 'rival').ok, true);
  assert.ok(victim.buffs.qte > 0);
  assert.equal(victim.thawNeeded, 8);

  game.setDirection(1, 'left');
  advance(game, 1);
  assert.equal(victim.x, 11.5);
  assert.ok(game.snapshot().players[1].thaw);

  for (let i = 0; i < 7; i += 1) game.tapThaw(1);
  advance(game, 0.1);
  assert.equal(victim.x, 11.5);
  assert.equal(game.tapThaw(1).thawed, true);
  advance(game, 0.2);
  assert.ok(victim.x < 11.5);
});

test('QTE freeze also expires on its own timer', () => {
  const game = newGame();
  const victim = game.getPlayer(1);
  assert.equal(game.applyDevEffect(0, 'freeze', 'rival').ok, true);
  game.setDirection(1, 'left');
  advance(game, 6.2);
  assert.equal(victim.buffs.qte, 0);
  assert.ok(victim.x < 11.5);
});

test('Hijack locks direction while the auto-drill keeps running', () => {
  const game = newGame();
  const player = game.getPlayer(0);
  assert.equal(game.applyDevEffect(0, 'hijack', 'self').ok, true);
  assert.equal(player.heldDir, 'right');

  assert.equal(game.setDirection(0, 'left').locked, true);
  assert.equal(player.heldDir, 'right');
  advance(game, 0.3);
  assert.ok(player.x > 0.5);

  advance(game, 10.2);
  assert.equal(player.buffs.hijack, 0);
  game.setDirection(0, 'left');
  assert.equal(player.heldDir, 'left');
});

test('Balance speeds up the trailing miner and slows the leader', () => {
  const trailingMap = makeMap();
  set(trailingMap, 1, 13, BLOCK.GRANITE);
  const trailing = newGame({ map: trailingMap });
  trailing.getPlayer(1).x = 6.5;
  assert.equal(trailing.applyDevEffect(0, 'balance', 'self').ok, true);
  trailing.setDirection(0, 'right');
  advance(trailing, 1);
  assert.equal(get(trailing, 1, 13), BLOCK.EMPTY);

  const leaderMap = makeMap();
  set(leaderMap, 7, 13, BLOCK.GRANITE);
  const leader = newGame({ map: leaderMap });
  leader.getPlayer(0).x = 6.5;
  assert.equal(leader.applyDevEffect(0, 'balance', 'self').ok, true);
  leader.setDirection(0, 'right');
  advance(leader, 1);
  assert.equal(get(leader, 7, 13), BLOCK.GRANITE);
});

test('Exam rewards correct answers and punishes wrong ones', () => {
  const game = newGame();
  assert.equal(game.applyDevEffect(0, 'exam', 'self').ok, true);
  const exam = game.getPlayer(0).exam;
  assert.ok(exam);
  assert.equal(exam.questions.length, 3);
  assert.equal(exam.questions[0].options.length, 4);

  const snapshot = game.snapshot();
  assert.equal(snapshot.players[0].exam.id, exam.id);
  assert.equal(snapshot.players[0].exam.questions, undefined);
  assert.equal(snapshot.players[0].exam.answers, undefined);
  const payload = game.examPayload(0);
  assert.equal(payload.questions.length, 3);
  assert.equal(payload.questions[0].options.length, 4);

  const passed = game.submitExam(0, exam.answers.slice());
  assert.equal(passed.ok, true);
  assert.equal(passed.passed, true);
  assert.equal(game.getPlayer(0).exam, null);
  assert.ok(game.getPlayer(0).buffs.examPass > 0);
  assert.ok(game.takeEvents().some((event) => event.type === 'examResult' && event.passed));

  const failing = newGame();
  assert.equal(failing.applyDevEffect(0, 'exam', 'self').ok, true);
  const wrong = failing.getPlayer(0).exam.answers.map((answer) => (answer + 1) % 4);
  const failed = failing.submitExam(0, wrong);
  assert.equal(failed.passed, false);
  assert.ok(failing.getPlayer(0).buffs.examFail > 0);
});

test('Exam times out into the failure debuff', () => {
  const game = newGame();
  assert.equal(game.applyDevEffect(0, 'exam', 'self').ok, true);
  advance(game, 10.5);
  assert.equal(game.getPlayer(0).exam, null);
  assert.ok(game.getPlayer(0).buffs.examFail > 0);
});

test('Lockdown seals both gates and blocks entry until it expires', () => {
  const game = newGame();
  assert.equal(game.applyDevEffect(0, 'lockdown', 'self').ok, true);
  assert.ok(game.lockdown > 0);
  assert.ok(game.snapshot().lockdownMs > 0);

  const player = game.getPlayer(0);
  player.x = 10.5;
  player.y = 3.5;
  player.lastCol = 10;
  player.lastRow = 3;
  game.setDirection(0, 'right');
  advance(game, 0.5);
  assert.ok(player.x < 11);
  assert.equal(game.phase, 'playing');

  player.x = 11.5;
  game.update(0.02);
  assert.equal(game.phase, 'playing');

  advance(game, 8.5);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winner, 0);
});
