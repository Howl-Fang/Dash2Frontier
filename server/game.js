import {
  BLOCK,
  BLOCK_TYPES,
  CONFIG,
  DIRECTIONS,
  LUCKY_EFFECTS,
  LUCKY_EFFECT_ORDER,
  SKILLS,
  distanceToGoalZone,
  goalDirectionForPlayer,
  isGoalRow,
  isGoalTriggerCell,
  oppositeDirection,
} from '../shared/config.js';
import { cellIndex } from './map.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const isDiggable = (block) => block !== BLOCK.EMPTY && block !== BLOCK.BEDROCK;
const isSolid = (block) => block !== BLOCK.EMPTY;

function resolvedConfig(overrides = {}) {
  return {
    ...CONFIG,
    ...overrides,
    energy: { ...CONFIG.energy, ...(overrides.energy || {}) },
    startPocket: { ...CONFIG.startPocket, ...(overrides.startPocket || {}) },
    map: { ...CONFIG.map, ...(overrides.map || {}) },
  };
}

export class Game {
  constructor({ map, players, config = {}, random = Math.random }) {
    if (!map || !Array.isArray(map.cells)) {
      throw new Error('Game requires a map');
    }
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error('Game requires exactly two players');
    }

    this.config = resolvedConfig(config);
    this.random = random;
    this.map = {
      cols: map.cols,
      rows: map.rows,
      cells: [...map.cells],
      seed: map.seed ?? null,
    };
    this.phase = this.config.countdownSeconds > 0 ? 'countdown' : 'playing';
    this.countdownLeft = Math.max(0, this.config.countdownSeconds);
    this.timeLeft = this.config.matchSeconds;
    this.elapsed = 0;
    this.winner = null;
    this.reason = null;
    this.gate = null;
    this.seq = 0;
    this.pendingChanges = [];
    this.pendingEvents = [];
    this.pendingCryo = [];
    this.players = players.map((player, index) => this.#createPlayer(player, index));
    this.startGoalDistances = this.players.map((player) =>
      distanceToGoalZone(this.config, player.index, player.x, player.y),
    );
  }

  #createPlayer(player, index) {
    const energy = this.config.energy;
    const startCol = this.config.startCols[index];
    const startRow = this.config.playerRows[index];
    return {
      index,
      name: player.name,
      connected: true,
      x: startCol + 0.5,
      y: startRow + 0.5,
      facing: goalDirectionForPlayer(index),
      heldDir: null,
      mining: null,
      lastCol: startCol,
      lastRow: startRow,
      stepDistance: 0,
      blockedCooldown: 0,
      energy: energy.start,
      cooldowns: Object.fromEntries(Object.keys(SKILLS).map((skill) => [skill, 0])),
      buffs: { overdrive: 0, cryo: 0, echo: 0, invert: 0, freeze: 0 },
      cheat: false,
      stats: { blocksMined: 0, skillsUsed: 0, cellsMoved: 0 },
    };
  }

  getPlayer(index) {
    return this.players[index];
  }

  setConnected(index, connected) {
    const player = this.players[index];
    if (!player) return;
    player.connected = Boolean(connected);
    if (!player.connected) player.heldDir = null;
  }

  setDirection(index, direction) {
    if (this.phase !== 'playing') return { ok: false, error: 'phase' };
    const player = this.players[index];
    if (!player || !player.connected) return { ok: false, error: 'inactive' };

    if (direction === null) {
      player.heldDir = null;
      return { ok: true };
    }
    if (!DIRECTIONS[direction]) return { ok: false, error: 'direction' };

    // The Invert debuff flips the face as well, so the drill follows the
    // direction the miner actually walks in.
    const facing = player.buffs.invert > 0 ? oppositeDirection(direction) : direction;
    if (player.facing !== facing) {
      // Turning away abandons the current block. The next tick picks the new
      // face in front of the miner, starting from zero progress.
      player.facing = facing;
      player.mining = null;
    }
    player.heldDir = direction;
    return { ok: true };
  }

  /**
   * Hidden cheat mode. Enabling it grants instant mining and bedrock breaking
   * for as long as it stays on, and hard-freezes the rival for a short burst.
   */
  setCheat(index, enabled) {
    const player = this.players[index];
    if (!player) return { ok: false, error: 'inactive', message: 'No miner there.' };
    if (this.phase !== 'playing') {
      return { ok: false, error: 'phase', message: 'The match is not running.' };
    }
    const next = Boolean(enabled);
    if (player.cheat === next) return { ok: true, cheat: next };

    player.cheat = next;
    if (next) {
      const freeze = this.config.cheat?.freezeSeconds ?? 0;
      for (const other of this.players) {
        if (other.index !== index) {
          other.buffs.freeze = Math.max(other.buffs.freeze, freeze);
        }
      }
      this.pendingEvents.push({
        type: 'cheat',
        player: index,
        enabled: true,
        freezeMs: Math.round(freeze * 1000),
      });
    } else {
      this.pendingEvents.push({ type: 'cheat', player: index, enabled: false, freezeMs: 0 });
    }
    return { ok: true, cheat: next };
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || this.phase === 'finished') {
      return;
    }

    if (this.phase === 'countdown') {
      if (this.countdownLeft <= 0) {
        this.phase = 'playing';
        this.pendingEvents.push({ type: 'matchStart' });
        return;
      }
      const before = this.countdownLeft;
      this.countdownLeft = Math.max(0, this.countdownLeft - dt);
      if (before > 0 && this.countdownLeft === 0) {
        this.phase = 'playing';
        this.pendingEvents.push({ type: 'matchStart' });
      }
      return;
    }

    this.timeLeft = Math.max(0, this.timeLeft - dt);
    this.elapsed += dt;

    const energyConfig = this.config.energy;
    for (const player of this.players) {
      for (const skill of Object.keys(player.cooldowns)) {
        player.cooldowns[skill] = Math.max(0, player.cooldowns[skill] - dt);
      }
      player.buffs.overdrive = Math.max(0, player.buffs.overdrive - dt);
      player.buffs.cryo = Math.max(0, player.buffs.cryo - dt);
      player.buffs.echo = Math.max(0, player.buffs.echo - dt);
      player.buffs.invert = Math.max(0, player.buffs.invert - dt);
      player.buffs.freeze = Math.max(0, player.buffs.freeze - dt);
      player.blockedCooldown = Math.max(0, player.blockedCooldown - dt);
      player.energy = Math.min(
        energyConfig.max,
        player.energy + energyConfig.regenPerSecond * dt,
      );
    }

    this.#updateCryoEffects(dt);

    for (const player of this.players) {
      if (!player.connected) continue;
      this.#updatePlayer(player, dt);
      if (this.phase !== 'playing') break;
    }

    if (this.phase === 'playing' && this.timeLeft <= 0) {
      this.#resolveTimeout();
    }
  }

  #updatePlayer(player, dt) {
    // Cheat-mode freeze is a hard stop: no movement, no mining.
    if (player.buffs.freeze > 0) {
      player.mining = null;
      return;
    }

    if (player.heldDir) {
      const effective = player.buffs.invert > 0 ? oppositeDirection(player.heldDir) : player.heldDir;
      const direction = DIRECTIONS[effective];
      if (direction) {
        if (player.facing !== effective) {
          player.facing = effective;
          player.mining = null;
        }
        // Gentle lane centring makes one-cell tunnels forgiving without
        // snapping the player to the grid.
        const assist = this.config.laneAssistSpeed * dt;
        if (direction.dx !== 0) {
          const targetY = Math.round(player.y - 0.5) + 0.5;
          const offset = targetY - player.y;
          if (Math.abs(offset) > 1e-4) {
            this.#moveAxis(player, 'y', clamp(offset, -assist, assist));
          }
        } else {
          const targetX = Math.round(player.x - 0.5) + 0.5;
          const offset = targetX - player.x;
          if (Math.abs(offset) > 1e-4) {
            this.#moveAxis(player, 'x', clamp(offset, -assist, assist));
          }
        }

        const speed = this.config.moveSpeed * this.#moveMultiplier(player);
        const beforeX = player.x;
        const beforeY = player.y;
        if (direction.dx !== 0) {
          this.#moveAxis(player, 'x', direction.dx * speed * dt);
        } else {
          this.#moveAxis(player, 'y', direction.dy * speed * dt);
        }
        const moved = Math.hypot(player.x - beforeX, player.y - beforeY);
        if (moved > 0) {
          player.stepDistance += moved;
          while (player.stepDistance >= 0.9) {
            player.stepDistance -= 0.9;
            this.pendingEvents.push({
              type: 'step',
              player: player.index,
              x: round(player.x, 3),
              y: round(player.y, 3),
              dir: effective,
            });
          }
        }
        this.#noteCellChange(player);
        this.#checkBreach(player);
        if (this.phase !== 'playing') return;
      }
    }

    this.#updateMining(player, dt);
  }

  /**
   * Move along one axis in small substeps. Solid cells stop the collision box
   * flush against their face; no part of the miner can enter a block.
   */
  #moveAxis(player, axis, delta) {
    if (!delta) return false;
    const h = this.config.playerHalfSize;
    const { cols, rows } = this.map;
    const maxX = cols - h;
    const maxY = rows - h;
    const substeps = Math.max(1, Math.ceil(Math.abs(delta) / 0.12));
    const step = delta / substeps;
    let moved = false;

    for (let i = 0; i < substeps; i += 1) {
      if (axis === 'x') {
        let nx = player.x + step;
        let hitEdge = false;
        if (nx < h) {
          nx = h;
          hitEdge = true;
        } else if (nx > maxX) {
          nx = maxX;
          hitEdge = true;
        }
        const edge = step > 0 ? nx + h : nx - h;
        const col = Math.floor(edge - 1e-7);
        const rowLow = clamp(Math.floor(player.y - h + 1e-7), 0, rows - 1);
        const rowHigh = clamp(Math.floor(player.y + h - 1e-7), 0, rows - 1);

        let hit = null;
        if (col >= 0 && col < cols) {
          for (let row = rowLow; row <= rowHigh; row += 1) {
            const index = cellIndex(col, row, cols);
            if (isSolid(this.map.cells[index])) {
              hit = { col, row, block: this.map.cells[index] };
              break;
            }
          }
        }

        if (hit) {
          const stop = step > 0 ? col - h - 1e-4 : col + 1 + h + 1e-4;
          player.x = step > 0 ? Math.min(nx, stop) : Math.max(nx, stop);
          this.#emitWallHit(player, hit);
          break;
        }

        player.x = nx;
        moved = true;
        if (hitEdge) {
          this.#emitBlocked(player, 'edge');
          break;
        }
      } else {
        let ny = player.y + step;
        let hitEdge = false;
        if (ny < h) {
          ny = h;
          hitEdge = true;
        } else if (ny > maxY) {
          ny = maxY;
          hitEdge = true;
        }
        const edge = step > 0 ? ny + h : ny - h;
        const row = Math.floor(edge - 1e-7);
        const colLow = clamp(Math.floor(player.x - h + 1e-7), 0, cols - 1);
        const colHigh = clamp(Math.floor(player.x + h - 1e-7), 0, cols - 1);

        let hit = null;
        if (row >= 0 && row < rows) {
          for (let col = colLow; col <= colHigh; col += 1) {
            const index = cellIndex(col, row, cols);
            if (isSolid(this.map.cells[index])) {
              hit = { col, row, block: this.map.cells[index] };
              break;
            }
          }
        }

        if (hit) {
          const stop = step > 0 ? row - h - 1e-4 : row + 1 + h + 1e-4;
          player.y = step > 0 ? Math.min(ny, stop) : Math.max(ny, stop);
          this.#emitWallHit(player, hit);
          break;
        }

        player.y = ny;
        moved = true;
        if (hitEdge) {
          this.#emitBlocked(player, 'edge');
          break;
        }
      }
    }

    return moved;
  }

  #emitWallHit(player, hit) {
    if (hit.block === BLOCK.BEDROCK) {
      this.#emitBlocked(player, 'bedrock', hit.col, hit.row);
    }
  }

  #emitBlocked(player, reason, col = Math.floor(player.x), row = Math.floor(player.y)) {
    if (player.blockedCooldown > 0) return;
    player.blockedCooldown = 0.3;
    this.pendingEvents.push({
      type: 'blocked',
      player: player.index,
      x: round(player.x, 3),
      y: round(player.y, 3),
      col,
      row,
      dir: player.facing,
      reason,
    });
  }

  #noteCellChange(player) {
    const col = clamp(Math.floor(player.x), 0, this.map.cols - 1);
    const row = clamp(Math.floor(player.y), 0, this.map.rows - 1);
    if (col === player.lastCol && row === player.lastRow) return;
    player.stats.cellsMoved +=
      Math.abs(col - player.lastCol) + Math.abs(row - player.lastRow);
    player.lastCol = col;
    player.lastRow = row;
  }

  #moveMultiplier(player) {
    const overdrive = player.buffs.overdrive > 0 ? SKILLS.overdrive.moveMultiplier : 1;
    const cryo = player.buffs.cryo > 0 ? SKILLS.cryo.moveMultiplier : 1;
    return overdrive * cryo;
  }

  #mineMultiplier(player) {
    const overdrive = player.buffs.overdrive > 0 ? SKILLS.overdrive.mineMultiplier : 1;
    const cryo = player.buffs.cryo > 0 ? SKILLS.cryo.mineMultiplier : 1;
    return overdrive * cryo;
  }

  /**
   * The block the miner is currently facing and touching. Mining continues
   * automatically while this face remains selected, even with no key held.
   */
  #findMiningTarget(player) {
    const direction = DIRECTIONS[player.facing];
    if (!direction) return null;
    const h = this.config.playerHalfSize;
    const slack = this.config.contactSlack;
    let col;
    let row;

    if (direction.dx !== 0) {
      row = Math.round(player.y - 0.5);
      if (row < 0 || row >= this.map.rows) return null;
      if (Math.abs(player.y - (row + 0.5)) > this.config.laneTolerance) return null;
      const face = player.x + direction.dx * h;
      col = direction.dx > 0 ? Math.floor(face + slack) : Math.floor(face - slack);
      const gap = direction.dx > 0 ? col - face : face - (col + 1);
      if (gap > slack + 1e-6) return null;
    } else {
      col = Math.round(player.x - 0.5);
      if (col < 0 || col >= this.map.cols) return null;
      if (Math.abs(player.x - (col + 0.5)) > this.config.laneTolerance) return null;
      const face = player.y + direction.dy * h;
      row = direction.dy > 0 ? Math.floor(face + slack) : Math.floor(face - slack);
      const gap = direction.dy > 0 ? row - face : face - (row + 1);
      if (gap > slack + 1e-6) return null;
    }

    if (col < 0 || col >= this.map.cols || row < 0 || row >= this.map.rows) return null;
    const block = this.map.cells[cellIndex(col, row, this.map.cols)];
    // Cheat mode lets the miner chew through bedrock as well.
    if (!isDiggable(block) && !(player.cheat && block === BLOCK.BEDROCK)) return null;
    return { col, row, block };
  }

  #updateMining(player, dt) {
    const candidate = this.#findMiningTarget(player);
    if (!candidate) {
      player.mining = null;
      return;
    }
    const current = player.mining;
    if (
      !current ||
      current.col !== candidate.col ||
      current.row !== candidate.row ||
      current.block !== candidate.block
    ) {
      if (player.cheat) {
        player.mining = null;
        this.#breakTarget(player, candidate);
        return;
      }
      player.mining = {
        ...candidate,
        baseTime: BLOCK_TYPES[candidate.block].mineTime,
        elapsed: 0,
      };
      this.pendingEvents.push({
        type: 'digStart',
        player: player.index,
        col: candidate.col,
        row: candidate.row,
        block: candidate.block,
        baseTimeMs: BLOCK_TYPES[candidate.block].mineTime * 1000,
      });
      return;
    }

    const index = cellIndex(current.col, current.row, this.map.cols);
    if (this.map.cells[index] !== current.block) {
      player.mining = null;
      return;
    }

    // Cheat mode skips the timer entirely: one block per tick.
    if (player.cheat) {
      player.mining = null;
      this.#breakTarget(player, current);
      return;
    }

    current.elapsed += dt * this.#mineMultiplier(player);
    if (current.elapsed < current.baseTime) return;

    player.mining = null;
    // The miner stays exactly where they are. Holding the direction is what
    // walks them into the cleared cell afterwards.
    this.#breakTarget(player, current);
  }

  /**
   * Break the current face, plus one extra block straight ahead while the Echo
   * Form buff is active ("two blocks per dig").
   */
  #breakTarget(player, target) {
    const index = cellIndex(target.col, target.row, this.map.cols);
    if (!this.#breakBlock(index, target.col, target.row, target.block, player, 'dig')) {
      return;
    }
    if (player.buffs.echo <= 0) return;
    const direction = DIRECTIONS[player.facing];
    if (!direction) return;

    const col = target.col + direction.dc;
    const row = target.row + direction.dr;
    if (!this.#isValidCell(col, row)) return;
    const echoIndex = cellIndex(col, row, this.map.cols);
    const echoBlock = this.map.cells[echoIndex];
    if (echoBlock === BLOCK.EMPTY) return;
    if (echoBlock === BLOCK.BEDROCK && !player.cheat) return;
    this.#breakBlock(echoIndex, col, row, echoBlock, player, 'echo');
  }

  #breakBlock(index, col, row, block, player, method, energyGain = this.config.energy.perBlock) {
    if (this.map.cells[index] !== block) return false;
    this.map.cells[index] = BLOCK.EMPTY;
    this.pendingChanges.push({ i: index, block: BLOCK.EMPTY });
    player.stats.blocksMined += 1;
    player.energy = Math.min(this.config.energy.max, player.energy + energyGain);
    this.pendingEvents.push({
      type: 'blockBreak',
      player: player.index,
      col,
      row,
      block,
      method,
    });
    // Blasting never detonates a lucky block; only actually digging it does.
    if (block === BLOCK.LUCKY && method !== 'blast') {
      this.#triggerLucky(player, col, row);
    }
    return true;
  }

  #isBaselineColumn(col) {
    return col === 0 || col === this.map.cols - 1;
  }

  #playersOverlapCell(col, row) {
    return this.players.some((player) => this.#cellOverlapsPlayer(player, col, row));
  }

  #setBlock(col, row, block, changed) {
    const index = cellIndex(col, row, this.map.cols);
    if (this.map.cells[index] === block) return false;
    this.map.cells[index] = block;
    this.pendingChanges.push({ i: index, block });
    if (Array.isArray(changed)) changed.push({ col, row, block });
    return true;
  }

  /**
   * Roll one of the five lucky effects. Terrain effects rewrite the map,
   * buffs sit on the miner. Baseline columns and occupied cells are always
   * left alone so a gamble can never seal a gate or bury a miner.
   */
  #triggerLucky(player, col, row) {
    const roll = Number(this.random());
    const cursor = Number.isFinite(roll) ? roll : 0;
    const pick = Math.min(
      LUCKY_EFFECT_ORDER.length - 1,
      Math.max(0, Math.floor(cursor * LUCKY_EFFECT_ORDER.length)),
    );
    const effectId = LUCKY_EFFECT_ORDER[pick];
    const effect = LUCKY_EFFECTS[effectId];
    const changed = [];

    if (effectId === 'soften' || effectId === 'harden') {
      const block = effectId === 'soften' ? BLOCK.SOIL : BLOCK.OBSIDIAN;
      const radius = effect.radius;
      for (let dc = -radius; dc <= radius; dc += 1) {
        for (let dr = -radius; dr <= radius; dr += 1) {
          const targetCol = col + dc;
          const targetRow = row + dr;
          if (!this.#isValidCell(targetCol, targetRow)) continue;
          if (this.#isBaselineColumn(targetCol)) continue;
          if (this.#playersOverlapCell(targetCol, targetRow)) continue;
          const index = cellIndex(targetCol, targetRow, this.map.cols);
          const current = this.map.cells[index];
          if (current === BLOCK.EMPTY || current === BLOCK.BEDROCK) continue;
          this.#setBlock(targetCol, targetRow, block, changed);
        }
      }
    } else if (effectId === 'wall') {
      const column = Math.floor(player.x);
      if (!this.#isBaselineColumn(column)) {
        const playerRow = Math.floor(player.y);
        for (let targetRow = 0; targetRow < this.map.rows; targetRow += 1) {
          if (targetRow === playerRow) continue;
          if (this.#playersOverlapCell(column, targetRow)) continue;
          const index = cellIndex(column, targetRow, this.map.cols);
          if (this.map.cells[index] === BLOCK.BEDROCK) continue;
          this.#setBlock(column, targetRow, BLOCK.OBSIDIAN, changed);
        }
      }
    } else if (effectId === 'echo' || effectId === 'invert') {
      player.buffs[effectId] = Math.max(player.buffs[effectId], effect.duration);
    }

    this.pendingEvents.push({
      type: 'lucky',
      player: player.index,
      col,
      row,
      effect: effectId,
      name: effect.name,
      good: effect.good,
      duration: effect.duration ?? null,
      changes: changed.length,
    });
  }

  #checkBreach(player) {
    if (this.phase !== 'playing') return;
    const col = clamp(Math.floor(player.x), 0, this.map.cols - 1);
    const row = clamp(Math.floor(player.y), 0, this.map.rows - 1);
    if (col !== this.config.goalCols[player.index]) return;
    if (!isGoalRow(row, this.config)) return;
    const gate = row <= this.config.goalBands[0][1] ? 'upper' : 'lower';
    this.#finish(player.index, 'breach', gate);
  }

  #progressFor(player) {
    const distance = distanceToGoalZone(this.config, player.index, player.x, player.y);
    const initial = this.startGoalDistances[player.index];
    if (!Number.isFinite(initial) || initial <= 0) return 0;
    return clamp(1 - distance / initial, 0, 1);
  }

  #resolveTimeout() {
    const progress = this.players.map((player) => this.#progressFor(player));
    if (Math.abs(progress[0] - progress[1]) < 0.0001) {
      this.#finish('draw', 'timeout');
    } else {
      this.#finish(progress[0] > progress[1] ? 0 : 1, 'timeout');
    }
  }

  #finish(winner, reason, gate = null) {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.winner = winner;
    this.reason = reason;
    this.gate = gate;
    this.pendingEvents.push({ type: 'finish', winner, reason, gate });
  }

  #updateCryoEffects(dt) {
    if (this.pendingCryo.length === 0) return;
    const remaining = [];
    for (const effect of this.pendingCryo) {
      effect.delayLeft -= dt;
      if (effect.delayLeft > 0) {
        remaining.push(effect);
        continue;
      }
      const rival = this.players[1 - effect.caster];
      const hit =
        Boolean(rival) &&
        rival.connected &&
        Math.hypot(rival.x - effect.x, rival.y - effect.y) <= effect.radius;
      if (hit) {
        rival.buffs.cryo = Math.max(rival.buffs.cryo, effect.duration);
      }
      this.pendingEvents.push({
        type: 'cryoBurst',
        player: effect.caster,
        x: round(effect.x, 3),
        y: round(effect.y, 3),
        radius: effect.radius,
        hit: Boolean(hit),
      });
    }
    this.pendingCryo = remaining;
  }

  castSkill(index, skillId, payload = {}) {
    if (this.phase !== 'playing') {
      return { ok: false, error: 'phase', message: 'The match is not running.' };
    }
    const player = this.players[index];
    const opponent = this.players[1 - index];
    const skill = SKILLS[skillId];
    if (!player || !player.connected) {
      return { ok: false, error: 'inactive', message: 'You are not active.' };
    }
    if (!skill) {
      return { ok: false, error: 'skill', message: 'Unknown skill.' };
    }
    if (player.cooldowns[skillId] > 0) {
      return {
        ok: false,
        error: 'cooldown',
        message: `${skill.name} is cooling down.`,
      };
    }
    if (player.energy < skill.cost) {
      return { ok: false, error: 'energy', message: 'Not enough energy.' };
    }

    let target = null;
    let cells = [];
    let extra = {};

    if (skillId === 'build') {
      const result = this.#castBuild(player, opponent, payload, skill);
      if (result.error) return { ok: false, ...result };
      target = result.target;
      cells = result.cells;
    } else if (skillId === 'blast') {
      const result = this.#castBlast(player, payload, skill);
      if (result.error) return { ok: false, ...result };
      target = result.target;
      cells = result.cells;
    } else if (skillId === 'cryo') {
      const result = this.#castCryo(player, opponent, payload, skill);
      if (result.error) return { ok: false, ...result };
      target = result.target;
      extra = { radius: skill.radius, delayMs: Math.round(skill.delay * 1000) };
    } else if (skillId === 'overdrive') {
      player.buffs.overdrive = Math.max(player.buffs.overdrive, skill.duration);
    } else {
      return { ok: false, error: 'skill', message: 'Unknown skill.' };
    }

    player.energy -= skill.cost;
    player.cooldowns[skillId] = skill.cooldown;
    player.stats.skillsUsed += 1;
    this.pendingEvents.push({
      type: 'skill',
      player: index,
      skill: skillId,
      target,
      cells,
      ...extra,
    });

    return { ok: true, target, cells };
  }

  #isValidCell(col, row) {
    return (
      Number.isInteger(col) &&
      Number.isInteger(row) &&
      col >= 0 &&
      col < this.map.cols &&
      row >= 0 &&
      row < this.map.rows
    );
  }

  #cellDistanceToPlayer(player, col, row) {
    return Math.hypot(col + 0.5 - player.x, row + 0.5 - player.y);
  }

  #cellOverlapsPlayer(player, col, row) {
    const h = this.config.playerHalfSize;
    return (
      player.x + h > col &&
      player.x - h < col + 1 &&
      player.y + h > row &&
      player.y - h < row + 1
    );
  }

  #castBuild(player, opponent, payload, skill) {
    const rawCells = Array.isArray(payload?.cells) ? payload.cells : [];
    if (rawCells.length < 1 || rawCells.length > skill.maxCells) {
      return {
        error: 'target',
        message: `Select 1–${skill.maxCells} empty cells near the rival.`,
      };
    }

    const seen = new Set();
    const cells = [];
    for (const entry of rawCells) {
      const col = Number(entry?.col);
      const row = Number(entry?.row);
      if (!this.#isValidCell(col, row)) {
        return { error: 'target', message: 'That barricade spot is off the map.' };
      }
      const key = `${col},${row}`;
      if (seen.has(key)) {
        return { error: 'target', message: 'Pick different cells for each barricade.' };
      }
      seen.add(key);
      if (this.map.cells[cellIndex(col, row, this.map.cols)] !== BLOCK.EMPTY) {
        return { error: 'target', message: 'Barricades need empty cells.' };
      }
      if (isGoalTriggerCell(col, row, this.config)) {
        return { error: 'target', message: 'You cannot seal a gate.' };
      }
      if (this.#cellDistanceToPlayer(opponent, col, row) > skill.range + 1e-6) {
        return { error: 'target', message: 'Barricades must be placed near the rival.' };
      }
      if (
        this.#cellOverlapsPlayer(player, col, row) ||
        this.#cellOverlapsPlayer(opponent, col, row)
      ) {
        return { error: 'target', message: 'You cannot build on a miner.' };
      }
      cells.push({ col, row });
    }

    for (const cell of cells) {
      const index = cellIndex(cell.col, cell.row, this.map.cols);
      this.map.cells[index] = BLOCK.BARRICADE;
      this.pendingChanges.push({ i: index, block: BLOCK.BARRICADE });
    }

    const avgX = cells.reduce((sum, cell) => sum + cell.col + 0.5, 0) / cells.length;
    const avgY = cells.reduce((sum, cell) => sum + cell.row + 0.5, 0) / cells.length;
    return { target: { x: round(avgX, 3), y: round(avgY, 3) }, cells };
  }

  #castBlast(player, payload, skill) {
    const col = Number(payload?.target?.col);
    const row = Number(payload?.target?.row);
    if (!this.#isValidCell(col, row)) {
      return { error: 'target', message: 'Pick a cell to blast.' };
    }
    if (this.#cellDistanceToPlayer(player, col, row) > skill.range + 1e-6) {
      return { error: 'target', message: 'That blast is out of range.' };
    }

    const cleared = [];
    for (let dc = -skill.radius; dc <= skill.radius; dc += 1) {
      for (let dr = -skill.radius; dr <= skill.radius; dr += 1) {
        const blastCol = col + dc;
        const blastRow = row + dr;
        if (!this.#isValidCell(blastCol, blastRow)) continue;
        const index = cellIndex(blastCol, blastRow, this.map.cols);
        const block = this.map.cells[index];
        if (block === BLOCK.EMPTY || block === BLOCK.BEDROCK) continue;
        if (
          this.#breakBlock(
            index,
            blastCol,
            blastRow,
            block,
            player,
            'blast',
            this.config.energy.perBlastBlock,
          )
        ) {
          cleared.push({ col: blastCol, row: blastRow, block });
        }
      }
    }

    if (cleared.length === 0) {
      return { error: 'target', message: 'No breakable blocks in that area.' };
    }

    for (const other of this.players) {
      if (
        other.mining &&
        cleared.some((cell) => cell.col === other.mining.col && cell.row === other.mining.row)
      ) {
        other.mining = null;
      }
    }

    return {
      target: { x: col + 0.5, y: row + 0.5 },
      cells: cleared,
    };
  }

  #castCryo(player, opponent, payload, skill) {
    const col = Number(payload?.target?.col);
    const row = Number(payload?.target?.row);
    if (!this.#isValidCell(col, row)) {
      return { error: 'target', message: 'Pick a burst point.' };
    }
    if (this.#cellDistanceToPlayer(opponent, col, row) > skill.range + 1e-6) {
      return { error: 'target', message: 'The burst must land near the rival.' };
    }

    this.pendingCryo.push({
      caster: player.index,
      x: col + 0.5,
      y: row + 0.5,
      radius: skill.radius,
      delayLeft: skill.delay,
      duration: skill.duration,
    });

    return { target: { x: col + 0.5, y: row + 0.5 } };
  }

  setDirectionFromInput(index, direction) {
    return this.setDirection(index, direction);
  }

  snapshot() {
    this.seq += 1;
    const blocks = this.pendingChanges;
    this.pendingChanges = [];

    return {
      seq: this.seq,
      phase: this.phase,
      countdownMs: Math.max(0, Math.round(this.countdownLeft * 1000)),
      timeLeftMs: Math.max(0, Math.round(this.timeLeft * 1000)),
      elapsedMs: Math.round(this.elapsed * 1000),
      winner: this.winner,
      reason: this.reason,
      gate: this.gate,
      players: this.players.map((player) => ({
        index: player.index,
        name: player.name,
        connected: player.connected,
        x: round(player.x, 3),
        y: round(player.y, 3),
        facing: player.facing,
        mining: player.mining
          ? {
              col: player.mining.col,
              row: player.mining.row,
              block: player.mining.block,
              progress: round(clamp(player.mining.elapsed / player.mining.baseTime, 0, 1), 3),
            }
          : null,
        energy: round(player.energy, 1),
        cooldowns: Object.fromEntries(
          Object.entries(player.cooldowns).map(([skill, remaining]) => [
            skill,
            round(remaining, 1),
          ]),
        ),
        buffs: {
          overdrive: round(player.buffs.overdrive, 1),
          cryo: round(player.buffs.cryo, 1),
          echo: round(player.buffs.echo, 1),
          invert: round(player.buffs.invert, 1),
          freeze: round(player.buffs.freeze, 1),
        },
        cheat: player.cheat,
        stats: { ...player.stats },
        progress: round(this.#progressFor(player), 3),
      })),
      effects: {
        cryo: this.pendingCryo.map((effect) => ({
          caster: effect.caster,
          x: round(effect.x, 3),
          y: round(effect.y, 3),
          radius: effect.radius,
          remainingMs: Math.max(0, Math.round(effect.delayLeft * 1000)),
        })),
      },
      blocks,
    };
  }

  takeEvents() {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  getResult() {
    return {
      winner: this.winner,
      reason: this.reason,
      gate: this.gate,
      elapsedMs: Math.round(this.elapsed * 1000),
      timeLeftMs: Math.max(0, Math.round(this.timeLeft * 1000)),
      players: this.players.map((player) => ({
        name: player.name,
        index: player.index,
        progress: round(this.#progressFor(player), 3),
        stats: { ...player.stats },
      })),
    };
  }
}
