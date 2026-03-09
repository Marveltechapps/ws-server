require('dotenv').config();

const { createServer } = require('http');
const { Server: SocketServer } = require('socket.io');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

const WS_PORT = process.env.WS_PORT || 5050;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('[ws-server] FATAL: JWT_SECRET is not set. Exiting.');
  process.exit(1);
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://localhost:5000', 'http://localhost:5173'];

const isLocalOrigin = (o) =>
  typeof o === 'string' &&
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(o.trim());

const isLanOrigin = (o) =>
  typeof o === 'string' &&
  /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(
    o.trim()
  );

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((_req, res) => {
  if (_req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'ws-server',
        connectedClients: io ? io.engine.clientsCount : 0,
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
    origin: (origin, cb) => {
      if (!origin || origin === 'null') return cb(null, true);
      if (isLocalOrigin(origin) || isLanOrigin(origin)) return cb(null, true);
      if (process.env.NODE_ENV !== 'production') return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      console.warn(`[ws-server] CORS blocked: ${origin}`);
      cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// JWT authentication middleware
io.use((socket, next) => {
  const token =
    socket.handshake.auth.token ||
    socket.handshake.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return next(new Error('Authentication error: No token provided'));
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

// Connection handler
io.on('connection', (socket) => {
  console.log(
    `[ws-server] Client connected: ${socket.id} (user=${socket.userId}, role=${socket.role})`
  );

  if (socket.userId) socket.join(`user:${socket.userId}`);
  if (socket.role) socket.join(`role:${socket.role}`);

  socket.on('subscribe', (room) => {
    socket.join(room);
  });

  socket.on('unsubscribe', (room) => {
    socket.leave(room);
  });

  socket.on('disconnect', () => {
    console.log(`[ws-server] Client disconnected: ${socket.id}`);
  });
});

// ── Redis subscriber ──────────────────────────────────────────────────────────
const sub = new Redis(REDIS_URL);

sub.on('connect', () => {
  console.log(`[ws-server] Redis subscriber connected (${REDIS_URL})`);
});

sub.on('error', (err) => {
  console.error(`[ws-server] Redis subscriber error: ${err.message}`);
});

sub.subscribe('ws:role', 'ws:user', 'ws:room', 'ws:broadcast', 'ws:hhd', (err) => {
  if (err) {
    console.error(`[ws-server] Redis subscribe error: ${err.message}`);
  } else {
    console.log('[ws-server] Subscribed to Redis channels: ws:role, ws:user, ws:room, ws:broadcast, ws:hhd');
  }
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
        // HHD events use the same room conventions
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

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(WS_PORT, () => {
  console.log(`[ws-server] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[ws-server] Health check: http://localhost:${WS_PORT}/health`);
});

process.on('unhandledRejection', (err) => {
  console.error(`[ws-server] Unhandled rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[ws-server] Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[ws-server] SIGTERM received. Shutting down...');
  sub.quit();
  io.close();
  httpServer.close(() => process.exit(0));
});
