import {
  BLOCK,
  BLOCK_TYPES,
  CONFIG,
  DIRECTIONS,
  EFFECTS,
  LUCKY_BUFF_POOL,
  LUCKY_DEBUFF_POOL,
  SKILLS,
  distanceToGoalZone,
  goalDirectionForPlayer,
  isGoalRow,
  isGoalTriggerCell,
  luckyEffectForRoll,
  oppositeDirection,
  pickFromPool,
} from '../shared/config.js';
import { cellIndex } from './map.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const isDiggable = (block) => block !== BLOCK.EMPTY && block !== BLOCK.BEDROCK;
const isSolid = (block) => block !== BLOCK.EMPTY;

/** Every timer stored under player.buffs that ticks down each update. */
const TIMED_BUFFS = Object.freeze([
  'overdrive',
  'cryo',
  'echo',
  'invert',
  'freeze',
  'fog',
  'lag',
  'qte',
  'misfortune',
  'reject',
  'balance',
  'mundane',
  'hijack',
  'hyper',
  'examPass',
  'examFail',
]);

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
    this.lockdown = 0;
    this.examSeq = 0;
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
      buffs: {
        overdrive: 0,
        cryo: 0,
        echo: 0,
        invert: 0,
        freeze: 0,
        fog: 0,
        lag: 0,
        qte: 0,
        misfortune: 0,
        reject: 0,
        balance: 0,
        mundane: 0,
        hijack: 0,
        hyper: 0,
        examPass: 0,
        examFail: 0,
      },
      luckCharges: 0,
      apotheosis: 0,
      thawProgress: 0,
      exam: null,
      cheat: false,
      stats: { blocksMined: 0, skillsUsed: 0, cellsMoved: 0 },
    };
  }

  getPlayer(index) {
    return this.players[index];
  }

  /** Questions for the player's live exam, or null. Sent once, never per tick. */
  examPayload(index) {
    const player = this.players[index];
    if (!player?.exam) return null;
    return { id: player.exam.id, questions: player.exam.questions };
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

    // Hijack locks the wheel: releasing or turning is ignored until it expires.
    if (player.buffs.hijack > 0) return { ok: true, locked: true };

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
    this.lockdown = Math.max(0, this.lockdown - dt);
    for (const player of this.players) {
      for (const skill of Object.keys(player.cooldowns)) {
        player.cooldowns[skill] = Math.max(0, player.cooldowns[skill] - dt);
      }
      for (const key of TIMED_BUFFS) {
        player.buffs[key] = Math.max(0, player.buffs[key] - dt);
      }
      if (player.buffs.qte <= 0) {
        player.thawProgress = 0;
      } else {
        // The thaw meter drains quickly, so tapping has to be sustained.
        player.thawProgress = Math.max(
          0,
          player.thawProgress - EFFECTS.freeze.decayPerSecond * dt,
        );
      }
      player.blockedCooldown = Math.max(0, player.blockedCooldown - dt);
      player.energy = Math.min(
        energyConfig.max,
        player.energy + energyConfig.regenPerSecond * dt,
      );
      if (player.exam) {
        player.exam.remaining -= dt;
        if (player.exam.remaining <= 0) this.#finishExam(player, false, 'timeout');
      }
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
    // Cheat freeze and the QTE freeze are hard stops: no movement, no mining.
    if (player.buffs.freeze > 0 || player.buffs.qte > 0) {
      player.mining = null;
      return;
    }
    // Hijack keeps the drill running in the locked direction.
    if (player.buffs.hijack > 0 && !player.heldDir) {
      player.heldDir = player.facing;
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
        let locked = false;
        if (col >= 0 && col < cols) {
          for (let row = rowLow; row <= rowHigh; row += 1) {
            const index = cellIndex(col, row, cols);
            const block = this.map.cells[index];
            if (isSolid(block)) {
              hit = { col, row, block };
              break;
            }
            if (this.lockdown > 0 && isGoalTriggerCell(col, row, this.config)) {
              hit = { col, row, block };
              locked = true;
              break;
            }
          }
        }

        if (hit) {
          const stop = step > 0 ? col - h - 1e-4 : col + 1 + h + 1e-4;
          player.x = step > 0 ? Math.min(nx, stop) : Math.max(nx, stop);
          if (locked) this.#emitBlocked(player, 'locked', col, hit.row);
          else this.#emitWallHit(player, hit);
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
        let locked = false;
        if (row >= 0 && row < rows) {
          for (let col = colLow; col <= colHigh; col += 1) {
            const index = cellIndex(col, row, cols);
            const block = this.map.cells[index];
            if (isSolid(block)) {
              hit = { col, row, block };
              break;
            }
            if (this.lockdown > 0 && isGoalTriggerCell(col, row, this.config)) {
              hit = { col, row, block };
              locked = true;
              break;
            }
          }
        }

        if (hit) {
          const stop = step > 0 ? row - h - 1e-4 : row + 1 + h + 1e-4;
          player.y = step > 0 ? Math.min(ny, stop) : Math.max(ny, stop);
          if (locked) this.#emitBlocked(player, 'locked', hit.col, row);
          else this.#emitWallHit(player, hit);
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
    if (player.buffs.hyper > 0) return SKILLS.overdrive.hyperMultiplier;
    const overdrive = player.buffs.overdrive > 0 ? SKILLS.overdrive.moveMultiplier : 1;
    const cryo = player.buffs.cryo > 0 ? SKILLS.cryo.moveMultiplier : 1;
    return overdrive * cryo;
  }

  #mineMultiplier(player) {
    const hyper = player.buffs.hyper > 0 ? SKILLS.overdrive.hyperMultiplier : 1;
    const overdrive =
      hyper > 1 ? 1 : player.buffs.overdrive > 0 ? SKILLS.overdrive.mineMultiplier : 1;
    const cryo = player.buffs.cryo > 0 ? SKILLS.cryo.mineMultiplier : 1;
    const hijack = player.buffs.hijack > 0 ? EFFECTS.hijack.mineMultiplier : 1;
    let balance = 1;
    if (player.buffs.balance > 0) {
      const mine = this.#progressFor(player);
      const rival = this.players[1 - player.index];
      const other = rival ? this.#progressFor(rival) : mine;
      const delta = mine - other;
      let behind;
      if (Math.abs(delta) < 1e-4) behind = this.random() < 0.5;
      else behind = delta < 0;
      balance = behind ? EFFECTS.balance.behindMultiplier : 1 / EFFECTS.balance.aheadDivisor;
    }
    const examPass = player.buffs.examPass > 0 ? this.config.exam.passMultiplier : 1;
    const examFail = player.buffs.examFail > 0 ? this.config.exam.failMultiplier : 1;
    return hyper * overdrive * cryo * hijack * balance * examPass * examFail;
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
        baseTime:
          BLOCK_TYPES[candidate.block].mineTime *
          (candidate.block === BLOCK.LUCKY
            ? Math.max(1, this.#luckyCluster(candidate.col, candidate.row).length)
            : 1),
        elapsed: 0,
      };
      this.pendingEvents.push({
        type: 'digStart',
        player: player.index,
        col: candidate.col,
        row: candidate.row,
        block: candidate.block,
        baseTimeMs: player.mining.baseTime * 1000,
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
   * Break the current face. A lucky block is one cluster: the whole cluster is
   * cleared in one dig (its dig time scales with the cluster size) and every
   * cell rolls its own outcome at the same time. Echo Form adds one extra block
   * straight ahead, as usual.
   */
  #breakTarget(player, target) {
    if (target.block === BLOCK.LUCKY) {
      const cluster = this.#luckyCluster(target.col, target.row);
      if (cluster.length === 0) return;
      for (const index of cluster) {
        const col = index % this.map.cols;
        const row = Math.floor(index / this.map.cols);
        this.#breakBlock(index, col, row, BLOCK.LUCKY, player, 'dig', undefined, false);
      }
      for (const index of cluster) {
        const col = index % this.map.cols;
        const row = Math.floor(index / this.map.cols);
        this.#triggerLucky(player, col, row);
      }
    } else {
      const index = cellIndex(target.col, target.row, this.map.cols);
      if (!this.#breakBlock(index, target.col, target.row, target.block, player, 'dig')) {
        return;
      }
    }

    // Echo Form adds one extra block straight ahead.
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

  /** All 4-connected lucky cells around one cell (the cluster it belongs to). */
  #luckyCluster(col, row) {
    const { cols, rows } = this.map;
    const start = cellIndex(col, row, cols);
    if (this.map.cells[start] !== BLOCK.LUCKY) return [];
    const seen = new Set([start]);
    const stack = [start];
    const cluster = [];
    while (stack.length > 0) {
      const index = stack.pop();
      cluster.push(index);
      const c = index % cols;
      const r = Math.floor(index / cols);
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const next = cellIndex(nc, nr, cols);
        if (seen.has(next) || this.map.cells[next] !== BLOCK.LUCKY) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return cluster;
  }

  #breakBlock(
    index,
    col,
    row,
    block,
    player,
    method,
    energyGain = this.config.energy.perBlock,
    triggerLucky = true,
  ) {
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
    if (triggerLucky && block === BLOCK.LUCKY && method !== 'blast') {
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
   * Roll a lucky outcome. Luck forces a buff on the miner, Misfortune forces a
   * debuff on the miner, otherwise the weighted table is used and debuffs
   * mostly land on the rival.
   */
  #triggerLucky(player, col, row) {
    let effectId;
    let target = player;

    if (player.luckCharges > 0) {
      player.luckCharges -= 1;
      // Luck itself is excluded, so a guaranteed buff cannot loop forever.
      effectId = pickFromPool(
        LUCKY_BUFF_POOL.filter((id) => id !== 'luck'),
        this.random(),
      );
      target = player;
    } else if (player.buffs.misfortune > 0) {
      effectId = pickFromPool(LUCKY_DEBUFF_POOL, this.random());
      target = player;
    } else {
      effectId = luckyEffectForRoll(this.random());
      const def = EFFECTS[effectId];
      if (def && def.kind === 'debuff') {
        const chance = this.config.luckySelfDebuffChance ?? 0.2;
        target = this.random() < chance ? player : this.players[1 - player.index];
      }
    }

    const effect = EFFECTS[effectId];
    if (!effect) return;
    if (effect.kind === 'terrain') {
      this.#applyTerrain(player, effect, col, row);
      return;
    }
    this.#applyEffect(player.index, target.index, effectId, { col, row });
  }

  #applyTerrain(player, effect, col, row) {
    const changed = [];
    if (effect.id === 'soften' || effect.id === 'harden') {
      const block = effect.id === 'soften' ? BLOCK.SOIL : BLOCK.OBSIDIAN;
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
    } else if (effect.id === 'wall') {
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
    }

    this.pendingEvents.push({
      type: 'effect',
      player: player.index,
      target: null,
      effect: effect.id,
      name: effect.name,
      kind: 'terrain',
      good: Boolean(effect.good),
      blocked: false,
      col,
      row,
      changes: changed.length,
    });
  }

  /**
   * Apply one player status. Mundane blocks buffs and debuffs; Reject blocks
   * debuffs. Tradeoffs are always self-imposed and bypass both.
   */
  #applyEffect(casterIndex, targetIndex, effectId, meta = {}) {
    const def = EFFECTS[effectId];
    const target = this.players[targetIndex];
    if (!def || !target) return { blocked: false };

    let blocked = false;
    if (def.kind === 'buff' || def.kind === 'debuff') {
      if (target.buffs.mundane > 0) blocked = true;
      if (def.kind === 'debuff' && target.buffs.reject > 0) blocked = true;
    }

    if (!blocked) {
      if (effectId === 'drain') {
        target.energy = 0;
      } else if (effectId === 'luck') {
        target.luckCharges = Math.max(target.luckCharges, def.charges);
      } else if (effectId === 'apotheosis') {
        target.apotheosis = Math.max(target.apotheosis, def.charges || 1);
      } else if (effectId === 'freeze') {
        target.buffs.qte = Math.max(target.buffs.qte, def.duration);
        target.thawProgress = def.startProgress;
      } else if (effectId === 'lockdown') {
        this.lockdown = Math.max(this.lockdown, def.duration);
        this.#expelFromGates();
      } else if (effectId === 'exam') {
        this.#startExam(target);
      } else if (effectId === 'hijack') {
        target.buffs.hijack = Math.max(target.buffs.hijack, def.duration);
        // Lock the wheel on the way the miner is already facing.
        target.heldDir = target.facing;
      } else if (def.duration && Object.prototype.hasOwnProperty.call(target.buffs, effectId)) {
        target.buffs[effectId] = Math.max(target.buffs[effectId], def.duration);
      }
    }

    this.pendingEvents.push({
      type: 'effect',
      player: casterIndex,
      target: targetIndex,
      effect: effectId,
      name: def.name,
      kind: def.kind,
      blocked,
      duration: def.duration ?? null,
      col: meta.col ?? null,
      row: meta.row ?? null,
      charges: effectId === 'luck' ? target.luckCharges : null,
    });
    return { blocked };
  }

  /** QTE thaw: every direction tap fills the thaw meter, which decays. */
  tapThaw(index) {
    const player = this.players[index];
    if (!player || player.buffs.qte <= 0) {
      return { ok: false, error: 'frozen', message: 'You are not frozen.' };
    }
    const gain = EFFECTS.freeze.tapGain;
    player.thawProgress = Math.min(1, player.thawProgress + gain);
    if (player.thawProgress >= 1 - 1e-6) {
      player.buffs.qte = 0;
      player.thawProgress = 0;
      this.pendingEvents.push({ type: 'thawed', player: index });
      return { ok: true, thawed: true };
    }
    return { ok: true, progress: round(player.thawProgress, 3) };
  }

  submitExam(index, answers) {
    const player = this.players[index];
    if (!player || !player.exam) {
      return { ok: false, error: 'exam', message: 'No exam is active.' };
    }
    if (!Array.isArray(answers) || answers.length !== player.exam.answers.length) {
      return { ok: false, error: 'exam', message: 'Answer all three questions.' };
    }
    const passed = player.exam.answers.every((answer, i) => Number(answers[i]) === answer);
    this.#finishExam(player, passed, 'submitted');
    return { ok: true, passed };
  }

  /** Developer menu: force a status on self or the rival. */
  applyDevEffect(index, effectId, target = 'self') {
    if (this.phase !== 'playing') {
      return { ok: false, error: 'phase', message: 'The match is not running.' };
    }
    const caster = this.players[index];
    if (!caster) return { ok: false, error: 'inactive', message: 'No miner there.' };
    const def = EFFECTS[effectId];
    if (!def || def.kind === 'terrain') {
      return { ok: false, error: 'effect', message: 'Unknown effect.' };
    }
    const targetIndex = target === 'rival' ? 1 - index : index;
    const result = this.#applyEffect(index, targetIndex, effectId, {});
    return { ok: true, target: targetIndex, blocked: result.blocked };
  }

  #startExam(player) {
    const examConfig = this.config.exam || CONFIG.exam;
    const questions = [];
    const answers = [];
    for (let i = 0; i < examConfig.questions; i += 1) {
      const question = this.#makeQuestion();
      questions.push({ text: question.text, options: question.options });
      answers.push(question.answer);
    }
    player.exam = {
      id: (this.examSeq += 1),
      remaining: examConfig.seconds,
      questions,
      answers,
    };
    this.pendingEvents.push({
      type: 'examStart',
      player: player.index,
      exam: { id: player.exam.id, questions: player.exam.questions },
    });
  }

  #makeQuestion() {
    const a = 2 + Math.floor(this.random() * 98);
    const b = 2 + Math.floor(this.random() * 98);
    const addition = this.random() < 0.5;
    let value;
    let text;
    if (addition) {
      value = a + b;
      text = `${a} + ${b}`;
    } else {
      const high = Math.max(a, b);
      const low = Math.min(a, b);
      value = high - low;
      text = `${high} − ${low}`;
    }

    const options = new Set([value]);
    let guard = 0;
    while (options.size < 4 && guard < 60) {
      guard += 1;
      const delta = 1 + Math.floor(this.random() * 12);
      const up = value + delta;
      if (!options.has(up)) options.add(up);
      const down = value - delta;
      if (options.size < 4 && down >= 0 && !options.has(down)) options.add(down);
    }
    // Deterministic fill keeps every question at four choices.
    let filler = 1;
    while (options.size < 4) {
      options.add(value + filler);
      filler += 1;
    }
    const list = [...options];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return { text: `${text} = ?`, options: list.map(String), answer: list.indexOf(value) };
  }

  #finishExam(player, passed, reason) {
    if (!player.exam) return;
    const examConfig = this.config.exam || CONFIG.exam;
    player.exam = null;
    if (passed) {
      player.buffs.examPass = Math.max(player.buffs.examPass, examConfig.passDuration);
    } else {
      player.buffs.examFail = Math.max(player.buffs.examFail, examConfig.failDuration);
    }
    this.pendingEvents.push({
      type: 'examResult',
      player: player.index,
      passed: Boolean(passed),
      reason,
    });
  }

  #checkBreach(player) {
    if (this.phase !== 'playing') return;
    if (this.lockdown > 0) return;
    const col = clamp(Math.floor(player.x), 0, this.map.cols - 1);
    const row = clamp(Math.floor(player.y), 0, this.map.rows - 1);
    if (col !== this.config.goalCols[player.index]) return;
    if (!isGoalRow(row, this.config)) return;
    const gate = row <= this.config.goalBands[0][1] ? 'upper' : 'lower';
    this.#finish(player.index, 'breach', gate);
  }

  /** Lockdown slams the gates shut and shoves anyone standing in one outside. */
  #expelFromGates() {
    for (const player of this.players) {
      const col = clamp(Math.floor(player.x), 0, this.map.cols - 1);
      const row = clamp(Math.floor(player.y), 0, this.map.rows - 1);
      if (!isGoalTriggerCell(col, row, this.config)) continue;
      const leftSide = col <= 1;
      player.x = leftSide ? 2.5 : this.map.cols - 3.5;
      player.mining = null;
      this.pendingEvents.push({
        type: 'blocked',
        player: player.index,
        x: round(player.x, 3),
        y: round(player.y, 3),
        col,
        row,
        dir: player.facing,
        reason: 'locked',
      });
    }
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
    const empowered = player.apotheosis > 0;

    if (skillId === 'build') {
      const result = this.#castBuild(player, opponent, payload, skill, empowered);
      if (result.error) return { ok: false, ...result };
      target = result.target;
      cells = result.cells;
    } else if (skillId === 'blast') {
      const result = this.#castBlast(player, payload, skill, empowered);
      if (result.error) return { ok: false, ...result };
      target = result.target;
      cells = result.cells;
    } else if (skillId === 'cryo') {
      if (empowered) {
        const result = this.#castFrostbite(player, opponent, payload, skill);
        if (result.error) return { ok: false, ...result };
        target = result.target;
        cells = result.cells;
        extra = { frostbite: true };
      } else {
        const result = this.#castCryo(player, opponent, payload, skill);
        if (result.error) return { ok: false, ...result };
        target = result.target;
        extra = { radius: skill.radius, delayMs: Math.round(skill.delay * 1000) };
      }
    } else if (skillId === 'overdrive') {
      if (empowered) {
        player.buffs.hyper = Math.max(player.buffs.hyper, skill.duration);
      } else {
        player.buffs.overdrive = Math.max(player.buffs.overdrive, skill.duration);
      }
      extra = { hyper: empowered };
    } else {
      return { ok: false, error: 'skill', message: 'Unknown skill.' };
    }

    if (empowered) player.apotheosis = 0;
    player.energy -= skill.cost;
    const lagMultiplier = player.buffs.lag > 0 ? EFFECTS.lag.cooldownMultiplier : 1;
    player.cooldowns[skillId] = skill.cooldown * lagMultiplier;
    player.stats.skillsUsed += 1;
    this.pendingEvents.push({
      type: 'skill',
      player: index,
      skill: skillId,
      target,
      cells,
      empowered,
      ...extra,
    });

    return { ok: true, target, cells, empowered };
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

  #castBuild(player, opponent, payload, skill, empowered = false) {
    const rawCells = Array.isArray(payload?.cells) ? payload.cells : [];
    if (rawCells.length < 1 || rawCells.length > skill.maxCells) {
      return {
        error: 'target',
        message: `Select 1–${skill.maxCells} cells near the rival.`,
      };
    }

    const seen = new Set();
    const anchors = [];
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
      if (this.map.cells[cellIndex(col, row, this.map.cols)] === BLOCK.BEDROCK) {
        return { error: 'target', message: 'Bedrock cannot be built over.' };
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
      anchors.push({ col, row });
    }

    // MegaBuild widens every chosen cell into a 3×1 strip.
    const targets = new Map();
    const addTarget = (col, row) => {
      if (!this.#isValidCell(col, row)) return;
      if (isGoalTriggerCell(col, row, this.config)) return;
      if (this.map.cells[cellIndex(col, row, this.map.cols)] === BLOCK.BEDROCK) return;
      if (
        this.#cellOverlapsPlayer(player, col, row) ||
        this.#cellOverlapsPlayer(opponent, col, row)
      ) {
        return;
      }
      targets.set(`${col},${row}`, { col, row });
    };
    for (const anchor of anchors) {
      addTarget(anchor.col, anchor.row);
      if (empowered) {
        for (let dc = -1; dc <= 1; dc += 1) addTarget(anchor.col + dc, anchor.row);
      }
    }

    const cells = [...targets.values()];
    if (cells.length === 0) {
      return { error: 'target', message: 'No room for a barricade there.' };
    }
    for (const cell of cells) {
      const index = cellIndex(cell.col, cell.row, this.map.cols);
      this.map.cells[index] = BLOCK.BARRICADE;
      this.pendingChanges.push({ i: index, block: BLOCK.BARRICADE });
    }
    for (const other of this.players) {
      if (
        other.mining &&
        cells.some((cell) => cell.col === other.mining.col && cell.row === other.mining.row)
      ) {
        other.mining = null;
      }
    }

    const avgX = cells.reduce((sum, cell) => sum + cell.col + 0.5, 0) / cells.length;
    const avgY = cells.reduce((sum, cell) => sum + cell.row + 0.5, 0) / cells.length;
    return { target: { x: round(avgX, 3), y: round(avgY, 3) }, cells };
  }

  #castBlast(player, payload, skill, empowered = false) {
    const col = Number(payload?.target?.col);
    const row = Number(payload?.target?.row);
    if (!this.#isValidCell(col, row)) {
      return { error: 'target', message: 'Pick a cell to blast.' };
    }
    if (this.#cellDistanceToPlayer(player, col, row) > skill.range + 1e-6) {
      return { error: 'target', message: 'That blast is out of range.' };
    }
    const radius = empowered ? skill.megaRadius : skill.radius;

    const cleared = [];
    for (let dc = -radius; dc <= radius; dc += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        // GigaBlast is a circle; a normal Blast is a 3×3 square.
        if (empowered && Math.hypot(dc, dr) > radius + 0.35) continue;
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

  /**
   * Empowered Cryo (Frostbite): instead of a delayed chill, the whole 5×5 area
   * around the burst point freezes into obsidian-hard ice.
   */
  #castFrostbite(player, opponent, payload, skill) {
    const col = Number(payload?.target?.col);
    const row = Number(payload?.target?.row);
    if (!this.#isValidCell(col, row)) {
      return { error: 'target', message: 'Pick a burst point.' };
    }
    if (this.#cellDistanceToPlayer(opponent, col, row) > skill.range + 1e-6) {
      return { error: 'target', message: 'The burst must land near the rival.' };
    }

    const radius = skill.frostbiteRadius;
    const changed = [];
    for (let dc = -radius; dc <= radius; dc += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        const targetCol = col + dc;
        const targetRow = row + dr;
        if (!this.#isValidCell(targetCol, targetRow)) continue;
        if (this.#isBaselineColumn(targetCol)) continue;
        if (this.#playersOverlapCell(targetCol, targetRow)) continue;
        const index = cellIndex(targetCol, targetRow, this.map.cols);
        const block = this.map.cells[index];
        if (block === BLOCK.BEDROCK || block === BLOCK.ICE) continue;
        this.#setBlock(targetCol, targetRow, BLOCK.ICE, changed);
      }
    }
    if (changed.length === 0) {
      return { error: 'target', message: 'Nothing can freeze there.' };
    }
    for (const other of this.players) {
      if (
        other.mining &&
        changed.some((cell) => cell.col === other.mining.col && cell.row === other.mining.row)
      ) {
        other.mining = null;
      }
    }
    return { target: { x: col + 0.5, y: row + 0.5 }, cells: changed };
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
      lockdownMs: Math.max(0, Math.round(this.lockdown * 1000)),
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
        // Only active statuses are broadcast: an idle player costs one empty
        // object instead of fifteen zeroed timers on every snapshot.
        buffs: Object.fromEntries(
          Object.entries(player.buffs)
            .filter(([, remaining]) => remaining > 0)
            .map(([key, remaining]) => [key, round(remaining, 1)]),
        ),
        luckCharges: player.luckCharges,
        apotheosis: player.apotheosis,
        thaw:
          player.buffs.qte > 0
            ? { progress: round(player.thawProgress, 3) }
            : null,
        // Exam questions are sent once (examStart event / game:exam on join);
        // snapshots only carry the countdown so the timer can tick locally.
        exam: player.exam
          ? {
              id: player.exam.id,
              remainingMs: Math.max(0, Math.round(player.exam.remaining * 1000)),
            }
          : null,
        cheat: player.cheat,
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
