const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', 'selorg-dashboard-backend-v1.1', '.env'),
];

const loadedEnvFiles = [];

for (const envPath of envCandidates) {
  if (!fs.existsSync(envPath)) {
    continue;
  }

  dotenv.config({ path: envPath, override: false });
  loadedEnvFiles.push(path.relative(__dirname, envPath));
}

const { createServer } = require('http');
const { Server: SocketServer } = require('socket.io');
const jwt = require('jsonwebtoken');
const { createCorsOriginHandler } = require('../selorg-dashboard-backend-v1.1/src/config/corsOrigins');

const WS_PORT = process.env.WS_PORT || 5050;
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const SKIP_REDIS = process.env.SKIP_REDIS === '1' || process.env.SKIP_REDIS === 'true';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error(
    `[ws-server] FATAL: JWT_SECRET is not set. Checked env files: ${loadedEnvFiles.join(', ') || 'none'}. Exiting.`
  );
  process.exit(1);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'ws-server',
        connectedClients: io ? io.engine.clientsCount : 0,
        redisRelay: Boolean(redisRelayEnabled),
        uptime: process.uptime(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
// Path must match dashboard frontend (websocket.ts) and Picker/HHD apps
const io = new SocketServer(httpServer, {
  path: '/hhd-socket.io',
  cors: {
    origin: createCorsOriginHandler((origin) => {
      console.warn(`[ws-server] CORS blocked: ${origin}`);
    }),
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// JWT authentication middleware (match embedded backend socket: optional token)
io.use((socket, next) => {
  const token =
    socket.handshake.auth.token ||
    socket.handshake.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.id || decoded.userId;
    socket.role = decoded.role || decoded.roleId;
    next();
  } catch (err) {
    console.warn(`[ws-server] Auth failed: ${err.message} (socket ${socket.id})`);
    next(new Error('Authentication error: Invalid token'));
  }
});

let redisRelayEnabled = false;
let pub = null;
let sub = null;

function attachRedisRelay() {
  if (!REDIS_URL || SKIP_REDIS) {
    console.log(
      '[ws-server] Redis relay disabled (set REDIS_URL for multi-process realtime; dashboard dev can use backend :3333 /hhd-socket.io instead)'
    );
    return;
  }

  let Redis;
  try {
    Redis = require('ioredis');
  } catch (err) {
    console.warn(`[ws-server] ioredis not available: ${err.message}`);
    return;
  }

  pub = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  sub = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    retryStrategy: () => null,
  });

  const onRedisError = (label, err) => {
    console.warn(`[ws-server] ${label}: ${err.message}`);
  };

  pub.on('error', (err) => onRedisError('Redis publisher', err));
  sub.on('error', (err) => onRedisError('Redis subscriber', err));

  pub.connect().catch((err) => {
    console.warn(`[ws-server] Redis publisher connect failed: ${err.message}`);
  });

  sub
    .connect()
    .then(() =>
      sub.subscribe('ws:role', 'ws:user', 'ws:room', 'ws:broadcast', 'ws:hhd', (err) => {
        if (err) {
          console.error(`[ws-server] Redis subscribe error: ${err.message}`);
          return;
        }
        redisRelayEnabled = true;
        console.log(
          '[ws-server] Redis relay active (channels: ws:role, ws:user, ws:room, ws:broadcast, ws:hhd)'
        );
      })
    )
    .catch((err) => {
      console.warn(`[ws-server] Redis subscriber connect failed: ${err.message}`);
    });

  sub.on('message', (channel, message) => {
    try {
      const payload = JSON.parse(message);
      const { target, event, data } = payload;

      switch (channel) {
        case 'ws:role':
          io.to(`role:${target}`).emit(event, data);
          break;
        case 'ws:user':
          io.to(`user:${target}`).emit(event, data);
          break;
        case 'ws:room':
          io.to(target).emit(event, data);
          break;
        case 'ws:broadcast':
          io.emit(event, data);
          break;
        case 'ws:hhd':
          if (payload.roomType === 'order') {
            io.to(`order:${target}`).emit(event, data);
          } else if (payload.roomType === 'user') {
            io.to(`user:${target}`).emit(event, data);
          } else {
            io.emit(event, data);
          }
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`[ws-server] Failed to process Redis message on ${channel}: ${err.message}`);
    }
  });
}

attachRedisRelay();

// Connection handler
io.on('connection', (socket) => {
  console.log(
    `[ws-server] Client connected: ${socket.id} (user=${socket.userId}, role=${socket.role})`
  );

  if (socket.userId) socket.join(`user:${socket.userId}`);
  if (socket.role) socket.join(`role:${socket.role}`);

  if (socket.role === 'darkstore' && pub) {
    pub.publish(
      'ws:request',
      JSON.stringify({
        event: 'get:live_orders',
        data: { storeId: '', status: 'all', limit: 100 },
        socketId: socket.id,
        userId: socket.userId,
        role: socket.role,
      })
    ).catch(() => {});
  }

  socket.on('get:live_orders', (params) => {
    if (!pub) return;
    pub.publish(
      'ws:request',
      JSON.stringify({
        event: 'get:live_orders',
        data: params,
        socketId: socket.id,
        userId: socket.userId,
        role: socket.role,
      })
    ).catch(() => {});
  });

  socket.on('subscribe', (room) => {
    socket.join(room);
  });

  socket.on('unsubscribe', (room) => {
    socket.leave(room);
  });

  socket.on('rider:location', (data) => {
    const { orderId, latitude, longitude, heading, speed } = data || {};
    if (!orderId) return;
    io.to(`order:${orderId}`).emit('rider:location:update', {
      orderId,
      latitude,
      longitude,
      heading,
      speed,
      timestamp: Date.now(),
      riderId: socket.userId,
    });
  });

  socket.on('track:order', (orderId) => {
    if (orderId) socket.join(`order:${orderId}`);
  });

  socket.on('untrack:order', (orderId) => {
    if (orderId) socket.leave(`order:${orderId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[ws-server] Client disconnected: ${socket.id}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(WS_PORT, () => {
  console.log(`[ws-server] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[ws-server] Socket.IO path: /hhd-socket.io`);
  console.log(`[ws-server] Health check: http://localhost:${WS_PORT}/health`);
  if (!redisRelayEnabled) {
    console.log(
      '[ws-server] Tip: For local dashboard dev without Redis, use backend embedded Socket.IO — leave VITE_WS_URL empty and run backend on port 3333.'
    );
  }
});

process.on('unhandledRejection', (err) => {
  console.error(`[ws-server] Unhandled rejection: ${err?.message || err}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[ws-server] Uncaught exception: ${err?.message || err}`);
  process.exit(1);
});

function shutdown() {
  console.log('[ws-server] Shutting down...');
  try {
    sub?.disconnect();
    pub?.disconnect();
  } catch {
    /* ignore */
  }
  io.close();
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
