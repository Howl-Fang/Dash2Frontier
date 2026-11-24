import test from 'node:test';
import assert from 'node:assert/strict';

import { io as createClient } from 'socket.io-client';

import { CONFIG } from '../shared/config.js';
import { createGameServer } from '../server/index.js';
import { normalizeCode } from '../server/room.js';

const fastConfig = (overrides = {}) => ({
  ...CONFIG,
  tickMs: 20,
  countdownSeconds: 0.05,
  matchSeconds: 0.4,
  ...overrides,
});

const waitFor = (socket, event, predicate = () => true, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const ackFor = (socket, event, payload, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ack`)), timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

const connectClient = async (port) => {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    transports: ['websocket'],
  });
  const connected = waitFor(socket, 'connect');
  socket.connect();
  await connected;
  return socket;
};

const closeServer = async (server, sockets) => {
  for (const socket of sockets) socket.disconnect();
  await server.close();
};

test('room code normalization keeps digits and leading zeros', () => {
  assert.equal(normalizeCode(' 01a23-4 ', 5), '01234');
  assert.equal(normalizeCode('00000', 5), '00000');
  assert.equal(normalizeCode('12 34 56', 5), '12345');
  assert.equal(normalizeCode('ABCDE', 5), '');
});

test('two clients can create and join a room and receive the match', async () => {
  const server = createGameServer({ config: fastConfig() });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    assert.equal(created.ok, true);
    assert.equal(created.you, 0);
    assert.equal(created.code.length, CONFIG.roomCodeLength);
    assert.match(created.code, /^\d{5}$/);
    assert.ok(created.token);

    const hostInitPromise = waitFor(host, 'game:init');
    const guestInitPromise = waitFor(guest, 'game:init');
    const joined = await ackFor(guest, 'room:join', {
      code: created.code,
      name: 'Bo',
    });
    assert.equal(joined.ok, true);
    assert.equal(joined.you, 1);

    const [hostInit, guestInit] = await Promise.all([hostInitPromise, guestInitPromise]);
    assert.equal(hostInit.you, 0);
    assert.equal(guestInit.you, 1);
    assert.equal(hostInit.map.cells.length, CONFIG.cols * CONFIG.rows);
    assert.deepEqual(hostInit.map.cells, guestInit.map.cells);
    assert.equal(hostInit.players[0].name, 'Ada');
    assert.equal(hostInit.players[1].name, 'Bo');

    const snapshot = await waitFor(host, 'game:snapshot', (state) => state.players.length === 2);
    assert.ok(['countdown', 'playing'].includes(snapshot.phase));
    assert.equal(snapshot.players[0].name, 'Ada');
    assert.equal(snapshot.players[1].name, 'Bo');
  } finally {
    await closeServer(server, sockets);
  }
});

test('mouse-targeted skill payloads reach the authoritative game', async () => {
  const server = createGameServer({ config: fastConfig({ matchSeconds: 5 }) });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostPlaying = waitFor(
      host,
      'game:snapshot',
      (snapshot) => snapshot.phase === 'playing',
      4000,
    );
    await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    await hostPlaying;

    const errorPromise = waitFor(host, 'game:error');
    host.emit('skill:cast', { skill: 'build', cells: [{ col: 0, row: 0 }] });
    const error = await errorPromise;
    assert.equal(error.skill, 'build');
    assert.equal(error.error, 'target');
  } finally {
    await closeServer(server, sockets);
  }
});

test('a third client cannot join a full room and a disconnected player can resume', async () => {
  const server = createGameServer({ config: fastConfig({ matchSeconds: 5 }) });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    const extra = await connectClient(port);
    sockets.push(host, guest, extra);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostInitPromise = waitFor(host, 'game:init');
    const guestInitPromise = waitFor(guest, 'game:init');
    const joined = await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    const [hostInit] = await Promise.all([hostInitPromise, guestInitPromise]);

    const full = await ackFor(extra, 'room:join', { code: created.code, name: 'Cy' });
    assert.equal(full.ok, false);
    assert.equal(full.error, 'full');

    guest.disconnect();
    const resumed = await connectClient(port);
    sockets.push(resumed);
    const resumedInitPromise = waitFor(resumed, 'game:init');
    const resume = await ackFor(resumed, 'room:resume', {
      code: created.code,
      token: joined.token,
    });
    assert.equal(resume.ok, true);
    assert.equal(resume.you, 1);
    const init = await resumedInitPromise;
    assert.equal(init.you, 1);
    assert.deepEqual(init.map.cells, hostInit.map.cells);
  } finally {
    await closeServer(server, sockets);
  }
});

test('both players can rematch after a timeout and receive a fresh game', async () => {
  const server = createGameServer({
    config: fastConfig({ countdownSeconds: 0.05, matchSeconds: 0.25 }),
  });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostInit = waitFor(host, 'game:init');
    const guestInit = waitFor(guest, 'game:init');
    await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    const [firstHostInit, firstGuestInit] = await Promise.all([hostInit, guestInit]);

    const [hostOver, guestOver] = await Promise.all([
      waitFor(host, 'game:over', () => true, 4000),
      waitFor(guest, 'game:over', () => true, 4000),
    ]);
    assert.equal(hostOver.reason, 'timeout');
    assert.equal(guestOver.winner, 'draw');

    const nextHostInit = waitFor(host, 'game:init');
    const nextGuestInit = waitFor(guest, 'game:init');
    const firstRematch = await ackFor(host, 'game:rematch', {});
    assert.equal(firstRematch.ok, true);
    const secondRematch = await ackFor(guest, 'game:rematch', {});
    assert.equal(secondRematch.ok, true);
    const [newHostInit, newGuestInit] = await Promise.all([nextHostInit, nextGuestInit]);
    assert.equal(newHostInit.map.cells.length, firstHostInit.map.cells.length);
    assert.equal(newGuestInit.you, 1);
    assert.notEqual(newHostInit.map.seed, firstHostInit.map.seed);
  } finally {
    await closeServer(server, sockets);
  }
});

test('leaving a room closes it for the other player', async () => {
  const server = createGameServer({ config: fastConfig({ matchSeconds: 5 }) });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostInit = waitFor(host, 'game:init');
    const guestInit = waitFor(guest, 'game:init');
    await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    await Promise.all([hostInit, guestInit]);

    const closed = waitFor(guest, 'room:closed');
    await ackFor(host, 'room:leave', {});
    const event = await closed;
    assert.equal(event.reason, 'left');
  } finally {
    await closeServer(server, sockets);
  }
});

test('a client can toggle cheat mode and freeze the rival', async () => {
  const server = createGameServer({ config: fastConfig({ matchSeconds: 8 }) });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostPlaying = waitFor(
      host,
      'game:snapshot',
      (snapshot) => snapshot.phase === 'playing',
      4000,
    );
    await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    await hostPlaying;

    const enabled = await ackFor(host, 'game:cheat', { enabled: true });
    assert.equal(enabled.ok, true);
    const frozen = await waitFor(
      host,
      'game:snapshot',
      (snapshot) => (snapshot.players?.[1]?.buffs?.freeze ?? 0) > 0,
      3000,
    );
    assert.ok(frozen.players[1].buffs.freeze > 0);

    const disabled = await ackFor(host, 'game:cheat', { enabled: false });
    assert.equal(disabled.ok, true);
  } finally {
    await closeServer(server, sockets);
  }
});

test('developer effects reach the selected target over the socket', async () => {
  const server = createGameServer({ config: fastConfig({ matchSeconds: 15 }) });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostPlaying = waitFor(
      host,
      'game:snapshot',
      (snapshot) => snapshot.phase === 'playing',
      4000,
    );
    await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    await hostPlaying;

    const fogged = await ackFor(host, 'dev:effect', { effect: 'fog', target: 'rival' });
    assert.equal(fogged.ok, true);
    const fogSnapshot = await waitFor(
      host,
      'game:snapshot',
      (snapshot) => (snapshot.players?.[1]?.buffs?.fog ?? 0) > 0,
      3000,
    );
    assert.ok(fogSnapshot.players[1].buffs.fog > 0);

    const exam = await ackFor(host, 'dev:effect', { effect: 'exam', target: 'self' });
    assert.equal(exam.ok, true);
    const examSnapshot = await waitFor(
      host,
      'game:snapshot',
      (snapshot) => Boolean(snapshot.players?.[0]?.exam?.questions?.length),
      3000,
    );
    assert.equal(examSnapshot.players[0].exam.questions.length, 3);
    assert.equal(examSnapshot.players[0].exam.questions[0].options.length, 4);
  } finally {
    await closeServer(server, sockets);
  }
});

test('a frozen player can mash direction keys to thaw', async () => {
  const server = createGameServer({ config: fastConfig({ matchSeconds: 15 }) });
  const port = await server.listen(0);
  const sockets = [];
  try {
    const host = await connectClient(port);
    const guest = await connectClient(port);
    sockets.push(host, guest);

    const created = await ackFor(host, 'room:create', { name: 'Ada' });
    const hostPlaying = waitFor(
      host,
      'game:snapshot',
      (snapshot) => snapshot.phase === 'playing',
      4000,
    );
    await ackFor(guest, 'room:join', { code: created.code, name: 'Bo' });
    await hostPlaying;

    const frozen = await ackFor(host, 'dev:effect', { effect: 'freeze', target: 'rival' });
    assert.equal(frozen.ok, true);
    await waitFor(
      host,
      'game:snapshot',
      (snapshot) => Boolean(snapshot.players?.[1]?.thaw),
      3000,
    );

    let thawed = null;
    for (let i = 0; i < 8; i += 1) {
      thawed = await ackFor(guest, 'game:thaw', {});
    }
    assert.equal(thawed.thawed, true);
  } finally {
    await closeServer(server, sockets);
  }
});
