import {
  BLOCK,
  BLOCK_TYPES,
  CONFIG,
  DIRECTIONS,
  SKILLS,
  oppositeDirection,
} from '/shared/config.js';

const FONT_MONO = '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", Menlo, monospace';
const TEAM = [
  {
    main: '#4be0d0',
    bright: '#a5fff5',
    dark: '#155a56',
    soft: 'rgba(75, 224, 208, 0.22)',
    rgb: '75, 224, 208',
  },
  {
    main: '#ff8a4c',
    bright: '#ffc19d',
    dark: '#6e3219',
    soft: 'rgba(255, 138, 76, 0.22)',
    rgb: '255, 138, 76',
  },
];

const FACING_VECTOR = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const TEXT_TONES = {
  info: '#e8e4da',
  buff: '#ffe08a',
  debuff: '#ff9a8f',
  tradeoff: '#c3b0ff',
  cyan: '#8ef0e4',
  danger: '#ff6f66',
  gold: '#ffd76a',
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rand = (min, max) => min + Math.random() * (max - min);
const truncate = (value, limit) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

function hash2(a, b, seed = 0) {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(seed + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export class GameRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stage = canvas.parentElement;

    this.cols = CONFIG.cols;
    this.rows = CONFIG.rows;
    this.cells = null;
    this.seed = 1;
    this.you = 0;
    this.snapshot = null;

    this.tile = 20;
    this.offsetX = 0;
    this.offsetY = 0;
    this.mapW = 0;
    this.mapH = 0;
    this.stageW = 0;
    this.stageH = 0;
    this.dpr = 1;

    this.mapCanvas = document.createElement('canvas');
    this.mapCtx = this.mapCanvas.getContext('2d');
    this.barricadeCells = new Set();
    this.luckyCells = new Set();
    this.targeting = null;

    this.viewPositions = this.#startViews();
    this.localInput = null;
    this.particles = [];
    this.rings = [];
    this.playerTexts = [[], []];
    this.shake = 0;
    this.time = 0;
    this.lastFrame = 0;
    this.running = false;
    this.raf = null;

    this.reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => this.measure())
        : null;
    if (this.resizeObserver) this.resizeObserver.observe(this.stage);

    this.measure();
  }

  setYou(index) {
    this.you = index;
  }

  /** Raw direction currently held by this client, used to predict own movement. */
  setLocalInput(direction) {
    this.localInput = direction || null;
  }

  setMap(map) {
    this.cols = map.cols;
    this.rows = map.rows;
    this.seed = map.seed ?? ((Math.random() * 0xffffffff) >>> 0);
    this.cells = [...map.cells];
    this.snapshot = null;
    this.particles = [];
    this.rings = [];
    this.playerTexts = [[], []];
    this.shake = 0;
    this.barricadeCells.clear();
    this.luckyCells.clear();
    for (let i = 0; i < this.cells.length; i += 1) {
      if (this.cells[i] === BLOCK.BARRICADE) this.barricadeCells.add(i);
      if (this.cells[i] === BLOCK.LUCKY) this.luckyCells.add(i);
    }
    this.targeting = null;
    this.viewPositions = this.#startViews();
    this.localInput = null;
    this.measure();
    this.rebuildMap();
  }

  #startViews() {
    return [0, 1].map((index) => ({
      x: CONFIG.startCols[index] + 0.5,
      y: CONFIG.playerRows[index] + 0.5,
      initialized: false,
    }));
  }

  setTargeting(targeting) {
    this.targeting = targeting || null;
  }

  /** Convert a browser pointer position into a map cell. */
  screenToCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (this.tile <= 0) return null;
    const x = (localX - this.offsetX) / this.tile;
    const y = (localY - this.offsetY) / this.tile;
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    return { col: Math.floor(x), row: Math.floor(y), x, y };
  }

  updateSnapshot(snapshot) {
    if (!this.cells) return;
    if (Array.isArray(snapshot.blocks) && snapshot.blocks.length > 0) {
      this.applyChanges(snapshot.blocks);
    }
    this.snapshot = snapshot;
  }

  applyChanges(changes) {
    if (!this.cells) return;
    const touched = [];
    for (const change of changes) {
      const index = Number(change?.i);
      const block = Number(change?.block);
      if (!Number.isInteger(index) || index < 0 || index >= this.cells.length) continue;
      const old = this.cells[index];
      if (old === block) continue;
      this.cells[index] = block;
      touched.push(index);
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);

      if (block === BLOCK.EMPTY && old !== BLOCK.EMPTY) {
        this.spawnBlockBurst(col, row, old);
        this.barricadeCells.delete(index);
        this.luckyCells.delete(index);
      } else if (block === BLOCK.BARRICADE) {
        this.spawnBarricadeDust(col, row);
        this.barricadeCells.add(index);
        this.luckyCells.delete(index);
      } else if (block === BLOCK.LUCKY) {
        this.luckyCells.add(index);
        this.barricadeCells.delete(index);
      } else {
        this.barricadeCells.delete(index);
        this.luckyCells.delete(index);
      }
    }
    if (touched.length > 0) this.redrawCells(touched);
  }

  /** Repaint only the cells that changed instead of the whole 72×28 sheet. */
  redrawCells(indices) {
    if (!this.cells || this.mapW <= 0 || this.mapH <= 0) return;
    const ctx = this.mapCtx;
    const tile = this.tile;
    for (const index of indices) {
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      const x = col * tile;
      const y = row * tile;
      const block = this.cells[index];
      if (block === BLOCK.EMPTY) this.drawTunnelTile(ctx, x, y, col, row);
      else this.drawBlockTile(ctx, x, y, col, row, block);
    }
    // Start pads sit on top of the tile layer, so restore them if a mined or
    // built cell happened to land in a spawn pocket.
    this.drawStartPad(ctx, CONFIG.startCols[0], CONFIG.playerRows[0], 0);
    this.drawStartPad(ctx, CONFIG.startCols[1], CONFIG.playerRows[1], 1);
  }

  measure() {
    if (!this.stage) return;
    const rect = this.stage.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width === this.stageW && height === this.stageH && dpr === this.dpr) return;

    this.stageW = width;
    this.stageH = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.computeLayout();
    this.rebuildMap();
  }

  computeLayout() {
    if (!this.cols || !this.rows) return;
    const padX = clamp(this.stageW * 0.035, 18, 54);
    const padY = clamp(this.stageH * 0.11, 28, 64);
    const availableW = Math.max(40, this.stageW - padX * 2);
    const availableH = Math.max(40, this.stageH - padY * 2);
    const tile = Math.max(
      6,
      Math.floor(Math.min(availableW / this.cols, availableH / this.rows)),
    );
    this.tile = tile;
    this.mapW = tile * this.cols;
    this.mapH = tile * this.rows;
    this.offsetX = Math.round((this.stageW - this.mapW) / 2);
    this.offsetY = Math.round((this.stageH - this.mapH) / 2);
  }

  rebuildMap() {
    if (!this.cells || this.mapW <= 0 || this.mapH <= 0) return;
    const pixelW = Math.max(1, Math.round(this.mapW * this.dpr));
    const pixelH = Math.max(1, Math.round(this.mapH * this.dpr));
    this.mapCanvas.width = pixelW;
    this.mapCanvas.height = pixelH;
    const ctx = this.mapCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.mapW, this.mapH);
    ctx.fillStyle = '#080a0f';
    ctx.fillRect(0, 0, this.mapW, this.mapH);

    const tile = this.tile;
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const index = row * this.cols + col;
        const block = this.cells[index];
        const x = col * tile;
        const y = row * tile;
        if (block === BLOCK.EMPTY) {
          this.drawTunnelTile(ctx, x, y, col, row);
        } else {
          this.drawBlockTile(ctx, x, y, col, row, block);
        }
      }
    }

    this.drawStartPad(ctx, CONFIG.startCols[0], CONFIG.playerRows[0], 0);
    this.drawStartPad(ctx, CONFIG.startCols[1], CONFIG.playerRows[1], 1);
  }

  drawTunnelTile(ctx, x, y, col, row) {
    const tile = this.tile;
    const tone = hash2(col, row, this.seed + 11);
    ctx.fillStyle = tone > 0.55 ? '#0a0c12' : '#090b10';
    ctx.fillRect(x, y, tile, tile);

    if (tile >= 12) {
      const fleck = hash2(col, row, this.seed + 23);
      if (fleck > 0.45) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
        const fx = x + 2 + fleck * (tile - 5);
        const fy = y + 2 + hash2(col, row, this.seed + 29) * (tile - 5);
        ctx.fillRect(fx, fy, 1, 1);
      }
    }

    const shadow = Math.max(2, Math.round(tile * 0.16));
    const solid = (c, r) => {
      if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return true;
      return this.cells[r * this.cols + c] !== BLOCK.EMPTY;
    };

    if (solid(col, row - 1)) {
      const grad = ctx.createLinearGradient(0, y, 0, y + shadow);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, tile, shadow);
    }
    if (solid(col, row + 1)) {
      const grad = ctx.createLinearGradient(0, y + tile - shadow, 0, y + tile);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y + tile - shadow, tile, shadow);
    }
    if (solid(col - 1, row)) {
      const grad = ctx.createLinearGradient(x, 0, x + shadow, 0);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, shadow, tile);
    }
    if (solid(col + 1, row)) {
      const grad = ctx.createLinearGradient(x + tile - shadow, 0, x + tile, 0);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
      ctx.fillStyle = grad;
      ctx.fillRect(x + tile - shadow, y, shadow, tile);
    }
  }

  drawBlockTile(ctx, x, y, col, row, block) {
    const tile = this.tile;
    const def = BLOCK_TYPES[block];
    if (!def) return;
    const gap = tile >= 14 ? 1 : 0;
    const bx = x + gap;
    const by = y + gap;
    const bw = tile - gap * 2;
    const bh = tile - gap * 2;
    const variant = hash2(col, row, this.seed + 31);

    ctx.fillStyle = def.color;
    ctx.fillRect(bx, by, bw, bh);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
    ctx.fillRect(bx, by, bw, Math.max(1, Math.round(tile * 0.06)));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(bx, by + bh - Math.max(1, Math.round(tile * 0.08)), bw, Math.max(1, Math.round(tile * 0.08)));
    ctx.fillStyle = def.edge;
    ctx.fillRect(bx, by, Math.max(1, Math.round(tile * 0.06)), bh);
    ctx.fillRect(bx, by, bw, Math.max(1, Math.round(tile * 0.06)));

    if (tile >= 12) {
      if (block === BLOCK.SANDSTONE) {
        ctx.fillStyle = 'rgba(255, 230, 173, 0.13)';
        const bandY = by + Math.round(bh * (0.36 + variant * 0.18));
        ctx.fillRect(bx + 1, bandY, bw - 2, Math.max(1, Math.round(tile * 0.055)));
        const band2Y = by + Math.round(bh * (0.7 + variant * 0.1));
        ctx.fillRect(bx + 1, band2Y, bw - 2, 1);
      } else if (block === BLOCK.GRANITE) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        for (let i = 0; i < 4; i += 1) {
          const px = bx + 2 + hash2(col + i, row, this.seed + 41) * (bw - 5);
          const py = by + 2 + hash2(col, row + i, this.seed + 43) * (bh - 5);
          ctx.fillRect(Math.round(px), Math.round(py), 1, 1);
        }
        ctx.strokeStyle = 'rgba(220, 230, 240, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx + bw * 0.15, by + bh * 0.75);
        ctx.lineTo(bx + bw * 0.52, by + bh * 0.28);
        ctx.stroke();
      } else if (block === BLOCK.OBSIDIAN) {
        ctx.fillStyle = 'rgba(172, 135, 255, 0.16)';
        ctx.fillRect(bx + bw * 0.58, by + bh * 0.14, Math.max(1, bw * 0.18), Math.max(1, bh * 0.07));
        ctx.fillRect(bx + bw * 0.2, by + bh * 0.62, Math.max(1, bw * 0.1), Math.max(1, bh * 0.05));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
        ctx.beginPath();
        ctx.moveTo(bx + bw * 0.3, by + bh * 0.85);
        ctx.lineTo(bx + bw * 0.72, by + bh * 0.25);
        ctx.stroke();
      } else if (block === BLOCK.BEDROCK) {
        ctx.strokeStyle = 'rgba(120, 124, 140, 0.55)';
        ctx.lineWidth = Math.max(1, tile * 0.055);
        ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
        ctx.fillStyle = 'rgba(190, 195, 210, 0.8)';
        const bolt = Math.max(1, Math.round(tile * 0.09));
        ctx.fillRect(bx + 2, by + 2, bolt, bolt);
        ctx.fillRect(bx + bw - 2 - bolt, by + 2, bolt, bolt);
        ctx.fillRect(bx + 2, by + bh - 2 - bolt, bolt, bolt);
        ctx.fillRect(bx + bw - 2 - bolt, by + bh - 2 - bolt, bolt, bolt);
      } else if (block === BLOCK.BARRICADE) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        ctx.strokeStyle = 'rgba(28, 18, 4, 0.55)';
        ctx.lineWidth = Math.max(2, tile * 0.18);
        for (let i = -bh; i < bw + bh; i += Math.max(5, tile * 0.36)) {
          ctx.beginPath();
          ctx.moveTo(bx + i, by + bh);
          ctx.lineTo(bx + i + bh, by);
          ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = '#ffb02e';
        ctx.lineWidth = Math.max(1, tile * 0.07);
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      } else if (block === BLOCK.SOIL) {
        ctx.fillStyle = 'rgba(40, 22, 12, 0.25)';
        for (let i = 0; i < 3; i += 1) {
          const px = bx + 2 + hash2(col + i * 3, row, this.seed + 51) * (bw - 5);
          const py = by + 2 + hash2(col, row + i * 5, this.seed + 53) * (bh - 5);
          ctx.fillRect(Math.round(px), Math.round(py), Math.max(1, Math.round(tile * 0.055)), Math.max(1, Math.round(tile * 0.055)));
        }
      } else if (block === BLOCK.LUCKY) {
        const glow = ctx.createRadialGradient(
          bx + bw / 2,
          by + bh / 2,
          0,
          bx + bw / 2,
          by + bh / 2,
          bw * 0.62,
        );
        glow.addColorStop(0, 'rgba(255, 215, 106, 0.36)');
        glow.addColorStop(1, 'rgba(255, 215, 106, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(bx, by, bw, bh);

        ctx.strokeStyle = '#ffd76a';
        ctx.lineWidth = Math.max(1, tile * 0.07);
        ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);

        ctx.fillStyle = 'rgba(255, 215, 106, 0.18)';
        for (let i = 0; i < 2; i += 1) {
          const px = bx + 3 + hash2(col + i * 7, row, this.seed + 61) * (bw - 8);
          const py = by + 3 + hash2(col, row + i * 9, this.seed + 67) * (bh - 8);
          ctx.fillRect(Math.round(px), Math.round(py), Math.max(1, Math.round(tile * 0.08)), Math.max(1, Math.round(tile * 0.08)));
        }

        if (tile >= 10) {
          ctx.fillStyle = '#ffe9a8';
          ctx.font = `700 ${Math.max(6, Math.round(tile * 0.6))}px ${FONT_MONO}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('?', bx + bw / 2, by + bh / 2 + 0.5);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
        }
      }
    }

    // A tiny highlight keeps the tile readable at small sizes.
    if (tile >= 9) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
      ctx.fillRect(bx + 1, by + 1, Math.round(bw * 0.28), 1);
    }
  }

  drawStartPad(ctx, col, row, index) {
    const tile = this.tile;
    const cx = (col + 0.5) * tile;
    const cy = (row + 0.5) * tile;
    const color = TEAM[index].main;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = Math.max(1, tile * 0.05);
    ctx.setLineDash([Math.max(2, tile * 0.14), Math.max(2, tile * 0.12)]);
    ctx.beginPath();
    ctx.arc(cx, cy, tile * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - tile * 0.16);
    ctx.lineTo(cx + tile * 0.16, cy);
    ctx.lineTo(cx, cy + tile * 0.16);
    ctx.lineTo(cx - tile * 0.16, cy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  addSkillEffect(event) {
    if (!event) return;
    const view = this.viewPositions[event.player];
    const team = TEAM[event.player] || TEAM[0];
    const tile = this.tile;

    if (event.skill === 'build') {
      for (const cell of event.cells || []) {
        this.addRing(cell.col + 0.5, cell.row + 0.5, tile * 0.3, tile * 1.15, '#ffb640', 0.55);
        this.addSparks(cell.col + 0.5, cell.row + 0.5, '#ffd472', 8, 1.8);
      }
      this.addShake(2.2);
    } else if (event.skill === 'blast') {
      for (const cell of event.cells || []) {
        this.addRing(cell.col + 0.5, cell.row + 0.5, tile * 0.2, tile * 1.4, '#ffcf7a', 0.48);
        this.addSparks(cell.col + 0.5, cell.row + 0.5, '#ffb15c', 11, 3.1);
      }
      this.addShake(5.5);
    } else if (event.skill === 'overdrive') {
      if (view) {
        this.addRing(view.x, view.y, tile * 0.25, tile * 1.35, team.main, 0.6);
        this.addSparks(view.x, view.y, team.bright, 12, 2.2);
      }
      this.addShake(1.4);
    } else if (event.skill === 'cryo') {
      if (event.target) {
        this.addRing(event.target.x, event.target.y, tile * 0.2, tile * (event.radius || 2), '#9eefff', 0.55);
        this.addSnow(event.target.x, event.target.y, 10);
      }
      this.addShake(1);
    }
  }

  addCryoBurst(event) {
    if (!event) return;
    const radius = Math.max(1, event.radius || 2);
    this.addRing(event.x, event.y, this.tile * 0.2, this.tile * radius, '#b9f4ff', 0.7);
    this.addRing(event.x, event.y, this.tile * 0.15, this.tile * radius * 0.55, '#ffffff', 0.4);
    this.addSnow(event.x, event.y, event.hit ? 28 : 16);
    this.addShake(event.hit ? 3.2 : 1.6);
  }

  addLuckyBurst(event) {
    if (!event) return;
    const good = event.good !== false;
    const color = good ? '#ffe08a' : '#ff7a6a';
    const x = event.col + 0.5;
    const y = event.row + 0.5;
    this.addRing(x, y, this.tile * 0.2, this.tile * (good ? 2.4 : 1.5), color, 0.6);
    this.addRing(x, y, this.tile * 0.15, this.tile * 0.9, '#ffffff', 0.35);
    this.addSparks(x, y, color, good ? 18 : 12, good ? 3.2 : 2.2);
    this.addShake(good ? 2.4 : 3.4);
  }

  /** Floating callout above one miner. Stacked so simultaneous events never overlap. */
  addPlayerText(index, text, tone = 'info') {
    const list = this.playerTexts[index];
    if (!list || !text) return;
    list.push({ text: String(text), tone, life: 0, maxLife: 2.6 });
    while (list.length > 4) list.shift();
  }

  clearPlayerTexts() {
    this.playerTexts = [[], []];
  }

  addBlocked(event) {
    if (!event) return;
    const dir = FACING_VECTOR[event.dir] || { x: 0, y: 0 };
    const sourceX = Number.isFinite(event.x) ? event.x : event.col + 0.5;
    const sourceY = Number.isFinite(event.y) ? event.y : event.row + 0.5;
    const x = sourceX - dir.x * 0.35;
    const y = sourceY - dir.y * 0.35;
    this.addSparks(x, y, event.player === this.you ? '#ffb48d' : 'rgba(210,210,220,0.8)', 3, 1.3);
  }

  addStep(event) {
    if (!event) return;
    if (Math.random() > 0.35) return;
    const team = TEAM[event.player] || TEAM[0];
    const x = Number.isFinite(event.x) ? event.x : event.col + 0.5;
    const y = Number.isFinite(event.y) ? event.y : event.row + 0.5;
    this.addSparks(x, y + 0.32, team.soft, 1, 0.35, 0.3);
  }

  addShake(amount) {
    if (this.reducedMotion) return;
    this.shake = Math.max(this.shake, amount);
  }

  addRing(x, y, from, to, color, life = 0.5) {
    if (this.rings.length > 40) this.rings.shift();
    this.rings.push({ x, y, from, to, color, life: 0, maxLife: life });
  }

  addSparks(x, y, color, count = 6, speed = 2, life = 0.5) {
    const total = this.reducedMotion ? Math.ceil(count * 0.35) : count;
    for (let i = 0; i < total; i += 1) {
      const angle = rand(0, Math.PI * 2);
      const velocity = rand(speed * 0.25, speed);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - 0.7,
        gravity: 3.6,
        life: 0,
        maxLife: rand(life * 0.65, life * 1.2),
        size: rand(0.035, 0.09),
        color,
        glow: Math.random() > 0.6,
        spin: rand(-8, 8),
        angle: rand(0, Math.PI * 2),
      });
    }
    this.trimParticles();
  }

  addSnow(x, y, count = 10) {
    const total = this.reducedMotion ? Math.ceil(count * 0.35) : count;
    for (let i = 0; i < total; i += 1) {
      this.particles.push({
        x: x + rand(-0.35, 0.35),
        y: y + rand(-0.3, 0.2),
        vx: rand(-0.35, 0.35),
        vy: rand(-0.9, -0.25),
        gravity: 0.5,
        life: 0,
        maxLife: rand(0.55, 1.1),
        size: rand(0.025, 0.06),
        color: Math.random() > 0.4 ? '#b9f4ff' : '#65d6e7',
        glow: true,
        spin: rand(-3, 3),
        angle: rand(0, Math.PI * 2),
      });
    }
    this.trimParticles();
  }

  spawnBlockBurst(col, row, block) {
    const def = BLOCK_TYPES[block] || BLOCK_TYPES[0];
    const total = this.reducedMotion ? 4 : 9 + def.hardness * 2;
    for (let i = 0; i < total; i += 1) {
      const angle = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      const speed = rand(0.6, 3.6 + def.hardness * 0.4);
      this.particles.push({
        x: col + 0.5 + rand(-0.3, 0.3),
        y: row + 0.5 + rand(-0.3, 0.3),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 7.5,
        life: 0,
        maxLife: rand(0.35, 0.8),
        size: rand(0.035, 0.1),
        color: Math.random() > 0.5 ? def.color : def.accent,
        glow: block === BLOCK.OBSIDIAN || block === BLOCK.BARRICADE,
        spin: rand(-10, 10),
        angle: rand(0, Math.PI * 2),
      });
    }
    this.addShake(1.1 + def.hardness * 0.35);
    this.trimParticles();
  }

  spawnBarricadeDust(col, row) {
    for (let i = 0; i < (this.reducedMotion ? 3 : 7); i += 1) {
      this.particles.push({
        x: col + 0.5 + rand(-0.35, 0.35),
        y: row + rand(0, 0.4),
        vx: rand(-0.8, 0.8),
        vy: rand(-2.4, -0.7),
        gravity: 5,
        life: 0,
        maxLife: rand(0.35, 0.65),
        size: rand(0.03, 0.08),
        color: '#ffc75a',
        glow: true,
        spin: rand(-7, 7),
        angle: rand(0, Math.PI * 2),
      });
    }
  }

  trimParticles() {
    const limit = this.reducedMotion ? 110 : 320;
    if (this.particles.length > limit) {
      this.particles.splice(0, this.particles.length - limit);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.measure();
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.time += dt;
    this.update(dt);
    this.draw();
    this.raf = requestAnimationFrame((next) => this.frame(next));
  }

  update(dt) {
    this.shake *= Math.exp(-dt * 7);
    if (this.shake < 0.05) this.shake = 0;

    for (const particle of this.particles) {
      particle.life += dt;
      particle.vy += particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.angle += particle.spin * dt;
    }
    this.particles = this.particles.filter((particle) => particle.life < particle.maxLife);

    for (const ring of this.rings) ring.life += dt;
    this.rings = this.rings.filter((ring) => ring.life < ring.maxLife);

    for (const list of this.playerTexts) {
      for (const entry of list) entry.life += dt;
    }
    this.playerTexts = this.playerTexts.map((list) =>
      list.filter((entry) => entry.life < entry.maxLife),
    );

    if (this.snapshot?.players) {
      for (let i = 0; i < 2; i += 1) {
        const player = this.snapshot.players[i];
        if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) continue;
        const view = this.viewPositions[i];
        if (!view) continue;
        if (!view.initialized) {
          view.x = player.x;
          view.y = player.y;
          view.initialized = true;
          continue;
        }

        // Own miner is simulated locally between snapshots so latency and
        // jitter do not turn held movement into stutter.
        if (i === this.you && this.#predictLocal(player, dt)) continue;

        const dx = player.x - view.x;
        const dy = player.y - view.y;
        const snapDistance = i === this.you ? 1.4 : 3;
        if (Math.abs(dx) + Math.abs(dy) > snapDistance) {
          view.x = player.x;
          view.y = player.y;
          continue;
        }
        // Corrections are gentle for the local miner and only needed once the
        // server disagrees by a meaningful amount.
        const ease = 1 - Math.exp(-dt * (i === this.you ? 10 : 26));
        view.x += dx * ease;
        view.y += dy * ease;
      }
    }
  }

  /**
   * Advance the local miner from the last authoritative snapshot using the
   * held direction and the shared movement constants. Returns false when the
   * caller should interpolate toward the server instead.
   */
  #predictLocal(player, dt) {
    const view = this.viewPositions[this.you];
    if (!view || !this.localInput || this.snapshot.phase !== 'playing') return false;
    const dx = player.x - view.x;
    const dy = player.y - view.y;
    if (Math.abs(dx) + Math.abs(dy) > 1.5) return false;

    const buffs = player.buffs || {};
    if ((buffs.freeze || 0) > 0 || (buffs.qte || 0) > 0) return false;
    let travel = this.localInput;
    if ((buffs.hijack || 0) > 0) travel = player.facing || travel;
    else if ((buffs.invert || 0) > 0) travel = oppositeDirection(travel) || travel;
    const vector = DIRECTIONS[travel];
    if (!vector) return false;

    const speedMul =
      ((buffs.overdrive || 0) > 0 ? 1.25 : 1) * ((buffs.cryo || 0) > 0 ? 0.6 : 1);
    const speed = CONFIG.moveSpeed * speedMul;
    const assist = CONFIG.laneAssistSpeed * dt;

    if (vector.dx !== 0) {
      const offset = Math.round(view.y - 0.5) + 0.5 - view.y;
      if (Math.abs(offset) > 1e-4) {
        this.#sweepAxis(view, 'y', clamp(offset, -assist, assist));
      }
      this.#sweepAxis(view, 'x', vector.dx * speed * dt);
    } else {
      const offset = Math.round(view.x - 0.5) + 0.5 - view.x;
      if (Math.abs(offset) > 1e-4) {
        this.#sweepAxis(view, 'x', clamp(offset, -assist, assist));
      }
      this.#sweepAxis(view, 'y', vector.dy * speed * dt);
    }
    return true;
  }

  /** Collision-only mirror of the server sweep, over the latest known cells. */
  #sweepAxis(pos, axis, delta) {
    if (!delta || !this.cells) return;
    const h = CONFIG.playerHalfSize;
    const cols = this.cols;
    const rows = this.rows;
    const maxX = cols - h;
    const maxY = rows - h;
    const substeps = Math.max(1, Math.ceil(Math.abs(delta) / 0.12));
    const step = delta / substeps;

    for (let i = 0; i < substeps; i += 1) {
      if (axis === 'x') {
        let nx = pos.x + step;
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
        const rowLow = clamp(Math.floor(pos.y - h + 1e-7), 0, rows - 1);
        const rowHigh = clamp(Math.floor(pos.y + h - 1e-7), 0, rows - 1);
        let blockedCol = null;
        if (col >= 0 && col < cols) {
          for (let row = rowLow; row <= rowHigh; row += 1) {
            if (this.cells[row * cols + col] !== BLOCK.EMPTY) {
              blockedCol = col;
              break;
            }
          }
        }
        if (blockedCol !== null) {
          const stop = step > 0 ? blockedCol - h - 1e-4 : blockedCol + 1 + h + 1e-4;
          pos.x = step > 0 ? Math.min(nx, stop) : Math.max(nx, stop);
          return;
        }
        pos.x = nx;
        if (hitEdge) return;
      } else {
        let ny = pos.y + step;
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
        const colLow = clamp(Math.floor(pos.x - h + 1e-7), 0, cols - 1);
        const colHigh = clamp(Math.floor(pos.x + h - 1e-7), 0, cols - 1);
        let blockedRow = null;
        if (row >= 0 && row < rows) {
          for (let col = colLow; col <= colHigh; col += 1) {
            if (this.cells[row * cols + col] !== BLOCK.EMPTY) {
              blockedRow = row;
              break;
            }
          }
        }
        if (blockedRow !== null) {
          const stop = step > 0 ? blockedRow - h - 1e-4 : blockedRow + 1 + h + 1e-4;
          pos.y = step > 0 ? Math.min(ny, stop) : Math.max(ny, stop);
          return;
        }
        pos.y = ny;
        if (hitEdge) return;
      }
    }
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || this.stageW <= 0) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.stageW, this.stageH);

    this.drawBackdrop(ctx);

    const shakeX = this.shake ? rand(-this.shake, this.shake) : 0;
    const shakeY = this.shake ? rand(-this.shake, this.shake) : 0;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 28;
    ctx.fillStyle = '#080a0f';
    ctx.fillRect(this.offsetX, this.offsetY, this.mapW, this.mapH);
    ctx.restore();

    if (this.cells) {
      ctx.drawImage(this.mapCanvas, this.offsetX, this.offsetY, this.mapW, this.mapH);
    }

    this.drawGates(ctx);
    this.drawBarricadePulse(ctx);
    this.drawLuckyPulse(ctx);
    this.drawDigOverlays(ctx);
    this.drawCryoTelegraphs(ctx);
    this.drawTargeting(ctx);
    this.drawPlayers(ctx);
    this.drawPlayerTexts(ctx, 0);
    this.drawPlayerTexts(ctx, 1);
    this.drawFog(ctx);
    this.drawParticles(ctx);
    this.drawMapLabels(ctx);
    ctx.restore();
  }

  drawBackdrop(ctx) {
    const centerY = this.offsetY + this.mapH / 2;
    const leftGlow = ctx.createRadialGradient(
      this.offsetX,
      centerY,
      0,
      this.offsetX,
      centerY,
      Math.max(this.mapH * 1.4, 160),
    );
    leftGlow.addColorStop(0, 'rgba(75, 224, 208, 0.1)');
    leftGlow.addColorStop(1, 'rgba(75, 224, 208, 0)');
    ctx.fillStyle = leftGlow;
    ctx.fillRect(0, 0, this.stageW, this.stageH);

    const rightGlow = ctx.createRadialGradient(
      this.offsetX + this.mapW,
      centerY,
      0,
      this.offsetX + this.mapW,
      centerY,
      Math.max(this.mapH * 1.4, 160),
    );
    rightGlow.addColorStop(0, 'rgba(255, 138, 76, 0.09)');
    rightGlow.addColorStop(1, 'rgba(255, 138, 76, 0)');
    ctx.fillStyle = rightGlow;
    ctx.fillRect(0, 0, this.stageW, this.stageH);

    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    const count = this.reducedMotion ? 8 : 22;
    for (let i = 0; i < count; i += 1) {
      const x = hash2(i, 1, 9) * this.stageW;
      const travel = (this.time * (4 + hash2(i, 2, 9) * 10) + hash2(i, 3, 9) * this.stageH) % this.stageH;
      const y = this.stageH - travel;
      const size = hash2(i, 4, 9) > 0.8 ? 1.5 : 1;
      ctx.fillRect(Math.round(x), Math.round(y), size, size);
    }
    ctx.restore();
  }

  drawGates(ctx) {
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4);
    const tile = this.tile;
    const depth = CONFIG.goalDepth;
    const bands = CONFIG.goalBands;
    const labelFont = Math.max(6, Math.min(9, tile * 0.34));
    const locked = (this.snapshot?.lockdownMs ?? 0) > 0;

    for (const [side, index] of [
      ['left', 0],
      ['right', 1],
    ]) {
      const team = TEAM[index];
      const isTarget =
        (this.you === 0 && side === 'right') || (this.you === 1 && side === 'left');

      for (const [low, high] of bands) {
        const x = side === 'left' ? this.offsetX : this.offsetX + this.mapW - depth * tile;
        const y = this.offsetY + low * tile;
        const w = depth * tile;
        const h = (high - low + 1) * tile;

        const gradient = ctx.createLinearGradient(
          side === 'left' ? x : x + w,
          0,
          side === 'left' ? x + w : x,
          0,
        );
        gradient.addColorStop(
          0,
          `rgba(${team.rgb}, ${isTarget ? 0.2 + pulse * 0.09 : 0.08})`,
        );
        gradient.addColorStop(1, `rgba(${team.rgb}, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, w, h);

        ctx.save();
        ctx.strokeStyle = `rgba(${team.rgb}, ${isTarget ? 0.48 + pulse * 0.26 : 0.24})`;
        ctx.lineWidth = isTarget ? 1.4 : 0.8;
        ctx.setLineDash(isTarget ? [5, 4] : [3, 6]);
        ctx.lineDashOffset = -this.time * 16;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.restore();

        // Bright strip along the actual scoring edge.
        const edgeX = side === 'left' ? this.offsetX : this.offsetX + this.mapW - 2;
        ctx.fillStyle = `rgba(${team.rgb}, ${isTarget ? 0.5 + pulse * 0.32 : 0.22})`;
        ctx.fillRect(edgeX, y, 2, h);

        const scanY = y + ((this.time * 28 + index * 37 + low * 11) % (h + 20)) - 10;
        if (scanY >= y && scanY <= y + h) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.fillRect(x, scanY, w, 2);
        }

        if (tile >= 10) {
          ctx.save();
          ctx.translate(x + w * 0.5, y + h / 2);
          ctx.rotate(side === 'left' ? -Math.PI / 2 : Math.PI / 2);
          ctx.font = `700 ${labelFont}px ${FONT_MONO}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = isTarget
            ? `rgba(${team.rgb}, 0.95)`
            : `rgba(${team.rgb}, 0.55)`;
          ctx.fillText(isTarget ? 'TARGET GATE' : 'GATE', 0, 0);
          ctx.restore();
        }

        if (isTarget && tile >= 8) {
          const direction = side === 'left' ? -1 : 1;
          const arrowX = side === 'left' ? x + w * 0.32 : x + w * 0.68;
          const arrowY = y + h / 2;
          const size = tile * 0.24;
          ctx.save();
          ctx.strokeStyle = `rgba(${team.rgb}, ${0.45 + pulse * 0.4})`;
          ctx.lineWidth = Math.max(1, tile * 0.07);
          for (let i = 0; i < 2; i += 1) {
            const offset = (i - 0.5) * tile * 0.7 + Math.sin(this.time * 3 + i) * 2;
            ctx.beginPath();
            ctx.moveTo(arrowX - direction * size + direction * offset, arrowY - size);
            ctx.lineTo(arrowX + direction * size + direction * offset, arrowY);
            ctx.lineTo(arrowX - direction * size + direction * offset, arrowY + size);
            ctx.stroke();
          }
          ctx.restore();
        }

        if (locked) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.fillStyle = 'rgba(12, 7, 9, 0.62)';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = 'rgba(255, 98, 89, 0.18)';
          ctx.lineWidth = 1;
          const hatch = Math.max(5, tile * 0.4);
          for (let hy = y - w; hy < y + h; hy += hatch) {
            ctx.beginPath();
            ctx.moveTo(x, hy);
            ctx.lineTo(x + w, hy + w);
            ctx.stroke();
          }
          ctx.restore();

          ctx.save();
          ctx.strokeStyle = 'rgba(255, 98, 89, 0.7)';
          ctx.lineWidth = Math.max(1, tile * 0.08);
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          ctx.setLineDash([]);
          if (tile >= 8) {
            ctx.translate(x + w / 2, y + h / 2);
            ctx.rotate(side === 'left' ? -Math.PI / 2 : Math.PI / 2);
            ctx.font = `700 ${labelFont}px ${FONT_MONO}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255, 150, 140, 0.95)';
            ctx.fillText('SEALED', 0, 0);
          }
          ctx.restore();
        }
      }
    }

    // Visually mark the sealed middle of each baseline. The spawn pockets are
    // open but explicitly not scoring, so they are left unmarked.
    const sealedRanges = [];
    let runStart = null;
    for (let row = 0; row < this.rows; row += 1) {
      const inGate = bands.some(([low, high]) => row >= low && row <= high);
      const inPocket =
        row >= CONFIG.startPocket.rows[0] && row <= CONFIG.startPocket.rows[1];
      if (!inGate && !inPocket) {
        if (runStart === null) runStart = row;
      } else if (runStart !== null) {
        sealedRanges.push([runStart, row - 1]);
        runStart = null;
      }
    }
    if (runStart !== null) sealedRanges.push([runStart, this.rows - 1]);

    ctx.save();
    ctx.strokeStyle = 'rgba(132, 138, 156, 0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    for (const [start, end] of sealedRanges) {
      const y = this.offsetY + start * tile;
      const h = (end - start + 1) * tile;
      ctx.beginPath();
      ctx.moveTo(this.offsetX + 0.5, y);
      ctx.lineTo(this.offsetX + 0.5, y + h);
      ctx.moveTo(this.offsetX + this.mapW - 0.5, y);
      ctx.lineTo(this.offsetX + this.mapW - 0.5, y + h);
      ctx.stroke();
      if (tile >= 12 && h > tile * 2.5) {
        ctx.save();
        ctx.translate(this.offsetX + tile * 0.6, y + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = `600 ${Math.max(5, Math.min(7, tile * 0.26))}px ${FONT_MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(141, 147, 163, 0.42)';
        ctx.fillText('SEALED', 0, 0);
        ctx.restore();
        ctx.save();
        ctx.translate(this.offsetX + this.mapW - tile * 0.6, y + h / 2);
        ctx.rotate(Math.PI / 2);
        ctx.font = `600 ${Math.max(5, Math.min(7, tile * 0.26))}px ${FONT_MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(141, 147, 163, 0.42)';
        ctx.fillText('SEALED', 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawCryoTelegraphs(ctx) {
    const effects = this.snapshot?.effects?.cryo;
    if (!Array.isArray(effects) || effects.length === 0) return;
    const tile = this.tile;
    const delayMs = Math.max(1, SKILLS.cryo.delay * 1000);
    for (const effect of effects) {
      const remaining = clamp((effect.remainingMs ?? 0) / delayMs, 0, 1);
      const cx = this.offsetX + effect.x * tile;
      const cy = this.offsetY + effect.y * tile;
      const radius = effect.radius * tile;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 26);

      ctx.save();
      ctx.fillStyle = `rgba(130, 235, 255, ${0.05 + remaining * 0.08})`;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(174, 246, 255, ${0.35 + pulse * 0.3})`;
      ctx.lineWidth = Math.max(1, tile * 0.06);
      ctx.setLineDash([Math.max(2, tile * 0.16), Math.max(2, tile * 0.12)]);
      ctx.lineDashOffset = -this.time * 30;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // The inner ring closes as the burst is about to detonate.
      ctx.strokeStyle = `rgba(210, 250, 255, ${0.5 + pulse * 0.35})`;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, radius * (0.25 + remaining * 0.75)), 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(200, 248, 255, 0.75)';
      ctx.beginPath();
      ctx.moveTo(cx - tile * 0.18, cy);
      ctx.lineTo(cx + tile * 0.18, cy);
      ctx.moveTo(cx, cy - tile * 0.18);
      ctx.lineTo(cx, cy + tile * 0.18);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawTargeting(ctx) {
    const targeting = this.targeting;
    if (!targeting || !targeting.origin) return;
    const tile = this.tile;
    const skill = SKILLS[targeting.skill];
    const originX = this.offsetX + targeting.origin.x * tile;
    const originY = this.offsetY + targeting.origin.y * tile;
    const range = targeting.range || skill?.range || 0;

    ctx.save();
    // Range bubble centred on whichever miner the skill is aimed around.
    ctx.fillStyle = 'rgba(245, 196, 81, 0.045)';
    ctx.beginPath();
    ctx.arc(originX, originY, range * tile, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(245, 196, 81, 0.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.lineDashOffset = -this.time * 18;
    ctx.beginPath();
    ctx.arc(originX, originY, range * tile, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (targeting.skill === 'build') {
      // Legal empty cells inside the rival bubble.
      if (Array.isArray(targeting.legalCells)) {
        for (const cell of targeting.legalCells) {
          const x = this.offsetX + cell.col * tile;
          const y = this.offsetY + cell.row * tile;
          ctx.fillStyle = 'rgba(245, 196, 81, 0.16)';
          ctx.fillRect(x + tile * 0.32, y + tile * 0.32, tile * 0.36, tile * 0.36);
        }
      }
      const ghostCells = targeting.cells?.length
        ? targeting.cells
        : targeting.hover && targeting.valid
          ? [targeting.hover]
          : [];
      for (const cell of ghostCells) {
        this.#drawGhostBarricade(
          ctx,
          this.offsetX + cell.col * tile,
          this.offsetY + cell.row * tile,
          true,
        );
      }
    } else if (targeting.skill === 'blast' && targeting.hover) {
      const radius = skill?.radius ?? 1;
      for (let dc = -radius; dc <= radius; dc += 1) {
        for (let dr = -radius; dr <= radius; dr += 1) {
          const col = targeting.hover.col + dc;
          const row = targeting.hover.row + dr;
          if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) continue;
          const x = this.offsetX + col * tile;
          const y = this.offsetY + row * tile;
          ctx.fillStyle = targeting.valid
            ? 'rgba(255, 138, 76, 0.22)'
            : 'rgba(255, 98, 89, 0.12)';
          ctx.fillRect(x + 1, y + 1, tile - 2, tile - 2);
          ctx.strokeStyle = targeting.valid
            ? 'rgba(255, 183, 120, 0.75)'
            : 'rgba(255, 98, 89, 0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 1.5, y + 1.5, tile - 3, tile - 3);
        }
      }
    } else if (targeting.skill === 'cryo' && targeting.hover) {
      const radius = (skill?.radius ?? 2) * tile;
      const cx = this.offsetX + (targeting.hover.col + 0.5) * tile;
      const cy = this.offsetY + (targeting.hover.row + 0.5) * tile;
      ctx.fillStyle = targeting.valid
        ? 'rgba(130, 235, 255, 0.14)'
        : 'rgba(255, 98, 89, 0.1)';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = targeting.valid
        ? 'rgba(185, 244, 255, 0.85)'
        : 'rgba(255, 98, 89, 0.55)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (targeting.hover) {
      const x = this.offsetX + targeting.hover.col * tile;
      const y = this.offsetY + targeting.hover.row * tile;
      const color = targeting.valid ? 'rgba(245, 196, 81, 0.95)' : 'rgba(255, 98, 89, 0.9)';
      const corner = Math.max(3, tile * 0.3);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, tile * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, y + corner);
      ctx.lineTo(x, y);
      ctx.lineTo(x + corner, y);
      ctx.moveTo(x + tile - corner, y);
      ctx.lineTo(x + tile, y);
      ctx.lineTo(x + tile, y + corner);
      ctx.moveTo(x + tile, y + tile - corner);
      ctx.lineTo(x + tile, y + tile);
      ctx.lineTo(x + tile - corner, y + tile);
      ctx.moveTo(x + corner, y + tile);
      ctx.lineTo(x, y + tile);
      ctx.lineTo(x, y + tile - corner);
      ctx.stroke();

      if (!targeting.valid) {
        ctx.beginPath();
        ctx.moveTo(x + tile * 0.28, y + tile * 0.28);
        ctx.lineTo(x + tile * 0.72, y + tile * 0.72);
        ctx.moveTo(x + tile * 0.72, y + tile * 0.28);
        ctx.lineTo(x + tile * 0.28, y + tile * 0.72);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  #drawGhostBarricade(ctx, x, y, valid) {
    const tile = this.tile;
    ctx.save();
    ctx.fillStyle = valid ? 'rgba(255, 193, 74, 0.36)' : 'rgba(255, 98, 89, 0.22)';
    ctx.fillRect(x + 1, y + 1, tile - 2, tile - 2);
    ctx.strokeStyle = valid ? 'rgba(255, 215, 106, 0.9)' : 'rgba(255, 98, 89, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x + 1.5, y + 1.5, tile - 3, tile - 3);
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 2);
    ctx.lineTo(x + tile - 2, y + tile - 2);
    ctx.moveTo(x + tile - 2, y + 2);
    ctx.lineTo(x + 2, y + tile - 2);
    ctx.stroke();
    ctx.restore();
  }

  drawBarricadePulse(ctx) {
    if (!this.cells || this.barricadeCells.size === 0) return;
    const pulse = 0.4 + 0.3 * Math.sin(this.time * 5);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 176, 46, ${pulse})`;
    ctx.lineWidth = Math.max(1, this.tile * 0.08);
    for (const index of this.barricadeCells) {
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      const x = this.offsetX + col * this.tile + 1;
      const y = this.offsetY + row * this.tile + 1;
      ctx.strokeRect(x, y, this.tile - 2, this.tile - 2);
    }
    ctx.restore();
  }

  drawLuckyPulse(ctx) {
    if (!this.cells || this.luckyCells.size === 0) return;
    const pulse = 0.32 + 0.34 * Math.sin(this.time * 3.4);
    const tile = this.tile;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 215, 106, ${pulse})`;
    ctx.lineWidth = Math.max(1, tile * 0.07);
    ctx.setLineDash([Math.max(2, tile * 0.2), Math.max(2, tile * 0.16)]);
    ctx.lineDashOffset = -this.time * 16;
    for (const index of this.luckyCells) {
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      const x = this.offsetX + col * tile + 1.5;
      const y = this.offsetY + row * tile + 1.5;
      ctx.strokeRect(x, y, tile - 3, tile - 3);
    }
    ctx.restore();
  }

  drawDigOverlays(ctx) {
    const players = this.snapshot?.players;
    if (!players) return;
    for (const player of players) {
      if (!player.mining) continue;
      this.drawDigCracks(ctx, player);
    }
  }

  drawDigCracks(ctx, player) {
    const { col, row, progress = 0 } = player.mining;
    if (progress <= 0.015) return;
    const tile = this.tile;
    const x = this.offsetX + col * tile;
    const y = this.offsetY + row * tile;
    const team = TEAM[player.index] || TEAM[0];
    const jitter = Math.sin(this.time * 47 + col + row) * tile * 0.012 * progress;

    ctx.save();
    ctx.translate(jitter, 0);
    ctx.fillStyle = `rgba(0, 0, 0, ${0.06 + progress * 0.18})`;
    ctx.fillRect(x, y, tile, tile);

    const seed = this.seed + 97;
    const cracks = [
      [0.5, 0.46, 0.2, 0.16, 0.34, 0.05],
      [0.53, 0.52, 0.86, 0.3, 0.68, 0.82],
      [0.44, 0.55, 0.24, 0.84, 0.62, 0.94],
    ];
    ctx.lineWidth = Math.max(1, tile * 0.038);
    for (let i = 0; i < cracks.length; i += 1) {
      const startAt = 0.08 + i * 0.16;
      if (progress <= startAt) continue;
      const [sx, sy, mx, my, ex, ey] = cracks[i];
      const spread = clamp((progress - startAt) / (1 - startAt), 0, 1);
      ctx.strokeStyle = `rgba(5, 5, 8, ${0.45 + spread * 0.32})`;
      ctx.beginPath();
      ctx.moveTo(x + sx * tile, y + sy * tile);
      ctx.lineTo(
        x + (sx + (mx - sx) * spread) * tile + (hash2(col, row + i, seed) - 0.5) * tile * 0.08,
        y + (sy + (my - sy) * spread) * tile,
      );
      ctx.lineTo(
        x + (sx + (ex - sx) * spread) * tile,
        y + (sy + (ey - sy) * spread) * tile,
      );
      ctx.stroke();
    }

    if (progress > 0.55) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${(progress - 0.55) * 0.36})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + tile * 0.18, y + tile * 0.3);
      ctx.lineTo(x + tile * 0.38, y + tile * 0.63);
      ctx.stroke();
    }

    const barW = Math.max(10, tile * 0.72);
    const barH = Math.max(2, Math.round(tile * 0.09));
    const bx = x + (tile - barW) / 2;
    const by = y + tile - barH - Math.max(2, tile * 0.1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = player.index === this.you ? team.bright : team.main;
    ctx.fillRect(bx, by, barW * clamp(progress, 0, 1), barH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(bx - 0.5, by - 0.5, barW + 1, barH + 1);
    ctx.restore();
  }

  drawPlayers(ctx) {
    const players = this.snapshot?.players;
    if (!players) return;
    for (let i = 0; i < 2; i += 1) {
      const player = players[i];
      if (!player) continue;
      const view = this.viewPositions[i];
      if (!view) continue;
      this.drawPlayer(ctx, player, i, view);
    }
  }

  drawPlayerTexts(ctx, index) {
    const list = this.playerTexts[index];
    if (!list) return;
    const player = this.snapshot?.players?.[index];
    const qte = player?.buffs?.qte || 0;
    const prompt = qte > 0 ? `MASH WASD ${player.thaw?.taps ?? 0}/${player.thaw?.needed ?? 8}` : null;
    if (list.length === 0 && !prompt) return;
    const view = this.viewPositions[index];
    if (!view) return;
    const tile = this.tile;
    const fontSize = Math.max(12, Math.min(17, tile * 0.8));
    const lineHeight = fontSize + 8;
    const padX = 9;
    const baseX = this.offsetX + view.x * tile;
    const baseY = this.offsetY + view.y * tile - tile * 0.86 - 30;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fontSize}px ${FONT_MONO}`;

    const drawLine = (text, y, color, alpha) => {
      const width = ctx.measureText(text).width + padX * 2;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(7, 9, 13, 0.88)';
      const left = baseX - width / 2;
      const top = y - lineHeight / 2;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(left, top, width, lineHeight, 5);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha * 0.5;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillRect(left, top, width, lineHeight);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillText(text, baseX, y + 0.5);
    };

    if (prompt) {
      const y = baseY - list.length * lineHeight;
      drawLine(prompt, y, TEXT_TONES.cyan, 0.95);
    }

    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      const progress = clamp(entry.life / entry.maxLife, 0, 1);
      const fadeIn = progress < 0.12 ? progress / 0.12 : 1;
      const fadeOut = progress > 0.68 ? 1 - (progress - 0.68) / 0.32 : 1;
      const y = baseY - i * lineHeight - progress * 10;
      drawLine(
        entry.text,
        y,
        TEXT_TONES[entry.tone] || TEXT_TONES.info,
        clamp(Math.min(fadeIn, fadeOut), 0, 1),
      );
    }
    ctx.restore();
  }

  drawFog(ctx) {
    const me = this.snapshot?.players?.[this.you];
    if (!me || !(me.buffs?.fog > 0)) return;
    const view = this.viewPositions[this.you];
    if (!view || this.mapW <= 0) return;
    const tile = this.tile;
    const cx = this.offsetX + view.x * tile;
    const cy = this.offsetY + view.y * tile;
    const outer = Math.max(tile * 5.6, 96);
    const inner = tile * 2.2;
    const gradient = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    gradient.addColorStop(0, 'rgba(4, 6, 10, 0)');
    gradient.addColorStop(0.55, 'rgba(4, 6, 10, 0.62)');
    gradient.addColorStop(1, 'rgba(4, 6, 10, 0.95)');
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(this.offsetX, this.offsetY, this.mapW, this.mapH);
    ctx.restore();
  }

  drawPlayer(ctx, player, index, view) {
    const tile = this.tile;
    const team = TEAM[index] || TEAM[0];
    const x = this.offsetX + view.x * tile;
    const y = this.offsetY + view.y * tile;
    const digging = Boolean(player.mining);
    const bob = digging ? 0 : Math.sin(this.time * 8 + index * 2.3) * tile * 0.018;
    const slow = player.buffs?.cryo > 0;
    const boosted = player.buffs?.overdrive > 0;
    const isYou = index === this.you;
    const offline = player.connected === false;

    ctx.save();
    ctx.globalAlpha = offline ? 0.4 : 1;

    if (slow) {
      const aura = ctx.createRadialGradient(x, y, 0, x, y, tile * 0.9);
      aura.addColorStop(0, 'rgba(130, 235, 255, 0.2)');
      aura.addColorStop(1, 'rgba(130, 235, 255, 0)');
      ctx.fillStyle = aura;
      ctx.fillRect(x - tile, y - tile, tile * 2, tile * 2);
      ctx.strokeStyle = 'rgba(150, 238, 255, 0.35)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(x, y, tile * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (boosted) {
      ctx.strokeStyle = 'rgba(245, 196, 81, 0.4)';
      ctx.lineWidth = Math.max(1, tile * 0.045);
      for (let i = 0; i < 3; i += 1) {
        const start = this.time * 5 + i * 2.1;
        ctx.beginPath();
        ctx.arc(x, y, tile * (0.55 + (start % 1) * 0.28), start, start + 0.9);
        ctx.stroke();
      }
    }

    const hardFrozen = player.buffs?.freeze > 0;
    const qteFrozen = player.buffs?.qte > 0;
    if (hardFrozen || qteFrozen) {
      // A hard freeze cage. Red for cheat freeze, ice blue for the QTE freeze.
      const tone = qteFrozen ? '150, 238, 255' : '255, 120, 96';
      const cage = 0.55 + 0.25 * Math.sin(this.time * 6);
      ctx.strokeStyle = `rgba(${tone}, ${cage})`;
      ctx.lineWidth = Math.max(1, tile * 0.06);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, tile * 0.66, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(214, 240, 255, 0.8)';
      for (let i = 0; i < 4; i += 1) {
        const angle = (Math.PI / 2) * i + Math.PI / 4;
        const px = x + Math.cos(angle) * tile * 0.55;
        const py = y + Math.sin(angle) * tile * 0.55;
        ctx.fillRect(px - 1, py - 1, 2.5, 2.5);
      }
    }

    if (player.cheat) {
      ctx.strokeStyle = 'rgba(255, 215, 106, 0.6)';
      ctx.lineWidth = Math.max(1, tile * 0.05);
      const spin = this.time * 4;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(x, y, tile * (0.52 + i * 0.1), spin + i * 2.1, spin + i * 2.1 + 1.1);
        ctx.stroke();
      }
    }

    if (isYou) {
      ctx.strokeStyle = 'rgba(245, 196, 81, 0.58)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.lineDashOffset = -this.time * 14;
      ctx.beginPath();
      ctx.arc(x, y + tile * 0.34, tile * 0.46, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.beginPath();
    ctx.ellipse(x, y + tile * 0.4, tile * 0.34, tile * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();

    const legSwing = digging ? 0 : Math.sin(this.time * 13 + index) * tile * 0.09;
    ctx.fillStyle = '#171b24';
    ctx.fillRect(x - tile * 0.2, y + tile * 0.12, tile * 0.14, tile * 0.24 + legSwing);
    ctx.fillRect(x + tile * 0.06, y + tile * 0.12, tile * 0.14, tile * 0.24 - legSwing);

    // Suit and shoulders.
    ctx.fillStyle = team.dark;
    ctx.fillRect(x - tile * 0.3, y - tile * 0.18 + bob, tile * 0.6, tile * 0.5);
    ctx.fillStyle = team.main;
    ctx.fillRect(x - tile * 0.24, y - tile * 0.12 + bob, tile * 0.48, tile * 0.11);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x - tile * 0.28, y - tile * 0.17 + bob, tile * 0.56, Math.max(1, tile * 0.04));

    // Head and helmet.
    const headY = y - tile * 0.35 + bob;
    ctx.fillStyle = '#c7906f';
    ctx.beginPath();
    ctx.arc(x, headY, tile * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = team.main;
    ctx.beginPath();
    ctx.arc(x, headY - tile * 0.03, tile * 0.22, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = team.bright;
    ctx.fillRect(x - tile * 0.22, headY - tile * 0.03, tile * 0.44, Math.max(1, tile * 0.045));

    const facing = FACING_VECTOR[player.facing] || { x: 1, y: 0 };
    const lampX = x + facing.x * tile * 0.16;
    const lampY = headY - tile * 0.02 + facing.y * tile * 0.06;
    ctx.fillStyle = '#fff4bd';
    ctx.shadowColor = '#ffe9a0';
    ctx.shadowBlur = tile * 0.28;
    ctx.beginPath();
    ctx.arc(lampX, lampY, Math.max(1, tile * 0.045), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Pickaxe.
    const swing = digging
      ? Math.sin(this.time * 18 + index * 1.7) *
        (0.55 + (player.mining.progress || 0) * 0.2)
      : Math.sin(this.time * 2.1 + index) * 0.04;
    const angle = Math.atan2(facing.y, facing.x) + Math.PI / 2 + swing;
    const handleLength = tile * (digging ? 0.74 : 0.64);
    ctx.save();
    ctx.translate(x + facing.x * tile * 0.12, y - tile * 0.04 + bob);
    ctx.rotate(angle);
    ctx.strokeStyle = '#b6905f';
    ctx.lineWidth = Math.max(1.2, tile * 0.055);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, tile * 0.1);
    ctx.lineTo(0, -handleLength);
    ctx.stroke();

    ctx.translate(0, -handleLength);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#b9c2cb';
    ctx.beginPath();
    ctx.moveTo(-tile * 0.17, -tile * 0.05);
    ctx.lineTo(tile * 0.17, -tile * 0.05);
    ctx.lineTo(tile * 0.12, tile * 0.05);
    ctx.lineTo(-tile * 0.12, tile * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillRect(-tile * 0.12, -tile * 0.045, tile * 0.24, Math.max(1, tile * 0.025));
    ctx.restore();

    if (digging) {
      const impactX = x + facing.x * tile * 0.38;
      const impactY = y + facing.y * tile * 0.38 - tile * 0.05;
      ctx.fillStyle = `rgba(255, 235, 171, ${0.3 + Math.abs(swing) * 0.45})`;
      ctx.fillRect(impactX - 1, impactY - 1, 2, 2);
    }

    if (slow) {
      ctx.fillStyle = 'rgba(185, 244, 255, 0.72)';
      for (let i = 0; i < 3; i += 1) {
        const px = x + Math.sin(this.time * 2 + i * 2.2) * tile * 0.38;
        const py = y + Math.cos(this.time * 1.7 + i) * tile * 0.3;
        ctx.fillRect(px, py, 2, 2);
      }
    }

    // Nameplate.
    const label = `${truncate(player.name || 'MINER', 12)}${isYou ? ' · YOU' : ''}`;
    const fontSize = Math.max(8, Math.min(11, tile * 0.42));
    ctx.font = `700 ${fontSize}px ${FONT_MONO}`;
    const textWidth = ctx.measureText(label).width;
    const labelW = textWidth + 8;
    const labelH = fontSize + 6;
    const labelX = x - labelW / 2;
    const labelY = y - tile * 0.86 - labelH;
    ctx.fillStyle = 'rgba(7, 9, 13, 0.88)';
    ctx.fillRect(labelX, labelY, labelW, labelH);
    ctx.strokeStyle = offline ? 'rgba(255, 98, 89, 0.5)' : team.main;
    ctx.lineWidth = 0.8;
    ctx.strokeRect(labelX + 0.5, labelY + 0.5, labelW - 1, labelH - 1);
    ctx.fillStyle = offline ? '#ffaaa1' : isYou ? '#ffe29a' : '#e8e4da';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, labelY + labelH / 2 + 0.5);
    ctx.restore();
  }

  drawParticles(ctx) {
    const tile = this.tile;
    for (const p of this.particles) {
      const alpha = clamp(1 - p.life / p.maxLife, 0, 1);
      if (alpha <= 0) continue;
      const x = this.offsetX + p.x * tile;
      const y = this.offsetY + p.y * tile;
      const size = Math.max(1, p.size * tile);
      ctx.save();
      ctx.globalAlpha = alpha;
      if (p.glow) {
        ctx.shadowColor = p.color;
        ctx.shadowBlur = size * 2.2;
      }
      ctx.fillStyle = p.color;
      ctx.translate(x, y);
      ctx.rotate(p.angle);
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.restore();
    }

    for (const ring of this.rings) {
      const progress = clamp(ring.life / ring.maxLife, 0, 1);
      const radius = ring.from + (ring.to - ring.from) * progress;
      ctx.save();
      ctx.globalAlpha = (1 - progress) * 0.8;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = Math.max(1, tile * 0.06 * (1 - progress * 0.6));
      ctx.beginPath();
      ctx.arc(this.offsetX + ring.x * tile, this.offsetY + ring.y * tile, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawMapLabels(ctx) {
    if (this.offsetY < 24) return;
    const fontSize = Math.max(8, Math.min(11, this.tile * 0.44));
    const y = this.offsetY - 12;
    ctx.save();
    ctx.font = `700 ${fontSize}px ${FONT_MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(75, 224, 208, 0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(this.you === 1 ? 'P1 BASE · TARGET GATES' : 'P1 BASE', this.offsetX, y);
    ctx.fillStyle = 'rgba(255, 138, 76, 0.75)';
    ctx.textAlign = 'right';
    ctx.fillText(
      this.you === 0 ? 'P2 BASE · TARGET GATES' : 'P2 BASE',
      this.offsetX + this.mapW,
      y,
    );
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(141, 147, 163, 0.52)';
    ctx.font = `600 ${Math.max(6, fontSize - 1)}px ${FONT_MONO}`;
    ctx.fillText('BREACH AN UPPER OR LOWER GATE', this.offsetX + this.mapW / 2, y);
    ctx.restore();
  }
}
