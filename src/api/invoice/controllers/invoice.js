'use strict';

/**
 * invoice controller
 *
 * Renders the wallet-deposit invoice as a PDF. The template uses an
 * enterprise palette — dark navy primary, coral accent, clean white
 * surfaces with hairline borders. Designed to read like a modern SaaS
 * invoice (Stripe / Linear) rather than a stock template.
 *
 * Sections (top-to-bottom):
 *   1. Header        — "SerpBays" wordmark (coral S + navy erpBays),
 *                      tagline, INVOICE title, invoice-number pill
 *   2. Top info row  — Issue Date / Status / Payment Method / TX ID
 *   3. Bill To card  — navy header, customer billing details w/ icons
 *      From card    — coral header, SerpBays contact details w/ icons
 *   4. Items table   — hairline borders, no fills
 *   5. Totals        — premium total box (coral border, light coral fill)
 *   6. Payment Sum.  — full payment-summary card (navy header)
 *   7. Notes         — "system-generated, no signature" + support line
 *   8. Footer        — © brand line
 *
 * Single A4 page for a normal one-line wallet-deposit invoice.
 */

const { createCoreController } = require('@strapi/strapi').factories;
const PDFDocument = require('pdfkit');

// ─── Brand palette ────────────────────────────────────────────────────
// Navy is the primary anchor; coral is the accent. Surfaces are clean
// white with hairline borders — no warm cream backgrounds. The whole
// palette is desaturated and quietly premium, matching enterprise-SaaS
// invoice conventions.
const COLORS = {
  navy:        '#1E2A47',
  navyDeep:    '#0F1A33',
  coral:       '#FF6B47',
  coralLight:  '#FFF1ED',
  text:        '#1F2937',
  textMuted:   '#6B7280',
  textSubtle:  '#9CA3AF',
  border:      '#E5E7EB',
  borderDark:  '#D1D5DB',
  white:       '#FFFFFF',
  bgSoft:      '#F9FAFB',
  successBg:   '#D1FAE5',
  successText: '#047857',
};

const SUPPORT_EMAIL    = process.env.INVOICE_SUPPORT_EMAIL    || 'support@serpbays.com';
const SUPPORT_PHONE    = process.env.INVOICE_SUPPORT_PHONE    || '';
const COMPANY_TAGLINE  = process.env.INVOICE_TAGLINE          || 'REACH  |  RANK  |  RESULT';
const COMPANY_SITE     = process.env.INVOICE_COMPANY_SITE     || 'www.serpbays.com';

// ─── Formatters ───────────────────────────────────────────────────────
const titleCase = (s) => {
  if (!s) return '';
  return String(s)
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
};

const gatewayName = (g) => {
  const m = { stripe: 'Stripe', paypal: 'PayPal', razorpay: 'Razorpay', system: 'SerpBays' };
  return m[String(g || '').toLowerCase()] || titleCase(g) || '—';
};

const gatewayLetter = (g) => {
  const m = { stripe: 'S', paypal: 'P', razorpay: 'R', system: 'S' };
  return m[String(g || '').toLowerCase()] || '?';
};

// Brand colors of each payment gateway — used to colour the small letter
// badge next to the gateway name (R / S / P).
const gatewayColor = (g) => {
  const m = { stripe: '#635BFF', paypal: '#003087', razorpay: '#3395FF', system: COLORS.navy };
  return m[String(g || '').toLowerCase()] || COLORS.navy;
};

const formatMoney = (amount, currency) => {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${(currency || 'USD').toUpperCase()} ${n.toFixed(2)}`;
  }
};

const formatDate = (raw) => {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

const formatDateTime = (raw) => {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date}  ${hh}:${mm} UTC`;
};

// Render date / time in the invoice display timezone (default IST since
// SerpBays' primary billing flows are India-based — GST, Razorpay INR).
// Override via INVOICE_TIMEZONE + INVOICE_TIMEZONE_LABEL env vars.
const INVOICE_TZ       = process.env.INVOICE_TIMEZONE       || 'Asia/Kolkata';
const INVOICE_TZ_LABEL = process.env.INVOICE_TIMEZONE_LABEL || 'IST';

const formatDateInTz = (raw) => {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: INVOICE_TZ,
    }).format(d);
  } catch { return d.toUTCString().slice(0, 16); }
};

const formatTimeInTz = (raw) => {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const t = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: INVOICE_TZ,
    }).format(d);
    return `${t} (${INVOICE_TZ_LABEL})`;
  } catch { return ''; }
};

// ─── Icon helpers — drawn with pdfkit primitives so we don't need a
// custom font. All icons fit a 11×11 box and accept a color.
const ICON_SIZE = 11;

const iconCalendar = (doc, x, y, color = COLORS.coral) => {
  doc.save().lineWidth(0.9).strokeColor(color);
  doc.roundedRect(x, y + 2, ICON_SIZE, ICON_SIZE - 2, 1).stroke();
  doc.moveTo(x, y + 4.6).lineTo(x + ICON_SIZE, y + 4.6).stroke();
  doc.moveTo(x + 2.5, y).lineTo(x + 2.5, y + 3).stroke();
  doc.moveTo(x + ICON_SIZE - 2.5, y).lineTo(x + ICON_SIZE - 2.5, y + 3).stroke();
  doc.restore();
};

const iconEmail = (doc, x, y, color = COLORS.coral) => {
  doc.save().lineWidth(0.9).strokeColor(color);
  doc.rect(x, y + 1.5, ICON_SIZE, ICON_SIZE - 3).stroke();
  doc.moveTo(x, y + 1.5)
     .lineTo(x + ICON_SIZE / 2, y + ICON_SIZE / 2 + 0.5)
     .lineTo(x + ICON_SIZE, y + 1.5)
     .stroke();
  doc.restore();
};

const iconPhone = (doc, x, y, color = COLORS.coral) => {
  doc.save().lineWidth(0.9).strokeColor(color);
  doc.roundedRect(x + 2, y + 0.5, ICON_SIZE - 4, ICON_SIZE - 1, 1.5).stroke();
  doc.moveTo(x + 4, y + ICON_SIZE - 2).lineTo(x + ICON_SIZE - 4, y + ICON_SIZE - 2).stroke();
  doc.restore();
};

const iconPin = (doc, x, y, color = COLORS.coral) => {
  doc.save();
  doc.fillColor(color);
  doc.circle(x + ICON_SIZE / 2, y + ICON_SIZE / 2 - 0.5, ICON_SIZE / 3).fill();
  doc.restore();
};

const iconGlobe = (doc, x, y, color = COLORS.coral) => {
  doc.save().lineWidth(0.9).strokeColor(color);
  const cx = x + ICON_SIZE / 2;
  const cy = y + ICON_SIZE / 2;
  const r = ICON_SIZE / 2 - 1;
  doc.circle(cx, cy, r).stroke();
  doc.moveTo(cx - r, cy).lineTo(cx + r, cy).stroke();
  doc.moveTo(cx, cy - r).lineTo(cx, cy + r).stroke();
  doc.restore();
};

const iconTag = (doc, x, y, color = COLORS.coral) => {
  doc.save().fillColor(color).font('Helvetica-Bold').fontSize(11);
  doc.text('#', x + 1.5, y - 1, { width: ICON_SIZE });
  doc.restore();
};

// Small filled rounded badge with gateway-specific bg + first letter.
// Used to identify Razorpay / Stripe / PayPal at-a-glance — stand-in for
// real brand logos which we can't redistribute as embedded PNGs.
const drawGatewayBadge = (doc, x, y, gateway, size = 18) => {
  doc.save();
  doc.roundedRect(x, y, size, size, 3).fillColor(gatewayColor(gateway)).fill();
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(size * 0.6)
     .text(gatewayLetter(gateway), x, y + size * 0.27, { width: size, align: 'center' });
  doc.restore();
};

// Draw a card with a coloured header band. Uses clip() so the header's
// bottom edge sits flush against the body while the card's top corners
// stay rounded. Avoids ugly path-arithmetic.
const drawCardWithHeader = (doc, x, y, w, h, headerH, headerColor) => {
  // Card body (white) + hairline border.
  doc.roundedRect(x, y, w, h, 6).fillColor(COLORS.white).fill();
  doc.roundedRect(x, y, w, h, 6).lineWidth(0.5).strokeColor(COLORS.border).stroke();
  // Header band, clipped to the card's rounded outline.
  doc.save();
  doc.roundedRect(x, y, w, h, 6).clip();
  doc.rect(x, y, w, headerH).fillColor(headerColor).fill();
  doc.restore();
};

// ─── Main renderer ───────────────────────────────────────────────────
const renderPdf = (doc, invoice, transaction) => {
  const PAGE_W = doc.page.width;       // A4 = 595.28
  const PAGE_H = doc.page.height;      // A4 = 841.89
  const MARGIN = 45;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const currency = invoice.currency || transaction?.metadata?.currency || 'USD';
  const gw = gatewayName(transaction?.gateway);

  // ─── 1. HEADER ──────────────────────────────────────────────────────
  const headerY = MARGIN;

  // Left: SerpBays wordmark — coral "S" inline with navy "erpBays".
  doc.font('Helvetica-Bold').fontSize(28).fillColor(COLORS.coral)
     .text('S', MARGIN, headerY, { continued: true });
  doc.fillColor(COLORS.navy)
     .text('erpBays', { continued: false });

  // Tagline below the wordmark.
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.navy)
     .text(COMPANY_TAGLINE, MARGIN, headerY + 34, { characterSpacing: 1.6 });

  // Right: INVOICE title + invoice-number pill in light coral.
  doc.font('Helvetica-Bold').fontSize(28).fillColor(COLORS.navy)
     .text('INVOICE', MARGIN, headerY, { width: CONTENT_W, align: 'right' });

  const pillText = invoice.invoiceNumber || '—';
  doc.font('Helvetica-Bold').fontSize(10);
  const pillTextW = doc.widthOfString(pillText);
  const pillW = Math.max(140, pillTextW + 28);
  const pillH = 22;
  const pillX = MARGIN + CONTENT_W - pillW;
  const pillY = headerY + 36;
  doc.roundedRect(pillX, pillY, pillW, pillH, 11).fillColor(COLORS.coralLight).fill();
  doc.fillColor(COLORS.coral)
     .text(pillText, pillX, pillY + 7, { width: pillW, align: 'center' });

  // ─── HAIRLINE DIVIDER ───────────────────────────────────────────────
  const dividerY = headerY + 72;
  doc.lineWidth(0.5).strokeColor(COLORS.border)
     .moveTo(MARGIN, dividerY).lineTo(MARGIN + CONTENT_W, dividerY).stroke();

  // ─── 2. TOP INFO ROW (Issue Date / Status / Payment Method / TX ID) ─
  const infoY = dividerY + 14;
  const cellW = CONTENT_W / 4;

  const labelFn = (label, x) =>
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.textMuted)
       .text(label, x, infoY, { characterSpacing: 1.0 });

  // Cell 1 — Issue Date.
  labelFn('ISSUE DATE', MARGIN);
  iconCalendar(doc, MARGIN, infoY + 16);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLORS.navy)
     .text(formatDate(invoice.invoiceDate), MARGIN + 16, infoY + 17, { width: cellW - 20 });

  // Cell 2 — Status pill (green, with dot).
  labelFn('STATUS', MARGIN + cellW);
  const statusLabel = (transaction?.transactionStatus || invoice.status || 'paid').toUpperCase();
  const statusText = /^(PAID|SUCCESS)$/.test(statusLabel) ? 'PAID' : statusLabel;
  doc.font('Helvetica-Bold').fontSize(8.5);
  const stW = doc.widthOfString(statusText) + 28;
  const stX = MARGIN + cellW;
  const stY = infoY + 14;
  doc.roundedRect(stX, stY, stW, 20, 10).fillColor(COLORS.successBg).fill();
  doc.circle(stX + 10, stY + 10, 2.5).fillColor(COLORS.successText).fill();
  doc.fillColor(COLORS.successText)
     .text(statusText, stX + 17, stY + 6);

  // Cell 3 — Payment Method (gateway badge + name).
  labelFn('PAYMENT METHOD', MARGIN + cellW * 2);
  drawGatewayBadge(doc, MARGIN + cellW * 2, infoY + 14, transaction?.gateway, 20);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLORS.navy)
     .text(gw, MARGIN + cellW * 2 + 26, infoY + 18);

  // Cell 4 — Transaction ID.
  labelFn('TRANSACTION ID', MARGIN + cellW * 3);
  iconTag(doc, MARGIN + cellW * 3, infoY + 16);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLORS.navy)
     .text(String(transaction?.id ?? '—'), MARGIN + cellW * 3 + 14, infoY + 17, { width: cellW - 14 });

  // ─── 3. BILL TO / FROM CARDS ────────────────────────────────────────
  const cardsY = infoY + 52;
  const cardGap = 14;
  const cardW = (CONTENT_W - cardGap) / 2;
  const cardH = 134;
  const cardHeaderH = 28;

  // — Bill To card (navy header)
  drawCardWithHeader(doc, MARGIN, cardsY, cardW, cardH, cardHeaderH, COLORS.navy);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.white)
     .text('BILL TO', MARGIN + 14, cardsY + 10, { characterSpacing: 1.4 });

  // Bill To body.
  let bY = cardsY + cardHeaderH + 12;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.navy)
     .text(invoice.billingName || 'Customer', MARGIN + 14, bY, { width: cardW - 28 });
  bY += 18;

  if (invoice.billingAddress) {
    iconPin(doc, MARGIN + 14, bY + 1);
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
       .text(invoice.billingAddress, MARGIN + 30, bY, { width: cardW - 44 });
    bY += 14;
  }
  const cityPin = [invoice.billingCity, invoice.billingPincode].filter(Boolean).join(' ');
  if (cityPin) {
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
       .text(cityPin, MARGIN + 30, bY, { width: cardW - 44 });
    bY += 14;
  }
  if (invoice.billingCountry) {
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
       .text(invoice.billingCountry, MARGIN + 30, bY, { width: cardW - 44 });
    bY += 14;
  }
  if (invoice.billingVatGst) {
    iconTag(doc, MARGIN + 14, bY);
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
       .text(`GST: ${invoice.billingVatGst}`, MARGIN + 30, bY + 1, { width: cardW - 44 });
  }

  // — From card (coral header)
  const fromX = MARGIN + cardW + cardGap;
  drawCardWithHeader(doc, fromX, cardsY, cardW, cardH, cardHeaderH, COLORS.coral);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.white)
     .text('FROM', fromX + 14, cardsY + 10, { characterSpacing: 1.4 });

  let fY = cardsY + cardHeaderH + 12;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.navy)
     .text('SerpBays', fromX + 14, fY);
  fY += 18;

  iconEmail(doc, fromX + 14, fY + 1);
  doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
     .text(SUPPORT_EMAIL, fromX + 30, fY);
  fY += 14;

  iconGlobe(doc, fromX + 14, fY + 1);
  doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
     .text(COMPANY_SITE, fromX + 30, fY);
  fY += 14;

  if (SUPPORT_PHONE) {
    iconPhone(doc, fromX + 14, fY + 1);
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.textMuted)
       .text(SUPPORT_PHONE, fromX + 30, fY);
  }

  // ─── 4. ITEMS TABLE — hairline borders, no fills ───────────────────
  const tableY = cardsY + cardH + 24;
  const xDesc = MARGIN;
  const xType = MARGIN + 240;
  const xQty  = MARGIN + 320;
  const xUnit = MARGIN + 360;
  const xAmt  = MARGIN + CONTENT_W - 70;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.textMuted);
  doc.text('DESCRIPTION', xDesc, tableY, { characterSpacing: 1.0 });
  doc.text('TYPE',        xType, tableY, { characterSpacing: 1.0 });
  doc.text('QTY',         xQty,  tableY, { width: 40, align: 'center', characterSpacing: 1.0 });
  doc.text('UNIT PRICE',  xUnit, tableY, { width: 80, align: 'right', characterSpacing: 1.0 });
  doc.text('AMOUNT',      xAmt,  tableY, { width: 70, align: 'right', characterSpacing: 1.0 });

  doc.lineWidth(0.5).strokeColor(COLORS.borderDark)
     .moveTo(MARGIN, tableY + 16).lineTo(MARGIN + CONTENT_W, tableY + 16).stroke();

  const items = Array.isArray(invoice.lineItems) && invoice.lineItems.length
    ? invoice.lineItems
    : [{ description: 'Wallet Deposit', quantity: 1, unitPrice: invoice.totalAmount, amount: invoice.totalAmount }];

  let rowY = tableY + 26;
  items.forEach((item) => {
    const desc = item.description || 'Wallet Deposit';
    const itemType = titleCase(transaction?.type) === 'Deposit' ? 'Deposit' : titleCase(transaction?.type || 'deposit');
    const qty = item.quantity ?? 1;
    const unit = Number(item.unitPrice ?? item.amount ?? 0);
    const total = Number(item.amount ?? item.total ?? unit * qty);

    doc.font('Helvetica').fontSize(10.5).fillColor(COLORS.text);
    doc.text(desc, xDesc, rowY, { width: 220 });
    doc.fillColor(COLORS.textMuted).text(itemType, xType, rowY, { width: 70 });
    doc.fillColor(COLORS.text).text(String(qty), xQty, rowY, { width: 40, align: 'center' });
    doc.text(formatMoney(unit, currency), xUnit, rowY, { width: 80, align: 'right' });
    doc.font('Helvetica-Bold').fillColor(COLORS.navy)
       .text(formatMoney(total, currency), xAmt, rowY, { width: 70, align: 'right' });
    rowY += 22;
  });

  doc.lineWidth(0.5).strokeColor(COLORS.border)
     .moveTo(MARGIN, rowY + 2).lineTo(MARGIN + CONTENT_W, rowY + 2).stroke();

  // ─── 5. TOTALS — Subtotal/Tax stacked above premium Total box ──────
  const totalsY = rowY + 16;
  const totalsX = MARGIN + CONTENT_W - 240;

  doc.font('Helvetica').fontSize(10).fillColor(COLORS.textMuted)
     .text('Subtotal', totalsX, totalsY, { width: 130, align: 'right' });
  doc.fillColor(COLORS.text)
     .text(formatMoney(invoice.subtotal || 0, currency), totalsX + 130, totalsY, { width: 110, align: 'right' });

  doc.fillColor(COLORS.textMuted)
     .text('Tax', totalsX, totalsY + 16, { width: 130, align: 'right' });
  doc.fillColor(COLORS.text)
     .text(formatMoney(invoice.taxAmount || 0, currency), totalsX + 130, totalsY + 16, { width: 110, align: 'right' });

  // Premium total box — light coral fill + 1pt coral border + navy type.
  const totalBoxY = totalsY + 38;
  const totalBoxW = 240;
  const totalBoxH = 48;
  doc.roundedRect(totalsX, totalBoxY, totalBoxW, totalBoxH, 6).fillColor(COLORS.coralLight).fill();
  doc.roundedRect(totalsX, totalBoxY, totalBoxW, totalBoxH, 6)
     .lineWidth(1).strokeColor(COLORS.coral).stroke();

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.navy)
     .text('TOTAL', totalsX + 16, totalBoxY + 10, { characterSpacing: 1.4 });
  doc.fontSize(7.5).fillColor(COLORS.textMuted)
     .text(currency.toUpperCase(), totalsX + 16, totalBoxY + 26, { characterSpacing: 1.0 });
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.navy)
     .text(formatMoney(invoice.totalAmount || 0, currency), totalsX + 16, totalBoxY + 14, { width: totalBoxW - 32, align: 'right' });

  // ─── 6. PAYMENT SUMMARY — horizontal 4-column card ────────────────
  const psY = totalBoxY + totalBoxH + 24;
  const psH = 96;

  // Card: white bg + hairline border (no coloured header band — keeps
  // the visual weight on the column content itself).
  doc.roundedRect(MARGIN, psY, CONTENT_W, psH, 8).fillColor(COLORS.white).fill();
  doc.roundedRect(MARGIN, psY, CONTENT_W, psH, 8)
     .lineWidth(0.5).strokeColor(COLORS.border).stroke();

  const psColW = CONTENT_W / 4;

  // Soft vertical dividers between columns (don't reach the card edges).
  for (let i = 1; i < 4; i++) {
    const dx = MARGIN + psColW * i;
    doc.lineWidth(0.5).strokeColor(COLORS.border)
       .moveTo(dx, psY + 14).lineTo(dx, psY + psH - 14).stroke();
  }

  const psPad = 16;
  const colLabel = (label, x) =>
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLORS.textMuted)
       .text(label, x + psPad, psY + 16, { characterSpacing: 1.0 });

  // — Col 1: Payment Method ───────────────────────────────────────
  const c1x = MARGIN + psColW * 0;
  colLabel('PAYMENT METHOD', c1x);
  drawGatewayBadge(doc, c1x + psPad, psY + 40, transaction?.gateway, 24);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.navy)
     .text(gw, c1x + psPad + 32, psY + 47, { width: psColW - psPad - 32 });

  // — Col 2: Payment Date & Time ──────────────────────────────────
  const c2x = MARGIN + psColW * 1;
  colLabel('PAYMENT DATE & TIME', c2x);
  const txWhen = transaction?.updatedAt || transaction?.createdAt || invoice.invoiceDate;
  iconCalendar(doc, c2x + psPad, psY + 42);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.navy)
     .text(formatDateInTz(txWhen), c2x + psPad + 16, psY + 41, { width: psColW - psPad - 20 });
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.textMuted)
     .text(formatTimeInTz(txWhen), c2x + psPad + 16, psY + 55, { width: psColW - psPad - 20 });

  // — Col 3: Payment Status ───────────────────────────────────────
  const c3x = MARGIN + psColW * 2;
  colLabel('PAYMENT STATUS', c3x);
  const psStatusMap = {
    PAID:    { label: 'PAID',    bg: COLORS.successBg, text: COLORS.successText },
    SUCCESS: { label: 'PAID',    bg: COLORS.successBg, text: COLORS.successText },
    FAILED:  { label: 'FAILED',  bg: '#FEE2E2',        text: '#B91C1C' },
    PENDING: { label: 'PENDING', bg: '#FEF3C7',        text: '#92400E' },
    DENIED:  { label: 'DENIED',  bg: '#FEE2E2',        text: '#B91C1C' },
    REFUNDED:{ label: 'REFUNDED',bg: '#E0E7FF',        text: '#3730A3' },
  };
  const stUpper = String(transaction?.transactionStatus || invoice.status || 'paid').toUpperCase();
  const st = psStatusMap[stUpper] || { label: stUpper, bg: COLORS.bgSoft, text: COLORS.textMuted };
  doc.font('Helvetica-Bold').fontSize(10);
  const stPillW = Math.max(80, doc.widthOfString(st.label) + 32);
  const stPillX = c3x + psPad;
  const stPillY = psY + 42;
  doc.roundedRect(stPillX, stPillY, stPillW, 24, 12).fillColor(st.bg).fill();
  doc.circle(stPillX + 11, stPillY + 12, 3).fillColor(st.text).fill();
  doc.fillColor(st.text)
     .text(st.label, stPillX + 18, stPillY + 7, { width: stPillW - 22, align: 'left', characterSpacing: 0.8 });

  // — Col 4: Amount Paid ──────────────────────────────────────────
  const c4x = MARGIN + psColW * 3;
  colLabel('AMOUNT PAID', c4x);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.navy)
     .text(formatMoney(invoice.totalAmount, currency), c4x + psPad, psY + 40, { width: psColW - psPad * 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.textMuted)
     .text(currency.toUpperCase(), c4x + psPad, psY + 62, { characterSpacing: 1.0 });

  // Sub-line: gateway audit references (compact, monospace) just under
  // the card. Preserves the Order ID / Payment ID that the previous
  // (vertical) layout surfaced, without re-cluttering the new card.
  const refsY = psY + psH + 12;
  const refOrder = transaction?.gatewayTransactionId
    ? `Order ID  ${transaction.gatewayTransactionId}`
    : null;
  const refPay = transaction?.external_transaction_id
    ? `Payment ID  ${transaction.external_transaction_id}`
    : null;
  const refLine = [refOrder, refPay].filter(Boolean).join('   ·   ');
  if (refLine) {
    doc.font('Courier').fontSize(9).fillColor(COLORS.textMuted)
       .text(refLine, MARGIN, refsY, { width: CONTENT_W, align: 'center' });
  }

  // ─── 7. NOTES + SUPPORT ────────────────────────────────────────────
  // Sit just above the footer divider so the lower half of the page
  // doesn't drift into a big void.
  const notesY = (PAGE_H - 48) - 38;
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.textSubtle)
     .text('This invoice is system-generated and is valid without a signature.',
       MARGIN, notesY, { width: CONTENT_W, align: 'center' });

  const supportLine = SUPPORT_PHONE
    ? `Support: ${SUPPORT_EMAIL}  ·  ${SUPPORT_PHONE}`
    : `Support: ${SUPPORT_EMAIL}`;
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.textMuted)
     .text(supportLine, MARGIN, notesY + 14, { width: CONTENT_W, align: 'center' });

  // ─── 8. FOOTER ─────────────────────────────────────────────────────
  const footerY = PAGE_H - 48;
  doc.lineWidth(0.5).strokeColor(COLORS.border)
     .moveTo(MARGIN, footerY).lineTo(MARGIN + CONTENT_W, footerY).stroke();

  const year = new Date(invoice.invoiceDate || Date.now()).getUTCFullYear();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.coral)
     .text('S', MARGIN, footerY + 12, { continued: true });
  doc.fillColor(COLORS.navy)
     .text('erpBays', { continued: true });
  doc.fillColor(COLORS.textSubtle)
     .text(`  ·  © ${year}  ·  ${COMPANY_SITE}`, { continued: false });
};

module.exports = createCoreController('api::invoice.invoice', ({ strapi }) => ({
  /**
   * Download an invoice PDF.
   * Route: GET /api/invoices/:id/download
   */
  async download(ctx) {
    try {
      const { id } = ctx.params;
      const userId = ctx.state.user?.id;

      if (!userId) {
        return ctx.unauthorized('You must be logged in to download invoices.');
      }

      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Invoice not found');
      }

      // Populate `user` with id only — pre-fix populated the full up_users
      // row (password hash, withdrawalOtp, paypal_email, billing PII)
      // even though only user.id is needed for the ownership check.
      const invoice = await strapi.entityService.findOne('api::invoice.invoice', numericId, {
        populate: { user: { fields: ['id'] } }
      });

      if (!invoice || invoice.user?.id !== userId) {
        // 404 (not 403) on cross-tenant — defeat invoice-id enumeration
        // (sequential integer ids are guessable).
        return ctx.notFound('Invoice not found');
      }

      // Fetch the originating transaction so the PDF can show gateway,
      // payment IDs, paid-at timestamp, etc. The invoice schema doesn't
      // store these directly — invoice.transactionId is a stringified
      // tx id. Tolerate a missing/deleted transaction (render with —).
      let transaction = null;
      const txId = Number(invoice.transactionId);
      if (Number.isInteger(txId) && txId > 0) {
        transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { id: txId },
        });
      }

      // Bottom margin is intentionally tighter than top/sides so the
      // footer block (notes + support + copyright) lands above pdfkit's
      // auto-pagination threshold (page.height - bottomMargin).
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 45, left: 45, right: 45, bottom: 25 },
      });

      ctx.status = 200;
      ctx.response.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`,
        'Transfer-Encoding': 'chunked',
      });

      return new Promise((resolve, reject) => {
        doc.on('error', (err) => {
          console.error('Error generating PDF:', err);
          reject(err);
        });
        doc.pipe(ctx.response.res);
        try {
          renderPdf(doc, invoice, transaction);
          doc.end();
          doc.on('end', () => resolve());
        } catch (pdfError) {
          console.error('Error during PDF generation:', pdfError);
          reject(pdfError);
        }
      }).catch((error) => {
        console.error('Error in PDF generation promise:', error);
        return ctx.internalServerError('Error generating invoice PDF');
      });
    } catch (error) {
      console.error('Error in download controller:', error);
      return ctx.internalServerError('Error generating invoice PDF');
    }
  },
}));
