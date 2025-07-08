module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/chatrooms/order/:orderId',
      handler: 'chatroom.getOrCreateChatroom',
      config: {
        auth: {
          scope: ['api::chatroom.chatroom.getOrCreateChatroom']
        },
      },
    },
    {
      method: 'GET',
      path: '/chatrooms/user/conversations',
      handler: 'chatroom.getUserChatrooms',
      config: {
        auth: {
          scope: ['api::chatroom.chatroom.getUserChatrooms']
        },
      },
    },
    {
      method: 'POST',
      path: '/chatrooms/order/:orderId/mark-read',
      handler: 'chatroom.markMessagesAsRead',
      config: {
        auth: {
          scope: ['api::chatroom.chatroom.markMessagesAsRead']
        },
      },
    },
    {
      method: 'PUT',
      path: '/chatrooms/:id/status',
      handler: 'chatroom.updateStatus',
      config: {
        auth: {
          scope: ['api::chatroom.chatroom.updateStatus']
        },
      },
    },
    {
      method: 'GET',
      path: '/chatrooms/:id/transcript',
      handler: 'chatroom.downloadTranscript',
      config: {
        auth: {
          scope: ['api::chatroom.chatroom.downloadTranscript']
        },
      },
    },
    {
      method: 'GET',
      path: '/chatrooms/:id/conversation',
      handler: 'chatroom.getFullConversation',
      config: {
        auth: {
          scope: ['api::chatroom.chatroom.getFullConversation']
        },
      },
    },
    {
      method: 'GET',
      path: '/chatrooms/:id/admin-view',
      handler: 'chatroom.adminChatView',
      config: {
        auth: false,  // Make accessible for quick admin access
      },
    },
    {
      method: 'GET',
      path: '/chatrooms/admin',
      handler: 'chatroom.adminDashboard',
      config: {
        auth: false,  // Make accessible for quick admin access
      },
    },
  ],
}; 