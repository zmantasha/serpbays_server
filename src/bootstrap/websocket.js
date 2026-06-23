'use strict';

module.exports = ({ strapi }) => {
  // Initialize Socket.IO
  const io = require('socket.io')(strapi.server.httpServer, {
    cors: {
      origin: [
        "http://localhost:3000",           // Development
        "https://staging.serpbays.com",    // Staging
        "https://serpbays.com",            // Production
        "https://www.serpbays.com"         // Production with www
      ],
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],  // Enable both WebSocket and polling
    allowEIO3: true,                       // Support Engine.IO v3 clients
    pingTimeout: 60000,                    // 60 seconds before timeout
    pingInterval: 25000,                   // Ping every 25 seconds
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Redis adapter — multi-pod fan-out.
  //
  // Without an adapter, Socket.IO rooms only span the local process. Pod A
  // emits to `user_42`; sockets connected to pod B (also belonging to user
  // 42) never receive the event. With the Redis adapter, every emit is
  // pub/sub-broadcast to every pod, and each pod delivers to its locally
  // connected sockets in the room.
  //
  // Gated on REDIS_URL so single-pod dev (no Redis) keeps working unchanged.
  // Failure to connect doesn't crash the boot — we log loudly and continue
  // with the default in-memory adapter. Ops noticed by the log on every
  // restart instead of silent multi-pod breakage.
  // ─────────────────────────────────────────────────────────────────────────
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const Redis = require('ioredis');
      const pubClient = new Redis(process.env.REDIS_URL, {
        // Cap reconnect attempts so a misconfigured URL doesn't burn CPU.
        // After this many tries Socket.IO falls back to local-only emits.
        maxRetriesPerRequest: 3,
        // Short connect timeout — boot should fail fast, not hang.
        connectTimeout: 5000,
      });
      const subClient = pubClient.duplicate();
      const logErr = (label) => (err) => {
        strapi.log?.error?.(`[WS][redis-adapter:${label}] ${err.message}`);
      };
      pubClient.on('error', logErr('pub'));
      subClient.on('error', logErr('sub'));
      io.adapter(createAdapter(pubClient, subClient));
      strapi.io_redis = { pubClient, subClient }; // exposed for seq counters
      console.log('[WS] Redis adapter attached — multi-pod fan-out enabled');
    } catch (err) {
      // Don't crash the server — fall back to in-memory adapter and log.
      // Production deployments running >1 pod will see staleness on the
      // affected pod; the log line is the signal to investigate.
      strapi.log?.error?.(`[WS] Redis adapter init failed — falling back to in-memory: ${err.message}`);
    }
  } else {
    console.log('[WS] REDIS_URL not set — using default in-memory adapter (single-pod only)');
  }


  // Track sockets per user. CRITICAL: the previous implementation stored
  // ONE socket per userId; a second tab/device replaced the first, and
  // emitToUser(userId, ...) only reached the latest tab. Two tabs from the
  // same user → only the most recent one saw wallet updates.
  // The Map below is kept for `getConnectedUsers()` introspection, but emit
  // routes via Socket.IO ROOMS (multi-socket safe).
  const connectedUsers = new Map();   // userId → Set<socket.id>
  const trackUserSocket = (userId, socket) => {
    const uid = parseInt(userId);
    if (!connectedUsers.has(uid)) connectedUsers.set(uid, new Set());
    connectedUsers.get(uid).add(socket.id);
  };
  const untrackUserSocket = (userId, socket) => {
    const uid = parseInt(userId);
    const set = connectedUsers.get(uid);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) connectedUsers.delete(uid);
  };

  // Track admin sockets separately for fan-out + introspection. Whether
  // a user is an admin is decided at connect-time by loading their role
  // from the DB (the JWT claim alone is untrusted — role.type can change
  // without re-issuing the token). Admins additionally join the global
  // `admins` Socket.IO room so emitToAdmins() reaches every admin tab.
  const connectedAdmins = new Set(); // socket.id strings

  // Verify JWT token
  const verifyToken = async (token) => {
    try {
      const decoded = await strapi.plugins['users-permissions'].services.jwt.verify(token);
      return decoded;
    } catch (err) {
      console.error('WebSocket JWT verification failed:', err);
      return null;
    }
  };

  // Handle socket connection
  io.on('connection', async (socket) => {
    console.log('New WebSocket connection attempt');

    try {
      // Get token from handshake
      const token = socket.handshake.auth.token;
      if (!token) {
        console.error('No token provided');
        socket.disconnect();
        return;
      }

      // Verify token
      const decoded = await verifyToken(token);
      if (!decoded) {
        console.error('Invalid token');
        socket.disconnect();
        return;
      }

      const userId = socket.handshake.query.userId;
      if (!userId) {
        console.error('No userId provided');
        socket.disconnect();
        return;
      }

      // Defense-in-depth: cross-check that the userId in the query matches
      // the verified JWT's `id` claim. Pre-fix, a client could connect with
      // a valid JWT for user A and `userId=B` in the query — joining user
      // B's room and receiving B's events. Reject mismatches.
      if (Number.parseInt(userId, 10) !== Number.parseInt(decoded.id, 10)) {
        console.error(`[WS] userId mismatch — query=${userId} jwt.id=${decoded.id}; rejecting`);
        socket.disconnect();
        return;
      }

      console.log(`User ${userId} connected via WebSocket (socket ${socket.id})`);

      // Track this socket (allows multiple per user)
      trackUserSocket(userId, socket);

      // Join user's room — Socket.IO rooms support multi-socket membership.
      socket.join(`user_${userId}`);

      // Admin role check — must come from the DB, not the JWT claim. A
      // stale JWT issued before a role downgrade would otherwise keep
      // admin access live. Look up the user with their role and join
      // the `admins` room if they're an admin or super_admin.
      let isAdmin = false;
      try {
        const userWithRole = await strapi.entityService.findOne(
          'plugin::users-permissions.user',
          decoded.id,
          { populate: ['role'] }
        );
        const roleType = userWithRole?.role?.type;
        isAdmin = roleType === 'admin' || roleType === 'super_admin';
        if (isAdmin) {
          socket.join('admins');
          connectedAdmins.add(socket.id);
          console.log(`[WS] admin user ${userId} joined 'admins' room (role=${roleType})`);
        }
      } catch (roleErr) {
        // Non-fatal — admin loses live admin events but their user
        // channel still works. Logged for ops.
        console.warn(`[WS] role lookup failed for user ${userId}: ${roleErr.message}`);
      }

      // Handle disconnection
      socket.on('disconnect', () => {
        untrackUserSocket(userId, socket);
        if (isAdmin) connectedAdmins.delete(socket.id);
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error(`Socket error for user ${userId}:`, error);
      });

      // Send initial connection success
      socket.emit('connected', {
        status: 'success',
        userId,
        socketId: socket.id
      });

    } catch (error) {
      console.error('Error handling socket connection:', error);
      socket.disconnect();
    }
  });

  // Store io instance in strapi
  strapi.io = io;

  // emitToUser — route via Socket.IO rooms so EVERY socket the user has
  // open (multi-tab, multi-device) receives the event. The boolean return
  // value reflects whether the user has any active socket — useful for
  // logging "user offline" diagnostics without spamming the log.
  strapi.io.emitToUser = (userId, event, data) => {
    const uid = parseInt(userId);
    if (!Number.isInteger(uid) || uid <= 0) return false;
    // Use room-based emit — io.to() targets every socket in that room.
    io.to(`user_${uid}`).emit(event, data);
    return connectedUsers.has(uid);
  };

  // Fan-out to every connected admin socket. Used by the emit helpers
  // (wallet, order, withdrawal, bank-transfer) to give panel20 a live
  // feed of every user's events without subscribing per-user. Admin-room
  // membership is decided at handshake-time via DB role lookup, not the
  // JWT claim, so a stale token from before a role downgrade cannot
  // sneak into the room.
  strapi.io.emitToAdmins = (event, data) => {
    io.to('admins').emit(event, data);
    return connectedAdmins.size > 0;
  };

  // Add method to check connected users
  strapi.io.getConnectedUsers = () => {
    return Array.from(connectedUsers.keys());
  };

  strapi.io.socketCount = (userId) => {
    const set = connectedUsers.get(parseInt(userId));
    return set ? set.size : 0;
  };

  strapi.io.adminSocketCount = () => connectedAdmins.size;

  // Log setup completion
  console.log('WebSocket server initialized successfully');
}; 