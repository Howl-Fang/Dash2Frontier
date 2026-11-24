import { randomInt, randomUUID } from 'node:crypto';

import { CONFIG, DIRECTIONS, SKILLS } from '../shared/config.js';
import { Game } from './game.js';
import { generateMap } from './map.js';

const LOBBY_DISCONNECT_GRACE_MS = 20_000;
const EMPTY_ROOM_GRACE_MS = 90_000;

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name || 'Miner';
}

/** Room codes are 5 digits. Non-numeric characters are ignored, so a pasted
 * code with spaces still works, and leading zeros are preserved. */
export function normalizeCode(raw, length) {
  return String(raw ?? '')
    .replace(/\D/g, '')
    .slice(0, length);
}

const playerPublic = (player, index) =>
  player
    ? {
        index,
        name: player.name,
        connected: player.connected,
      }
    : null;

export class RoomManager {
  constructor(io, config = CONFIG) {
    this.io = io;
    this.config = { ...CONFIG, ...config };
    this.rooms = new Map();
  }

  getRoomCount() {
    return this.rooms.size;
  }

  createRoom(socket, rawName) {
    if (this.#roomForSocket(socket)) {
      return { ok: false, error: 'room', message: 'You are already in a room.' };
    }
    if (this.rooms.size >= this.config.maxRooms) {
      return { ok: false, error: 'capacity', message: 'The mine is full right now.' };
    }

    const code = this.#newCode();
    const token = randomUUID();
    const name = cleanName(rawName);
    const player = {
      index: 0,
      token,
      name,
      socketId: socket.id,
      connected: true,
    };
    const room = {
      code,
      players: [player, null],
      game: null,
      loop: null,
      lastTick: 0,
      lastSnapshot: null,
      result: null,
      resultEmitted: false,
      rematchReady: [false, false],
      lobbyTimer: null,
      cleanupTimer: null,
    };

    this.rooms.set(code, room);
    this.#bindSocket(socket, room, player);
    socket.join(code);
    this.#emitRoomUpdate(room);

    return { ok: true, code, token, you: 0, name };
  }

  joinRoom(socket, rawCode, rawName) {
    if (this.#roomForSocket(socket)) {
      return { ok: false, error: 'room', message: 'You are already in a room.' };
    }
    const code = normalizeCode(rawCode, this.config.roomCodeLength);
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, error: 'not-found', message: 'Room not found.' };
    }
    if (room.players.filter(Boolean).length >= 2) {
      return { ok: false, error: 'full', message: 'That room is full.' };
    }
    if (room.game) {
      return { ok: false, error: 'started', message: 'That match has already started.' };
    }
    const seat = room.players[0] ? 1 : 0;
    if (seat < 0) {
      return { ok: false, error: 'full', message: 'That room is full.' };
    }

    const player = {
      index: seat,
      token: randomUUID(),
      name: cleanName(rawName),
      socketId: socket.id,
      connected: true,
    };
    room.players[seat] = player;
    this.#bindSocket(socket, room, player);
    socket.join(code);
    this.#emitRoomUpdate(room);

    if (room.players.filter(Boolean).length === 2) {
      // Let the join acknowledgement and lobby update reach the client before
      // the match payload starts the countdown.
      setTimeout(() => this.#startGame(room), 80);
    }

    return { ok: true, code, token: player.token, you: seat, name: player.name };
  }

  resumeRoom(socket, rawCode, rawToken) {
    const code = normalizeCode(rawCode, this.config.roomCodeLength);
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, error: 'not-found', message: 'That room is no longer available.' };
    }
    const token = String(rawToken ?? '');
    const seat = room.players.findIndex((player) => player && player.token === token);
    if (seat < 0) {
      return { ok: false, error: 'not-found', message: 'Your seat is no longer available.' };
    }
    if (this.#roomForSocket(socket) && this.#roomForSocket(socket) !== room) {
      return { ok: false, error: 'room', message: 'You are already in another room.' };
    }

    const player = room.players[seat];
    if (player.socketId && player.socketId !== socket.id) {
      const previousSocket = this.io.sockets.sockets.get(player.socketId);
      // Replace the stale connection before disconnecting it, so its close
      // handler cannot mark the freshly resumed player as offline.
      player.socketId = socket.id;
      if (previousSocket) previousSocket.disconnect(true);
    } else {
      player.socketId = socket.id;
    }
    player.connected = true;
    this.#bindSocket(socket, room, player);
    socket.join(room.code);
    this.#clearTimers(room);
    if (room.game) room.game.setConnected(seat, true);

    const bothConnected = room.players.every((entry) => entry && entry.connected);
    const shouldAutoRematch =
      room.game?.phase === 'finished' &&
      bothConnected &&
      room.rematchReady.every(Boolean);

    this.#emitRoomUpdate(room);
    if (shouldAutoRematch) {
      this.#startGame(room, { rematch: true });
    } else {
      this.#sendGameState(room, player);
      if (!room.game && bothConnected && room.players.filter(Boolean).length === 2) {
        setTimeout(() => this.#startGame(room), 60);
      }
    }

    return { ok: true, code: room.code, token: player.token, you: seat, name: player.name };
  }

  leaveRoom(socket) {
    const room = this.#roomForSocket(socket);
    if (!room) return { ok: true };
    this.#closeRoom(room, 'left');
    return { ok: true };
  }

  handleDisconnect(socket) {
    const room = this.#roomForSocket(socket);
    if (!room) return;
    const player = room.players.find((entry) => entry && entry.socketId === socket.id);
    if (!player) return;

    player.connected = false;
    player.socketId = null;
    if (room.game) room.game.setConnected(player.index, false);
    this.#emitRoomUpdate(room);

    if (!room.game && !room.lobbyTimer) {
      room.lobbyTimer = setTimeout(() => {
        room.lobbyTimer = null;
        if (!room.game && room.players.some((entry) => entry && !entry.connected)) {
          this.#closeRoom(room, 'disconnected');
        }
      }, LOBBY_DISCONNECT_GRACE_MS);
    }

    if (!room.players.some((entry) => entry && entry.connected) && !room.cleanupTimer) {
      room.cleanupTimer = setTimeout(() => {
        room.cleanupTimer = null;
        if (!room.players.some((entry) => entry && entry.connected)) {
          this.#closeRoom(room, 'abandoned');
        }
      }, EMPTY_ROOM_GRACE_MS);
    }
  }

  input(socket, direction) {
    const context = this.#contextForSocket(socket);
    if (!context) return { ok: false, error: 'room' };
    const { room, player } = context;
    if (!room.game) return { ok: false, error: 'game' };
    if (direction !== null && !DIRECTIONS[direction]) {
      return { ok: false, error: 'direction' };
    }
    return room.game.setDirection(player.index, direction);
  }

  castSkill(socket, skillId, payload = {}) {
    const context = this.#contextForSocket(socket);
    if (!context) {
      return { ok: false, error: 'room', message: 'You are not in a room.' };
    }
    const { room, player } = context;
    if (!room.game) {
      return { ok: false, error: 'game', message: 'The match is not running.' };
    }
    if (!SKILLS[skillId]) {
      return { ok: false, error: 'skill', message: 'Unknown skill.' };
    }
    return room.game.castSkill(player.index, skillId, payload);
  }

  setCheat(socket, enabled) {
    const context = this.#contextForSocket(socket);
    if (!context) {
      return { ok: false, error: 'room', message: 'You are not in a room.' };
    }
    const { room, player } = context;
    if (!room.game) {
      return { ok: false, error: 'game', message: 'The match is not running.' };
    }
    return room.game.setCheat(player.index, enabled);
  }

  rematch(socket) {
    const context = this.#contextForSocket(socket);
    if (!context) {
      return { ok: false, error: 'room', message: 'You are not in a room.' };
    }
    const { room, player } = context;
    if (!room.game || room.game.phase !== 'finished') {
      return { ok: false, error: 'phase', message: 'The match is still running.' };
    }
    if (room.rematchReady[player.index]) {
      return { ok: true, waiting: true };
    }

    room.rematchReady[player.index] = true;
    this.#emitRoomUpdate(room);

    if (room.rematchReady.every(Boolean)) {
      const bothConnected = room.players.every((entry) => entry && entry.connected);
      if (bothConnected) {
        this.#startGame(room, { rematch: true });
      }
    }
    return { ok: true };
  }

  closeAll() {
    for (const room of [...this.rooms.values()]) {
      this.#closeRoom(room, 'server-shutdown');
    }
  }

  #newCode() {
    const digits = this.config.roomCodeDigits || '0123456789';
    let code = '';
    do {
      code = Array.from(
        { length: this.config.roomCodeLength },
        () => digits[randomInt(digits.length)],
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  #bindSocket(socket, room, player) {
    socket.data.roomCode = room.code;
    socket.data.token = player.token;
    socket.data.seat = player.index;
  }

  #roomForSocket(socket) {
    const code = socket.data?.roomCode;
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players[socket.data.seat];
    if (!player || player.token !== socket.data.token) return null;
    return room;
  }

  #contextForSocket(socket) {
    const room = this.#roomForSocket(socket);
    if (!room) return null;
    const player = room.players[socket.data.seat];
    if (!player || player.socketId !== socket.id) return null;
    return { room, player };
  }

  #startGame(room, { rematch = false } = {}) {
    if (!this.rooms.has(room.code)) return;
    if (room.game && room.game.phase !== 'finished') return;
    const players = room.players.filter(Boolean);
    if (players.length < 2 || players.some((player) => !player.connected)) return;

    this.#clearTimers(room);
    if (room.loop) {
      clearInterval(room.loop);
      room.loop = null;
    }

    const map = generateMap({ config: this.config });
    room.game = new Game({
      map,
      players: room.players.map((player) => ({ name: player.name })),
      config: this.config,
    });
    room.lastSnapshot = null;
    room.result = null;
    room.resultEmitted = false;
    room.rematchReady = [false, false];
    room.lastTick = performance.now();

    this.#emitRoomUpdate(room);
    for (const player of room.players) {
      if (player) this.#sendGameInit(room, player);
    }

    room.loop = setInterval(() => this.#tick(room), this.config.tickMs);
    if (rematch) {
      this.#emitRoomUpdate(room);
    }
  }

  #tick(room) {
    if (!this.rooms.has(room.code) || !room.game) return;
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - room.lastTick) / 1000));
    room.lastTick = now;

    room.game.update(dt);
    const events = room.game.takeEvents();
    const snapshot = room.game.snapshot();
    room.lastSnapshot = snapshot;

    if (events.length > 0) {
      this.io.to(room.code).emit('game:fx', { events });
    }
    this.io.to(room.code).emit('game:snapshot', snapshot);

    if (snapshot.phase === 'finished' && !room.resultEmitted) {
      room.resultEmitted = true;
      room.result = room.game.getResult();
      this.io.to(room.code).emit('game:over', room.result);
      if (room.loop) {
        clearInterval(room.loop);
        room.loop = null;
      }
      this.#emitRoomUpdate(room);
    }
  }

  #initPayload(room, seat) {
    return {
      code: room.code,
      you: seat,
      map: {
        cols: room.game.map.cols,
        rows: room.game.map.rows,
        cells: [...room.game.map.cells],
        seed: room.game.map.seed,
      },
      players: room.players.map((player, index) =>
        player ? { index, name: player.name } : null,
      ),
      matchSeconds: this.config.matchSeconds,
      countdownSeconds: this.config.countdownSeconds,
    };
  }

  #sendGameInit(room, player) {
    if (!player.socketId) return;
    this.io.to(player.socketId).emit('game:init', this.#initPayload(room, player.index));
    if (room.lastSnapshot) {
      const snapshot = { ...room.lastSnapshot, blocks: [] };
      this.io.to(player.socketId).emit('game:snapshot', snapshot);
    }
    if (room.result) {
      this.io.to(player.socketId).emit('game:over', room.result);
    }
  }

  #sendGameState(room, player) {
    if (!room.game) return;
    this.#sendGameInit(room, player);
  }

  #emitRoomUpdate(room) {
    if (!this.rooms.has(room.code)) return;
    for (const player of room.players) {
      if (!player || !player.socketId) continue;
      this.io.to(player.socketId).emit('room:update', {
        code: room.code,
        phase: room.game ? room.game.phase : 'lobby',
        you: player.index,
        players: room.players.map(playerPublic),
        rematchReady: [...room.rematchReady],
      });
    }
  }

  #clearTimers(room) {
    if (room.lobbyTimer) {
      clearTimeout(room.lobbyTimer);
      room.lobbyTimer = null;
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
  }

  #closeRoom(room, reason) {
    if (!this.rooms.has(room.code)) return;
    this.rooms.delete(room.code);
    this.#clearTimers(room);
    if (room.loop) {
      clearInterval(room.loop);
      room.loop = null;
    }

    for (const player of room.players) {
      if (!player || !player.socketId) continue;
      const socket = this.io.sockets.sockets.get(player.socketId);
      if (!socket) continue;
      socket.emit('room:closed', { code: room.code, reason, seat: player.index });
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.token = null;
      socket.data.seat = null;
    }
  }
}
