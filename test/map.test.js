import test from 'node:test';
import assert from 'node:assert/strict';

import { BLOCK, BLOCK_TYPES, CONFIG } from '../shared/config.js';
import {
  analyzeMap,
  cellIndex,
  generateMap,
  isSymmetric,
  mulberry32,
} from '../server/map.js';

const validBlockIds = new Set([BLOCK.EMPTY, ...BLOCK_TYPES.map((block) => block.id)]);

test('generated maps are 180-degree rotationally symmetric', () => {
  for (const seed of [1, 2, 3, 7, 42, 2026]) {
    const map = generateMap({ seed });
    assert.equal(map.cols, CONFIG.cols);
    assert.equal(map.rows, CONFIG.rows);
    assert.equal(isSymmetric(map), true, `seed ${seed} should be symmetric`);
  }
});

test('spawn pockets and both gate alcoves are clear', () => {
  const map = generateMap({ seed: 99 });
  const [p1Col, p1Row] = [CONFIG.startCols[0], CONFIG.playerRows[0]];
  const [p2Col, p2Row] = [CONFIG.startCols[1], CONFIG.playerRows[1]];
  assert.equal(map.cells[cellIndex(p1Col, p1Row, map.cols)], BLOCK.EMPTY);
  assert.equal(map.cells[cellIndex(p2Col, p2Row, map.cols)], BLOCK.EMPTY);

  for (const [low, high] of CONFIG.goalBands) {
    for (let row = low; row <= high; row += 1) {
      for (let depth = 0; depth < CONFIG.goalDepth; depth += 1) {
        assert.equal(
          map.cells[cellIndex(depth, row, map.cols)],
          BLOCK.EMPTY,
          `left gate cell (${depth}, ${row}) should be open`,
        );
        assert.equal(
          map.cells[cellIndex(map.cols - 1 - depth, row, map.cols)],
          BLOCK.EMPTY,
          `right gate cell (${map.cols - 1 - depth}, ${row}) should be open`,
        );
      }
    }
  }
});

test('the non-gate middle of each baseline is sealed with bedrock', () => {
  const map = generateMap({ seed: 99 });
  const sealedRows = [];
  for (let row = 0; row < map.rows; row += 1) {
    const inGate = CONFIG.goalBands.some(([low, high]) => row >= low && row <= high);
    const inPocket =
      row >= CONFIG.startPocket.rows[0] && row <= CONFIG.startPocket.rows[1];
    if (!inGate && !inPocket) sealedRows.push(row);
  }
  assert.ok(sealedRows.includes(8));
  for (const row of sealedRows) {
    assert.equal(map.cells[cellIndex(0, row, map.cols)], BLOCK.BEDROCK);
    assert.equal(map.cells[cellIndex(map.cols - 1, row, map.cols)], BLOCK.BEDROCK);
  }
});

test('both gates are reachable from both spawns with a playable detour', () => {
  for (const seed of [1, 3, 42, 2026]) {
    const map = generateMap({ seed });
    const routes = [
      analyzeMap(map, {
        startCol: CONFIG.startCols[0],
        startRow: CONFIG.playerRows[0],
        goalCol: CONFIG.goalCols[0],
        goalBands: CONFIG.goalBands,
        moveSeconds: 1 / CONFIG.moveSpeed,
      }),
      analyzeMap(map, {
        startCol: CONFIG.startCols[1],
        startRow: CONFIG.playerRows[1],
        goalCol: CONFIG.goalCols[1],
        goalBands: CONFIG.goalBands,
        moveSeconds: 1 / CONFIG.moveSpeed,
      }),
    ];

    for (const route of routes) {
      assert.equal(route.gates.length, 2);
      assert.ok(route.gates[0].reachable, `upper gate should be reachable (seed ${seed})`);
      assert.ok(route.gates[1].reachable, `lower gate should be reachable (seed ${seed})`);
      assert.ok(route.pathSeconds > 0);
      assert.ok(
        route.detourExtraCells >= CONFIG.map.minDetourExtraCells,
        `seed ${seed} should require a detour`,
      );
    }

    assert.ok(map.pathSeconds >= CONFIG.map.minPathSeconds);
    assert.ok(map.pathSeconds <= CONFIG.map.maxPathSeconds);
    assert.ok(map.pathSecondsP2 >= CONFIG.map.minPathSeconds);
    assert.ok(map.pathSecondsP2 <= CONFIG.map.maxPathSeconds);
  }
});

test('structured bedrock obstacles create meaningful obstacle pressure', () => {
  const map = generateMap({ seed: 7 });
  const bedrock = map.cells.filter((block) => block === BLOCK.BEDROCK).length;
  const empty = map.cells.filter((block) => block === BLOCK.EMPTY).length;
  assert.ok(bedrock > 300, `expected dense bedrock, got ${bedrock}`);
  assert.ok(empty >= 64, `spawn pockets and gate alcoves should be open, got ${empty}`);
});

test('the same seed produces the same map', () => {
  const a = generateMap({ seed: 123456 });
  const b = generateMap({ seed: 123456 });
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.pathSeconds, b.pathSeconds);
});

test('only known block ids are generated', () => {
  const map = generateMap({ seed: 777 });
  for (const cell of map.cells) {
    assert.ok(validBlockIds.has(cell), `unexpected block id ${cell}`);
  }
});

test('analyzeMap rejects maps split by bedrock', () => {
  const cols = 5;
  const rows = 3;
  const cells = new Array(cols * rows).fill(BLOCK.EMPTY);
  for (let row = 0; row < rows; row += 1) {
    cells[cellIndex(2, row, cols)] = BLOCK.BEDROCK;
  }
  const map = { cols, rows, cells };
  const result = analyzeMap(map, { startCol: 0, startRow: 1, goalCol: 4 });
  assert.equal(result.reachable, false);
  assert.equal(result.pathSeconds, Infinity);
});

test('analyzeMap reports each gate separately', () => {
  const cols = 8;
  const rows = 28;
  const map = { cols, rows, cells: new Array(cols * rows).fill(BLOCK.EMPTY) };
  const result = analyzeMap(map, { startCol: 0, startRow: 13, goalCol: 7 });
  assert.equal(result.reachable, true);
  assert.equal(result.gates.length, 2);
  assert.equal(result.gates[0].band[0], 0);
  assert.equal(result.gates[1].band[0], 21);
  assert.ok(result.gates[0].pathSeconds < result.gates[1].pathSeconds + 1);
});

test('mulberry32 is deterministic and in range', () => {
  const first = mulberry32(123);
  const second = mulberry32(123);
  for (let i = 0; i < 20; i += 1) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
});

test('lucky blocks spawn only in the top and bottom stretches and stay symmetric', () => {
  for (const seed of [1, 7, 42]) {
    const map = generateMap({ seed });
    const lucky = [];
    for (let col = 0; col < map.cols; col += 1) {
      for (let row = 0; row < map.rows; row += 1) {
        if (map.cells[cellIndex(col, row, map.cols)] === BLOCK.LUCKY) {
          lucky.push([col, row]);
        }
      }
    }
    assert.ok(lucky.length > 0, `seed ${seed} should seed lucky blocks`);
    assert.equal(lucky.length % 2, 0, 'lucky blocks are mirrored in pairs');
    for (const [col, row] of lucky) {
      const inTop = row >= 1 && row <= 6;
      const inBottom = row >= 21 && row <= 26;
      assert.ok(inTop || inBottom, `seed ${seed} lucky block at (${col}, ${row}) is off the top/bottom bands`);
      assert.ok(col >= 2 && col <= map.cols - 3, `seed ${seed} lucky block sits on a gate column`);
    }
    assert.equal(isSymmetric(map), true);
  }
});
