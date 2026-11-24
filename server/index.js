import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import { CONFIG } from '../shared/config.js';
import { RoomManager } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const callAck = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

export function createGameServer({ config = {} } = {}) {
  const mergedConfig = { ...CONFIG, ...config };
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/shared', express.static(path.join(ROOT, 'shared')));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      rooms: manager.getRoomCount(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    serveClient: true,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });
  const manager = new RoomManager(io, mergedConfig);

  io.on('connection', (socket) => {
    socket.on('room:create', (payload, ack) => {
      try {
        callAck(ack, manager.createRoom(socket, payload?.name));
      } catch (error) {
        console.error('room:create failed', error);
        callAck(ack, { ok: false, error: 'server', message: 'Could not create the room.' });
      }
    });

    socket.on('room:join', (payload, ack) => {
      try {
        callAck(ack, manager.joinRoom(socket, payload?.code, payload?.name));
      } catch (error) {
        console.error('room:join failed', error);
        callAck(ack, { ok: false, error: 'server', message: 'Could not join the room.' });
      }
    });

    socket.on('room:resume', (payload, ack) => {
      try {
        const result = manager.resumeRoom(socket, payload?.code, payload?.token);
        callAck(ack, result);
      } catch (error) {
        console.error('room:resume failed', error);
        callAck(ack, { ok: false, error: 'server', message: 'Could not resume the match.' });
      }
    });

    socket.on('room:leave', (payload, ack) => {
      try {
        callAck(ack, manager.leaveRoom(socket));
      } catch (error) {
        console.error('room:leave failed', error);
        callAck(ack, { ok: false, error: 'server' });
      }
    });

    socket.on('input:move', (payload) => {
      const direction = payload?.dir;
      if (direction !== null && typeof direction !== 'string') return;
      manager.input(socket, direction);
    });

    socket.on('skill:cast', (payload) => {
      try {
        const result = manager.castSkill(socket, payload?.skill, payload);
        if (!result.ok) {
          socket.emit('game:error', {
            error: result.error,
            message: result.message || 'That skill cannot be used right now.',
            skill: payload?.skill,
          });
        }
      } catch (error) {
        console.error('skill:cast failed', error);
        socket.emit('game:error', { error: 'server', message: 'The skill failed.' });
      }
    });

    socket.on('game:rematch', (payload, ack) => {
      try {
        callAck(ack, manager.rematch(socket));
      } catch (error) {
        console.error('game:rematch failed', error);
        callAck(ack, { ok: false, error: 'server', message: 'Could not rematch.' });
      }
    });

    socket.on('game:cheat', (payload, ack) => {
      try {
        callAck(ack, manager.setCheat(socket, payload?.enabled));
      } catch (error) {
        console.error('game:cheat failed', error);
        callAck(ack, { ok: false, error: 'server', message: 'Could not toggle cheat mode.' });
      }
    });

    socket.on('disconnect', () => {
      manager.handleDisconnect(socket);
    });
  });

  const listen = (port = Number(process.env.PORT) || mergedConfig.port) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve(httpServer.address().port);
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, '0.0.0.0');
    });

  const close = () =>
    new Promise((resolve) => {
      manager.closeAll();
      io.close(() => resolve());
    });

  return {
    app,
    httpServer,
    io,
    manager,
    config: mergedConfig,
    listen,
    close,
  };
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const gameServer = createGameServer();
  const port = await gameServer.listen();
  console.log(`Dash2Frontier is running at http://localhost:${port}`);
  for (const address of localAddresses()) {
    console.log(`  On your local network: http://${address}:${port}`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nClosing the mine...');
    await gameServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
