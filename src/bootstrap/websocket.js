const { Server } = require('socket.io');

module.exports = async ({ strapi }) => {
  if (!strapi.server.httpServer) {
    strapi.log.warn('HTTP server not available, skipping WebSocket initialization');
    return;
  }

  // Initialize Socket.IO server
  const io = new Server(strapi.server.httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization'],
      credentials: true
    },
    transports: ['websocket'],
    pingTimeout: 60000,
  });

  // Debug middleware
  io.use((socket, next) => {
    strapi.log.debug('New socket connection attempt:', socket.id);
    next();
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const { token } = socket.handshake.auth;
      
      if (!token) {
        strapi.log.debug('No auth token provided for socket:', socket.id);
        return next(new Error('Authentication token not provided'));
      }

      // Verify JWT token
      const { id } = await strapi.plugins['users-permissions'].services.jwt.verify(token);
      
      // Attach user to socket
      socket.user = { id };
      strapi.log.debug('Socket authenticated for user:', id);
      next();
    } catch (error) {
      strapi.log.error('Socket authentication failed:', error);
      next(new Error('Authentication failed'));
    }
  });

  // Handle connections
  io.on('connection', (socket) => {
    strapi.log.info('New WebSocket connection:', socket.id, 'User:', socket.user?.id);

    // Join user's room
    if (socket.user?.id) {
      socket.join(`user_${socket.user.id}`);
      strapi.log.debug('User joined room:', `user_${socket.user.id}`);
    }

    socket.on('disconnect', (reason) => {
      strapi.log.info('Client disconnected:', socket.id, 'Reason:', reason);
      if (socket.user?.id) {
        socket.leave(`user_${socket.user.id}`);
      }
    });

    socket.on('error', (error) => {
      strapi.log.error('Socket error:', error);
    });
  });

  // Add lifecycle hooks for communication events
  const { afterCreate } = strapi.db.lifecycles;
  strapi.db.lifecycles.afterCreate = async (event) => {
    // Call original afterCreate if exists
    if (afterCreate) {
      await afterCreate(event);
    }

    // Handle new communications
    if (event.model.tableName === 'communications') {
      try {
        const { result } = event;
        
        // Get the full message data with populated relations
        const message = await strapi.entityService.findOne('api::communication.communication', result.id, {
          populate: ['sender', 'chatroom', 'chatroom.advertiser', 'chatroom.publisher', 'chatroom.order']
        });
        
        if (!message || !message.chatroom) {
          strapi.log.warn('Invalid message or chatroom for WebSocket notification');
          return;
        }

        const chatroom = message.chatroom;
        strapi.log.debug('Sending message notification for chatroom:', chatroom.id);
        
        // Emit to both advertiser and publisher
        const notificationData = {
          type: 'new_message',
          chatroomId: chatroom.id,
          orderId: chatroom.order?.id,
          message: {
            id: message.id,
            content: message.message,
            sender: {
              id: message.sender?.id,
              username: message.sender?.username
            },
            createdAt: message.createdAt,
            isUnread: true
          }
        };

        if (chatroom.advertiser?.id) {
          strapi.log.debug('Emitting to advertiser:', chatroom.advertiser.id);
          io.to(`user_${chatroom.advertiser.id}`).emit(`user_${chatroom.advertiser.id}_message`, notificationData);
        }
        
        if (chatroom.publisher?.id) {
          strapi.log.debug('Emitting to publisher:', chatroom.publisher.id);
          io.to(`user_${chatroom.publisher.id}`).emit(`user_${chatroom.publisher.id}_message`, notificationData);
        }
      } catch (error) {
        strapi.log.error('Error sending WebSocket notification:', error);
      }
    }
  };

  // Make io instance available globally
  strapi.io = io;

  strapi.log.info('WebSocket server initialized successfully');
}; 