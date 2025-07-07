'use strict';

/**
 * chatroom controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::chatroom.chatroom', ({ strapi }) => ({
  
  // Get or create chatroom for an order
  async getOrCreateChatroom(ctx) {
    const { orderId } = ctx.params;
    
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to access chatrooms');
      }
      
      // Check if the order exists and user is associated with it
      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['advertiser', 'publisher', 'chatroom'],
      });
      
      if (!order) {
        return ctx.notFound('Order not found');
      }
      
      // Check if user is associated with the order
      if (
        order.advertiser?.id !== user.id && 
        order.publisher?.id !== user.id
      ) {
        return ctx.forbidden('You are not authorized to access this chatroom');
      }
      
      let chatroom = order.chatroom;
      
      // Create chatroom if it doesn't exist
      if (!chatroom) {
        chatroom = await strapi.entityService.create('api::chatroom.chatroom', {
          data: {
            order: orderId,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date(),
          },
        });
      }
      
      // Get chatroom with all communications
      const populatedChatroom = await strapi.entityService.findOne('api::chatroom.chatroom', chatroom.id, {
        populate: ['order', 'advertiser', 'publisher', 'communications', 'communications.sender'],
      });
      
      return { data: populatedChatroom };
    } catch (error) {
      console.error('Error getting/creating chatroom:', error);
      return ctx.internalServerError('An error occurred while accessing the chatroom');
    }
  },
  
  // Get all chatrooms for current user
  async getUserChatrooms(ctx) {
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to view chatrooms');
      }
      
      // Find all chatrooms where user is either advertiser or publisher
      const chatrooms = await strapi.entityService.findMany('api::chatroom.chatroom', {
        filters: {
          $or: [
            { advertiser: user.id },
            { publisher: user.id }
          ]
        },
        populate: [
          'order', 
          'advertiser', 
          'publisher', 
          'communications', 
          'communications.sender'
        ],
        sort: { lastActivity: 'desc' }
      });
      
      // Process chatrooms to get conversation data
      const conversations = chatrooms.map(chatroom => {
        const communications = chatroom.communications || [];
        const otherParty = chatroom.advertiser?.id === user.id ? chatroom.publisher : chatroom.advertiser;
        
        if (communications.length === 0) {
          return {
            chatroomId: chatroom.id,
            orderId: chatroom.order?.id,
            orderTitle: `Order #${chatroom.order?.id}`,
            otherParty: {
              id: otherParty?.id,
              username: otherParty?.username,
              email: otherParty?.email
            },
            latestMessage: null,
            unreadCount: 0,
            totalMessages: 0,
            orderStatus: chatroom.order?.orderStatus,
            chatroomStatus: chatroom.status,
            lastActivity: chatroom.lastActivity,
          };
        }
        
        // Sort communications by creation date (latest first)
        const sortedComms = communications.sort((a, b) => 
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        
        const latestMessage = sortedComms[0];
        
        // Count unread messages (messages from other party that are newer than user's last message)
        const userMessages = sortedComms.filter(comm => comm.sender?.id === user.id);
        const otherMessages = sortedComms.filter(comm => comm.sender?.id !== user.id);
        
        const lastUserMessageTime = userMessages.length > 0 ? 
          new Date(userMessages[0].createdAt).getTime() : 0;
        
        const unreadCount = otherMessages.filter(comm => 
          new Date(comm.createdAt).getTime() > lastUserMessageTime
        ).length;
        
        return {
          chatroomId: chatroom.id,
          orderId: chatroom.order?.id,
          orderTitle: `Order #${chatroom.order?.id}`,
          otherParty: {
            id: otherParty?.id,
            username: otherParty?.username,
            email: otherParty?.email
          },
          latestMessage: {
            id: latestMessage.id,
            message: latestMessage.message,
            sender: latestMessage.sender,
            createdAt: latestMessage.createdAt,
            communicationStatus: latestMessage.communicationStatus
          },
          unreadCount,
          totalMessages: communications.length,
          orderStatus: chatroom.order?.orderStatus,
          chatroomStatus: chatroom.status,
          lastActivity: chatroom.lastActivity,
        };
      });
      
      // Sort conversations by latest activity
      conversations.sort((a, b) => 
        new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime()
      );
      
      return { 
        data: conversations,
        meta: {
          totalConversations: conversations.length,
          totalUnreadMessages: conversations.reduce((sum, conv) => sum + conv.unreadCount, 0)
        }
      };
    } catch (error) {
      console.error('Error fetching user chatrooms:', error);
      return ctx.internalServerError('An error occurred while fetching chatrooms');
    }
  },
  
  // Update chatroom status
  async updateStatus(ctx) {
    const { id } = ctx.params;
    const { status } = ctx.request.body;
    
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to update chatroom status');
      }
      
      // Check if the chatroom exists
      const chatroom = await strapi.entityService.findOne('api::chatroom.chatroom', id, {
        populate: ['advertiser', 'publisher'],
      });
      
      if (!chatroom) {
        return ctx.notFound('Chatroom not found');
      }
      
      // Check if user is associated with the chatroom
      if (
        chatroom.advertiser?.id !== user.id && 
        chatroom.publisher?.id !== user.id
      ) {
        return ctx.forbidden('You are not authorized to update this chatroom');
      }
      
      // Validate status
      if (!['active', 'closed', 'archived'].includes(status)) {
        return ctx.badRequest('Invalid status value');
      }
      
      // Update the chatroom status
      const updated = await strapi.entityService.update('api::chatroom.chatroom', id, {
        data: { status },
      });
      
      return { data: updated };
    } catch (error) {
      console.error('Error updating chatroom status:', error);
      return ctx.internalServerError('An error occurred while updating the chatroom status');
    }
  },
  
  // Download chat transcript (Admin functionality)
  async downloadTranscript(ctx) {
    const { id } = ctx.params;
    
    try {
      // Get chatroom with all communications
      const chatroom = await strapi.entityService.findOne('api::chatroom.chatroom', id, {
        populate: [
          'order', 
          'advertiser', 
          'publisher', 
          'communications',
          'communications.sender'
        ],
      });
      
      if (!chatroom) {
        return ctx.notFound('Chatroom not found');
      }
      
      // Sort communications by creation date
      const sortedComms = (chatroom.communications || []).sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      // Generate transcript
      const transcript = {
        chatroomInfo: {
          chatroomId: chatroom.id,
          orderId: chatroom.order?.id,
          orderStatus: chatroom.order?.orderStatus,
          chatroomStatus: chatroom.status,
          created: chatroom.createdAt,
          lastActivity: chatroom.lastActivity,
          participants: {
            advertiser: {
              id: chatroom.advertiser?.id,
              username: chatroom.advertiser?.username,
              email: chatroom.advertiser?.email
            },
            publisher: {
              id: chatroom.publisher?.id,
              username: chatroom.publisher?.username,
              email: chatroom.publisher?.email
            }
          }
        },
        messages: sortedComms.map(comm => ({
          id: comm.id,
          message: comm.message,
          sender: {
            id: comm.sender?.id,
            username: comm.sender?.username,
            email: comm.sender?.email,
            role: comm.sender?.id === chatroom.advertiser?.id ? 'Advertiser' : 'Publisher'
          },
          timestamp: comm.createdAt,
          status: comm.communicationStatus,
          // Flag potential contact information
          containsPotentialContact: /(\b\d{10,}\b|@\w+\.\w+|\b\w+@\w+\.\w+\b|whatsapp|telegram|skype|discord)/i.test(comm.message)
        })),
        summary: {
          totalMessages: sortedComms.length,
          messagesWithPotentialContacts: sortedComms.filter(comm => 
            /(\b\d{10,}\b|@\w+\.\w+|\b\w+@\w+\.\w+\b|whatsapp|telegram|skype|discord)/i.test(comm.message)
          ).length,
          lastMessageDate: sortedComms.length > 0 ? sortedComms[sortedComms.length - 1].createdAt : null
        }
      };
      
      // Set headers for file download
      ctx.set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="chatroom-${id}-transcript-${new Date().toISOString().split('T')[0]}.json"`
      });
      
      return transcript;
    } catch (error) {
      console.error('Error generating chat transcript:', error);
      return ctx.internalServerError('An error occurred while generating the chat transcript');
    }
  },
  
  // Get full conversation details for admin view
  async getFullConversation(ctx) {
    const { id } = ctx.params;
    
    try {
      // Get chatroom with all communications
      const chatroom = await strapi.entityService.findOne('api::chatroom.chatroom', id, {
        populate: [
          'order', 
          'advertiser', 
          'publisher', 
          'communications',
          'communications.sender'
        ],
      });
      
      if (!chatroom) {
        return ctx.notFound('Chatroom not found');
      }
      
      // Sort communications by creation date
      const sortedComms = (chatroom.communications || []).sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      // Process messages with additional metadata
      const processedMessages = sortedComms.map(comm => {
        const message = comm.message || '';
        
        // Detect potential contact information
        const phonePattern = /(\+?[\d\s\-\(\)]{10,})/g;
        const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const socialPattern = /(whatsapp|telegram|skype|discord|instagram|facebook|twitter|linkedin)/gi;
        const urlPattern = /(https?:\/\/[^\s]+)/g;
        
        const detectedContacts = {
          phones: message.match(phonePattern) || [],
          emails: message.match(emailPattern) || [],
          social: message.match(socialPattern) || [],
          urls: message.match(urlPattern) || []
        };
        
        const hasContact = Object.values(detectedContacts).some(arr => arr.length > 0);
        
        return {
          id: comm.id,
          message: message,
          sender: {
            id: comm.sender?.id,
            username: comm.sender?.username,
            email: comm.sender?.email,
            role: comm.sender?.id === chatroom.advertiser?.id ? 'Advertiser' : 'Publisher'
          },
          timestamp: comm.createdAt,
          status: comm.communicationStatus,
          flagged: hasContact,
          detectedContacts: hasContact ? detectedContacts : null,
          wordCount: message.split(/\s+/).filter(word => word.length > 0).length
        };
      });
      
      return {
        data: {
          chatroom: {
            id: chatroom.id,
            orderId: chatroom.order?.id,
            orderStatus: chatroom.order?.orderStatus,
            chatroomStatus: chatroom.status,
            created: chatroom.createdAt,
            lastActivity: chatroom.lastActivity,
            participants: {
              advertiser: {
                id: chatroom.advertiser?.id,
                username: chatroom.advertiser?.username,
                email: chatroom.advertiser?.email
              },
              publisher: {
                id: chatroom.publisher?.id,
                username: chatroom.publisher?.username,
                email: chatroom.publisher?.email
              }
            }
          },
          messages: processedMessages,
          statistics: {
            totalMessages: processedMessages.length,
            flaggedMessages: processedMessages.filter(m => m.flagged).length,
            totalWords: processedMessages.reduce((sum, m) => sum + m.wordCount, 0),
            messagesByUser: {
              advertiser: processedMessages.filter(m => m.sender.role === 'Advertiser').length,
              publisher: processedMessages.filter(m => m.sender.role === 'Publisher').length
            }
          }
        }
      };
    } catch (error) {
      console.error('Error getting full conversation:', error);
      return ctx.internalServerError('An error occurred while getting the conversation');
    }
  },
  
  // Admin HTML view for chat conversation
  async adminChatView(ctx) {
    const { id } = ctx.params;
    
    try {
      // Get chatroom with all communications
      const chatroom = await strapi.entityService.findOne('api::chatroom.chatroom', id, {
        populate: [
          'order', 
          'advertiser', 
          'publisher', 
          'communications',
          'communications.sender'
        ],
      });
      
      if (!chatroom) {
        return ctx.notFound('Chatroom not found');
      }
      
      // Sort communications by creation date
      const sortedComms = (chatroom.communications || []).sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      // Generate HTML for admin view
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chatroom ${id} - Admin View</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: #f8fafc;
            color: #334155;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { 
            background: white; 
            padding: 24px; 
            border-radius: 8px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin-bottom: 24px;
        }
        .chat-info { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 16px; }
        .info-card { background: #f1f5f9; padding: 16px; border-radius: 6px; }
        .info-card h3 { color: #475569; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
        .participants { display: flex; gap: 16px; margin-top: 16px; }
        .participant { 
            background: #e2e8f0; 
            padding: 12px 16px; 
            border-radius: 6px; 
            text-align: center;
            flex: 1;
        }
        .participant.advertiser { background: #dbeafe; color: #1e40af; }
        .participant.publisher { background: #dcfce7; color: #166534; }
        .actions { 
            display: flex; 
            gap: 12px; 
            margin-top: 16px;
            justify-content: flex-end;
        }
        .btn { 
            padding: 8px 16px; 
            border: none; 
            border-radius: 6px; 
            cursor: pointer; 
            font-weight: 500;
            text-decoration: none;
            display: inline-block;
        }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-secondary { background: #6b7280; color: white; }
        .btn:hover { opacity: 0.9; }
        .conversation { 
            background: white; 
            border-radius: 8px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .conversation-header { 
            background: #f8fafc; 
            padding: 16px 24px; 
            border-bottom: 1px solid #e2e8f0;
        }
        .message { 
            padding: 16px 24px; 
            border-bottom: 1px solid #f1f5f9;
            position: relative;
        }
        .message.flagged { 
            background: #fef2f2; 
            border-left: 4px solid #dc2626;
        }
        .message-header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 8px;
        }
        .sender { font-weight: 600; }
        .sender.advertiser { color: #1e40af; }
        .sender.publisher { color: #166534; }
        .timestamp { color: #6b7280; font-size: 12px; }
        .message-content { 
            white-space: pre-wrap; 
            word-wrap: break-word;
            margin-bottom: 8px;
        }
        .message-meta { 
            display: flex; 
            gap: 12px; 
            align-items: center;
            font-size: 12px;
            color: #6b7280;
        }
        .flag { 
            background: #dc2626; 
            color: white; 
            padding: 2px 6px; 
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
        }
        .status { 
            padding: 2px 6px; 
            border-radius: 4px; 
            font-size: 10px;
            font-weight: 500;
        }
        .status.requested { background: #fef3c7; color: #92400e; }
        .status.acceptance { background: #d1fae5; color: #065f46; }
        .status.in_progress { background: #dbeafe; color: #1e40af; }
        .search-box { 
            margin-bottom: 16px; 
            padding: 12px; 
            border: 1px solid #d1d5db; 
            border-radius: 6px; 
            width: 100%;
            font-size: 14px;
        }
        .stats { 
            display: grid; 
            grid-template-columns: repeat(4, 1fr); 
            gap: 16px; 
            margin-bottom: 24px;
        }
        .stat { 
            background: white; 
            padding: 16px; 
            border-radius: 6px; 
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .stat-value { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
        .stat-label { color: #6b7280; font-size: 12px; }
        .no-messages { 
            text-align: center; 
            padding: 48px; 
            color: #6b7280;
        }
        @media (max-width: 768px) {
            .chat-info { grid-template-columns: 1fr; }
            .participants { flex-direction: column; }
            .stats { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Chatroom #${id} - Admin View</h1>
            
            <div class="chat-info">
                <div class="info-card">
                    <h3>Order Information</h3>
                    <p><strong>Order ID:</strong> #${chatroom.order?.id || 'N/A'}</p>
                    <p><strong>Order Status:</strong> ${chatroom.order?.orderStatus || 'N/A'}</p>
                    <p><strong>Chatroom Status:</strong> ${chatroom.status}</p>
                </div>
                <div class="info-card">
                    <h3>Activity</h3>
                    <p><strong>Created:</strong> ${new Date(chatroom.createdAt).toLocaleString()}</p>
                    <p><strong>Last Activity:</strong> ${chatroom.lastActivity ? new Date(chatroom.lastActivity).toLocaleString() : 'N/A'}</p>
                </div>
            </div>
            
            <div class="participants">
                <div class="participant advertiser">
                    <strong>Advertiser</strong><br>
                    ${chatroom.advertiser?.username || 'N/A'}<br>
                    <small>${chatroom.advertiser?.email || 'N/A'}</small>
                </div>
                <div class="participant publisher">
                    <strong>Publisher</strong><br>
                    ${chatroom.publisher?.username || 'N/A'}<br>
                    <small>${chatroom.publisher?.email || 'N/A'}</small>
                </div>
            </div>
            
            <div class="actions">
                <a href="/api/chatrooms/${id}/transcript" class="btn btn-secondary" target="_blank">
                    Download Transcript
                </a>
                <button onclick="window.print()" class="btn btn-primary">
                    Print Conversation
                </button>
            </div>
        </div>
        
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${sortedComms.length}</div>
                <div class="stat-label">Total Messages</div>
            </div>
            <div class="stat">
                <div class="stat-value">${sortedComms.filter(comm => /(\b\d{10,}\b|@\w+\.\w+|\b\w+@\w+\.\w+\b|whatsapp|telegram|skype|discord)/i.test(comm.message || '')).length}</div>
                <div class="stat-label">Flagged Messages</div>
            </div>
            <div class="stat">
                <div class="stat-value">${sortedComms.filter(comm => comm.sender?.id === chatroom.advertiser?.id).length}</div>
                <div class="stat-label">Advertiser Messages</div>
            </div>
            <div class="stat">
                <div class="stat-value">${sortedComms.filter(comm => comm.sender?.id === chatroom.publisher?.id).length}</div>
                <div class="stat-label">Publisher Messages</div>
            </div>
        </div>
        
        <div class="conversation">
            <div class="conversation-header">
                <h2>Conversation Messages</h2>
                <input type="text" placeholder="Search messages..." class="search-box" id="searchBox" onkeyup="filterMessages()">
            </div>
            
            ${sortedComms.length === 0 ? `
                <div class="no-messages">
                    <p>No messages in this conversation yet.</p>
                </div>
            ` : sortedComms.map((comm, index) => {
                const message = comm.message || '';
                const isFlagged = /(\b\d{10,}\b|@\w+\.\w+|\b\w+@\w+\.\w+\b|whatsapp|telegram|skype|discord)/i.test(message);
                const senderRole = comm.sender?.id === chatroom.advertiser?.id ? 'advertiser' : 'publisher';
                
                return `
                    <div class="message ${isFlagged ? 'flagged' : ''}" data-message-id="${comm.id}">
                        <div class="message-header">
                            <span class="sender ${senderRole}">
                                ${comm.sender?.username || 'Unknown'} (${senderRole})
                            </span>
                            <span class="timestamp">${new Date(comm.createdAt).toLocaleString()}</span>
                        </div>
                        <div class="message-content">${message}</div>
                        <div class="message-meta">
                            <span class="status ${comm.communicationStatus}">${comm.communicationStatus}</span>
                            ${isFlagged ? '<span class="flag">FLAGGED</span>' : ''}
                            <span>Message #${index + 1}</span>
                            <span>ID: ${comm.id}</span>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    </div>
    
    <script>
        function filterMessages() {
            const searchTerm = document.getElementById('searchBox').value.toLowerCase();
            const messages = document.querySelectorAll('.message');
            
            messages.forEach(message => {
                const content = message.querySelector('.message-content').textContent.toLowerCase();
                const sender = message.querySelector('.sender').textContent.toLowerCase();
                
                if (content.includes(searchTerm) || sender.includes(searchTerm)) {
                    message.style.display = 'block';
                } else {
                    message.style.display = 'none';
                }
            });
        }
        
        // Highlight flagged messages on load
        document.addEventListener('DOMContentLoaded', function() {
            const flaggedMessages = document.querySelectorAll('.message.flagged');
            console.log('Found ' + flaggedMessages.length + ' flagged messages with potential contact information');
        });
    </script>
</body>
</html>`;
      
      ctx.set('Content-Type', 'text/html');
      return html;
    } catch (error) {
      console.error('Error generating admin chat view:', error);
      return ctx.internalServerError('An error occurred while generating the chat view');
    }
  },
  
  // Admin dashboard for all chatrooms
  async adminDashboard(ctx) {
    try {
      // Get all chatrooms with basic info
      const chatrooms = await strapi.entityService.findMany('api::chatroom.chatroom', {
        populate: ['order', 'advertiser', 'publisher', 'communications'],
        sort: { lastActivity: 'desc' }
      });
      
      // Process chatrooms data
      const processedChatrooms = chatrooms.map(chatroom => {
        const communications = chatroom.communications || [];
        const flaggedCount = communications.filter(comm => 
          /(\b\d{10,}\b|@\w+\.\w+|\b\w+@\w+\.\w+\b|whatsapp|telegram|skype|discord)/i.test(comm.message || '')
        ).length;
        
        return {
          id: chatroom.id,
          orderId: chatroom.order?.id,
          orderStatus: chatroom.order?.orderStatus,
          status: chatroom.status,
          created: chatroom.createdAt,
          lastActivity: chatroom.lastActivity,
          advertiser: chatroom.advertiser?.username || 'N/A',
          advertiserEmail: chatroom.advertiser?.email || 'N/A',
          publisher: chatroom.publisher?.username || 'N/A',
          publisherEmail: chatroom.publisher?.email || 'N/A',
          messageCount: communications.length,
          flaggedCount
        };
      });
      
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chatroom Admin Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: #f8fafc;
            color: #334155;
            line-height: 1.6;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .header { 
            background: white; 
            padding: 24px; 
            border-radius: 8px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin-bottom: 24px;
            text-align: center;
        }
        .search-filter { 
            background: white; 
            padding: 16px; 
            border-radius: 8px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin-bottom: 24px;
            display: flex;
            gap: 16px;
            align-items: center;
            flex-wrap: wrap;
        }
        .search-box, .filter-select { 
            padding: 8px 12px; 
            border: 1px solid #d1d5db; 
            border-radius: 6px; 
            font-size: 14px;
        }
        .search-box { flex: 1; min-width: 200px; }
        .table-container { 
            background: white; 
            border-radius: 8px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #f1f5f9; }
        th { background: #f8fafc; font-weight: 600; color: #475569; }
        .status { 
            padding: 4px 8px; 
            border-radius: 4px; 
            font-size: 12px;
            font-weight: 500;
        }
        .status.active { background: #d1fae5; color: #065f46; }
        .status.closed { background: #fee2e2; color: #991b1b; }
        .status.archived { background: #f3f4f6; color: #374151; }
        .order-status {
            padding: 4px 8px; 
            border-radius: 4px; 
            font-size: 12px;
            font-weight: 500;
        }
        .order-status.pending { background: #fef3c7; color: #92400e; }
        .order-status.accepted, .order-status.delivered { background: #dbeafe; color: #1e40af; }
        .order-status.completed { background: #d1fae5; color: #065f46; }
        .order-status.rejected, .order-status.cancelled { background: #fee2e2; color: #991b1b; }
        .btn { 
            padding: 6px 12px; 
            border: none; 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 12px;
            font-weight: 500;
            text-decoration: none;
            display: inline-block;
            margin: 2px;
        }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-secondary { background: #6b7280; color: white; }
        .btn-warning { background: #f59e0b; color: white; }
        .btn:hover { opacity: 0.9; }
        .actions { display: flex; gap: 4px; flex-wrap: wrap; }
        .flagged { background: #fef2f2; }
        .flagged-count { 
            background: #dc2626; 
            color: white; 
            padding: 2px 6px; 
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
        }
        .stats { 
            display: grid; 
            grid-template-columns: repeat(4, 1fr); 
            gap: 16px; 
            margin-bottom: 24px;
        }
        .stat { 
            background: white; 
            padding: 16px; 
            border-radius: 6px; 
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .stat-value { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
        .stat-label { color: #6b7280; font-size: 12px; }
        .refresh-btn { 
            background: #10b981; 
            color: white; 
            padding: 8px 16px; 
            border-radius: 6px; 
            text-decoration: none;
            font-weight: 500;
        }
        .filter-active { background: #3b82f6; color: white; }
        @media (max-width: 768px) {
            .stats { grid-template-columns: repeat(2, 1fr); }
            .search-filter { flex-direction: column; align-items: stretch; }
            .table-container { overflow-x: auto; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Chatroom Admin Dashboard</h1>
            <p>Monitor and manage all order-based conversations</p>
            <a href="/api/chatrooms/admin" class="refresh-btn" style="margin-top: 12px;">Refresh Data</a>
        </div>
        
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${processedChatrooms.length}</div>
                <div class="stat-label">Total Chatrooms</div>
            </div>
            <div class="stat">
                <div class="stat-value">${processedChatrooms.filter(c => c.status === 'active').length}</div>
                <div class="stat-label">Active Chats</div>
            </div>
            <div class="stat">
                <div class="stat-value">${processedChatrooms.reduce((sum, c) => sum + c.messageCount, 0)}</div>
                <div class="stat-label">Total Messages</div>
            </div>
            <div class="stat">
                <div class="stat-value">${processedChatrooms.reduce((sum, c) => sum + c.flaggedCount, 0)}</div>
                <div class="stat-label">Flagged Messages</div>
            </div>
        </div>
        
        <div class="search-filter">
            <input type="text" placeholder="Search by order ID, usernames, or emails..." class="search-box" id="searchBox" onkeyup="filterTable()">
            <select class="filter-select" id="statusFilter" onchange="filterTable()">
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="closed">Closed</option>
                <option value="archived">Archived</option>
            </select>
            <select class="filter-select" id="flaggedFilter" onchange="filterTable()">
                <option value="">All Messages</option>
                <option value="flagged">Has Flagged Messages</option>
                <option value="clean">No Flagged Messages</option>
            </select>
        </div>
        
        <div class="table-container">
            <table id="chatroomsTable">
                <thead>
                    <tr>
                        <th>Chatroom ID</th>
                        <th>Order Info</th>
                        <th>Participants</th>
                        <th>Messages</th>
                        <th>Status</th>
                        <th>Last Activity</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${processedChatrooms.map(chatroom => `
                        <tr class="${chatroom.flaggedCount > 0 ? 'flagged' : ''}" data-status="${chatroom.status}" data-flagged="${chatroom.flaggedCount > 0 ? 'flagged' : 'clean'}">
                            <td>
                                <strong>#${chatroom.id}</strong>
                            </td>
                            <td>
                                <div>Order #${chatroom.orderId || 'N/A'}</div>
                                <span class="order-status ${chatroom.orderStatus}">${chatroom.orderStatus || 'N/A'}</span>
                            </td>
                            <td>
                                <div><strong>A:</strong> ${chatroom.advertiser}</div>
                                <div style="font-size: 11px; color: #6b7280;">${chatroom.advertiserEmail}</div>
                                <div><strong>P:</strong> ${chatroom.publisher}</div>
                                <div style="font-size: 11px; color: #6b7280;">${chatroom.publisherEmail}</div>
                            </td>
                            <td>
                                <div>${chatroom.messageCount} messages</div>
                                ${chatroom.flaggedCount > 0 ? `<span class="flagged-count">${chatroom.flaggedCount} flagged</span>` : ''}
                            </td>
                            <td>
                                <span class="status ${chatroom.status}">${chatroom.status}</span>
                            </td>
                            <td>
                                ${chatroom.lastActivity ? new Date(chatroom.lastActivity).toLocaleDateString() : 'N/A'}
                                <div style="font-size: 11px; color: #6b7280;">
                                    ${chatroom.lastActivity ? new Date(chatroom.lastActivity).toLocaleTimeString() : ''}
                                </div>
                            </td>
                            <td>
                                <div class="actions">
                                    <a href="/api/chatrooms/${chatroom.id}/admin-view" target="_blank" class="btn btn-primary">View Chat</a>
                                    <a href="/api/chatrooms/${chatroom.id}/transcript" target="_blank" class="btn btn-secondary">Download</a>
                                    ${chatroom.flaggedCount > 0 ? `<span class="btn btn-warning">⚠ ${chatroom.flaggedCount} Flagged</span>` : ''}
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    </div>
    
    <script>
        function filterTable() {
            const searchTerm = document.getElementById('searchBox').value.toLowerCase();
            const statusFilter = document.getElementById('statusFilter').value;
            const flaggedFilter = document.getElementById('flaggedFilter').value;
            const rows = document.querySelectorAll('#chatroomsTable tbody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                const status = row.getAttribute('data-status');
                const flagged = row.getAttribute('data-flagged');
                
                const matchesSearch = text.includes(searchTerm);
                const matchesStatus = !statusFilter || status === statusFilter;
                const matchesFlagged = !flaggedFilter || flagged === flaggedFilter;
                
                if (matchesSearch && matchesStatus && matchesFlagged) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        }
    </script>
</body>
</html>`;
      
      ctx.set('Content-Type', 'text/html');
      return html;
    } catch (error) {
      console.error('Error generating admin dashboard:', error);
      return ctx.internalServerError('An error occurred while generating the admin dashboard');
    }
  }
})); 