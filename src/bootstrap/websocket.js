'use strict';

module.exports = ({ strapi }) => {
  // Initialize Socket.IO
const io = require('socket.io')(strapi.server.httpServer, {
  // DO NOT force ['websocket']; allow default (websocket+polling)
 cors: {
      origin:   "https://staging.serpbays.com",
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization'],
      transports: ['polling'],
      credentials: true,
    }

  });


  // Store connected users
  const connectedUsers = new Map();

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

      console.log(`User ${userId} connected via WebSocket`);

      // Store socket connection
      connectedUsers.set(parseInt(userId), socket);

      // Join user's room
      socket.join(`user_${userId}`);
      console.log(`User ${userId} joined room: user_${userId}`);

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`User ${userId} disconnected`);
        connectedUsers.delete(parseInt(userId));
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

  // Add helper methods
  strapi.io.emitToUser = (userId, event, data) => {
    const userSocket = connectedUsers.get(parseInt(userId));
    if (userSocket) {
      console.log(`✅ Emitting ${event} to user ${userId} with data:`, JSON.stringify(data, null, 2));
      userSocket.emit(event, data);
      return true;
    } else {
      console.log(`❌ User ${userId} not connected. Currently connected users:`, Array.from(connectedUsers.keys()));
      return false;
    }
  };

  // Add method to check connected users
  strapi.io.getConnectedUsers = () => {
    return Array.from(connectedUsers.keys());
  };

  // Log setup completion
  console.log('WebSocket server initialized successfully');
}; 