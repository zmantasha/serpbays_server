'use strict';

const path = require('path');
const fs = require('fs');

const PRIVATE_DIR = path.join(process.cwd(), 'private', 'chat-attachments'); // NOT under /public — served only via the authenticated download route
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf', 'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'text/plain': '.txt', 'text/csv': '.csv', 'application/zip': '.zip' };

module.exports = ({ strapi }) => ({
  PRIVATE_DIR, MAX_BYTES, ALLOWED,

  /** Order with parties, or null. */
  async order(orderId) {
    const id = parseInt(orderId, 10); if (!Number.isFinite(id)) return null;
    return strapi.db.query('api::order.order').findOne({ where: { id }, select: ['id', 'orderStatus', 'createdAt', 'acceptedDate', 'deliveredDate', 'completedDate', 'websiteTat', 'revisionStatus', 'revisionRequestedAt'], populate: { advertiser: { select: ['id'] }, publisher: { select: ['id'] }, chatroom: { select: ['id'] } } });
  },
  party(order, userId) { if (order.advertiser?.id === userId) return 'advertiser'; if (order.publisher?.id === userId) return 'publisher'; return null; },
  other(order, userId) { return order.advertiser?.id === userId ? order.publisher?.id : order.advertiser?.id; },

  storeFile(orderId, file) {
    const ext = ALLOWED[file.mimetype || file.type]; if (!ext) throw new Error('File type not allowed. Use images, PDF, Word, text, CSV or ZIP.');
    if (file.size > MAX_BYTES) throw new Error('File is larger than 10 MB.');
    const dir = path.join(PRIVATE_DIR, String(orderId)); fs.mkdirSync(dir, { recursive: true });
    const safeName = String(file.originalFilename || file.name || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    const stored = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.copyFileSync(file.filepath || file.path, path.join(dir, stored));
    return { name: safeName, size: file.size, mime: file.mimetype || file.type, stored };
  },

  filePath(orderId, stored) { const p = path.join(PRIVATE_DIR, String(orderId), path.basename(stored)); return fs.existsSync(p) ? p : null; },
});
