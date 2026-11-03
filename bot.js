// ═══════════════════════════════════════════════════════════
// WhatsApp Bot — Final (Web QR + Self-Ping + Auto-View + Anti-Delete)
// ═══════════════════════════════════════════════════════════
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  proto
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// ═══════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception (kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection (kept alive):', reason);
});

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const NASHY_PHONE = '263733517788';
const NASHY_JID   = `${NASHY_PHONE}@s.whatsapp.net`;

const FEATURES = {
  autoViewStatus: process.env.AUTO_VIEW_STATUS !== 'off',
  antiDelete:     process.env.ANTI_DELETE      !== 'off',
  statusReact:    process.env.STATUS_REACT     === 'on'
};

const STORE_TTL_MS      = 24 * 60 * 60 * 1000;
const STORE_MAX_ENTRIES = 5000;
const STATUS_MIN_DELAY  = 2000;
const STATUS_MAX_DELAY  = 5000;
const STATUS_BLACKLIST  = new Set([]);
const STATUS_REACT_EMOJIS = ['🔥','❤️','👏','💯','🙌','😂','😮','✨'];

const SELF_PING_INTERVAL_MS = 10 * 60 * 1000;
const SELF_PING_URL = process.env.SELF_PING_URL ||
                      (process.env.RENDER_EXTERNAL_URL
                        ? `${process.env.RENDER_EXTERNAL_URL}/health`
                        : null);

const LOGGER = pino({ level: 'silent' });

// Runtime state
let currentQR = null;
let botConnected = false;

// ═══════════════════════════════════════════════════════════
// 1. MESSAGE STORE
// ═══════════════════════════════════════════════════════════
const messageStore = new Map();

function storeMessage(m) {
  if (!m.message || !m.key.id) return;
  const now = Date.now();
  messageStore.set(m.key.id, { message: m, storedAt: now });

  if (messageStore.size > STORE_MAX_ENTRIES) {
    const cutoff = now - STORE_TTL_MS;
    for (const [id, e] of messageStore) if (e.storedAt < cutoff) messageStore.delete(id);
    if (messageStore.size > STORE_MAX_ENTRIES) {
      const sorted = [...messageStore.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
      for (const [id] of sorted.slice(0, sorted.length - STORE_MAX_ENTRIES)) messageStore.delete(id);
    }
  }
}

setInterval(() => {
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [id, e] of messageStore) if (e.storedAt < cutoff) messageStore.delete(id);
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// 2. HELPERS
// ═══════════════════════════════════════════════════════════
async function getSenderPhone(sock, msg) {
  const pnField = msg.key.participantPn || msg.key.senderPn;
  if (pnField) return pnField.split('@')[0].split(':')[0];

  const fallbackJid = msg.key.participant || msg.key.remoteJid;
  if (!fallbackJid) return 'unknown';

  if (fallbackJid.endsWith('@lid')) {
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(fallbackJid);
      if (pn) return pn.split('@')[0].split(':')[0];
    } catch {}
  }
  return fallbackJid.split('@')[0].split(':')[0];
}

function getSenderName(msg) {
  return msg.pushName || 'Unknown';
}

// ═══════════════════════════════════════════════════════════
// 3. ANTI-DELETE
// ═══════════════════════════════════════════════════════════
async function forwardDeleted(sock, original) {
  if (!FEATURES.antiDelete) return;

  const senderPhone = await getSenderPhone(sock, original);
  const senderName  = getSenderName(original);
  const chatJid     = original.key.remoteJid;
  const isGroup     = chatJid?.endsWith('@g.us');

  const headerText = isGroup
    ? `🗑️ *Deleted in group*\n\n👤 ${senderName}\n📱 +${senderPhone}\n👥 ${chatJid.split('@')[0]}`
    : `🗑️ *Deleted message*\n\n👤 ${senderName}\n📱 +${senderPhone}`;

  try {
    await sock.sendMessage(NASHY_JID, { text: headerText });
  } catch { return; }

  const normalized = normalizeMessageContent(original.message);
  if (!normalized) return;

  const msgType = Object.keys(normalized)[0];
  const inner = normalized[msgType];

  try {
    if (msgType === 'conversation') {
      await sock.sendMessage(NASHY_JID, { text: `📝 ${normalized.conversation}` });
    } else if (msgType === 'extendedTextMessage') {
      await sock.sendMessage(NASHY_JID, { text: `📝 ${inner.text || ''}` });
    } else if (['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(msgType)) {
      const buffer = await downloadMediaMessage(
        { ...original, message: normalized }, 'buffer', {},
        { logger: LOGGER, reuploadRequest: sock.updateMediaMessage }
      );
      if (msgType === 'imageMessage')        await sock.sendMessage(NASHY_JID, { image: buffer, caption: inner.caption || '' });
      else if (msgType === 'videoMessage')   await sock.sendMessage(NASHY_JID, { video: buffer, caption: inner.caption || '' });
      else if (msgType === 'audioMessage')   await sock.sendMessage(NASHY_JID, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
      else if (msgType === 'stickerMessage') await sock.sendMessage(NASHY_JID, { sticker: buffer });
      else if (msgType === 'documentMessage')await sock.sendMessage(NASHY_JID, {
        document: buffer,
        mimetype: inner.mimetype || 'application/octet-stream',
        fileName: inner.fileName || 'file'
      });
    }
  } catch (e) {
    console.error('anti-delete forward failed:', e.message);
    try { await sock.sendMessage(NASHY_JID, { text: `⚠️ Could not forward media: ${e.message}` }); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
// 4. AUTO-VIEW STATUS
// ═══════════════════════════════════════════════════════════
const statusQueue = [];
let statusProcessing = false;
const viewedStatuses = new Map();

function shouldViewStatus(senderJid) {
  if (!FEATURES.autoViewStatus) return false;
  const phone = senderJid.split('@')[0].split(':')[0];
  return !STATUS_BLACKLIST.has(phone);
}

async function processStatusQueue(sock) {
  if (statusProcessing) return;
  statusProcessing = true;
  try {
    while (statusQueue.length > 0) {
      const job = statusQueue.shift();
      if (viewedStatuses.has(job.id)) continue;

      const delay = STATUS_MIN_DELAY + Math.floor(Math.random() * (STATUS_MAX_DELAY - STATUS_MIN_DELAY));
      await new Promise(r => setTimeout(r, delay));

      try {
        await sock.readMessages([{
          remoteJid: 'status@broadcast',
          id: job.id,
          participant: job.senderJid
        }]);

        if (FEATURES.statusReact) {
          const emoji = STATUS_REACT_EMOJIS[Math.floor(Math.random() * STATUS_REACT_EMOJIS.length)];
          try {
            await sock.sendMessage('status@broadcast', {
              react: {
                text: emoji,
                key: { remoteJid: 'status@broadcast', id: job.id, participant: job.senderJid }
              }
            });
          } catch {}
        }

        viewedStatuses.set(job.id, Date.now());
        console.log(`👁️ Viewed status from ${job.senderJid.split('@')[0]}`);
      } catch (e) {
        console.error('status view failed:', e.message);
      }
    }
  } finally {
    statusProcessing = false;
  }

  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [id, ts] of viewedStatuses) if (ts < cutoff) viewedStatuses.delete(id);
}

// ═══════════════════════════════════════════════════════════
// 5. HTTP SERVER (health + web QR)
// ═══════════════════════════════════════════════════════════
const app = express();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: botConnected,
    uptime: process.uptime(),
    storeSize: messageStore.size,
    features: FEATURES,
    timestamp: new Date().toISOString()
  });
});

// QR page (scan from phone browser)
app.get('/qr', async (req, res) => {
  if (botConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#0f0;">
        <h2>✅ Bot already connected</h2>
        <p>No QR needed. WhatsApp is linked.</p>
      </body></html>
    `);
  }
  if (!currentQR) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff;">
        <h2>⏳ Waiting for QR...</h2>
        <p>No QR available yet. Refresh in a few seconds.</p>
        <script>setTimeout(()=>location.reload(), 3000);</script>
      </body></html>
    `);
  }
  try {
    const dataUrl = await QRCode.toDataURL(currentQR, {
      width: 500,
      margin: 2,
      errorCorrectionLevel: 'M'
    });
    res.send(`
      <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:sans-serif;text-align:center;background:#111;color:#fff;padding:20px;margin:0}
      img{background:#fff;padding:20px;border-radius:12px;max-width:90vw;height:auto}
      h2{margin:10px 0}</style></head>
      <body>
        <h2>📱 Scan with WhatsApp</h2>
        <p>Linked Devices → Link a Device</p>
        <img src="${dataUrl}" alt="QR code" />
        <p style="color:#888;font-size:12px;margin-top:20px;">Page auto-refreshes in 45s to catch new QR</p>
        <script>setTimeout(()=>location.reload(), 45000);</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('QR generation failed: ' + e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server on :${PORT} — QR at /qr`));

// ═══════════════════════════════════════════════════════════
// 5b. SELF-PING
// ═══════════════════════════════════════════════════════════
if (SELF_PING_URL) {
  console.log(`🔄 Self-ping enabled: ${SELF_PING_URL} every ${SELF_PING_INTERVAL_MS / 60000} min`);
  const ping = async () => {
    try {
      const res = await fetch(SELF_PING_URL, { method: 'GET' });
      console.log(`🔄 Self-ping OK (${res.status})`);
    } catch (e) {
      console.error('🔄 Self-ping failed:', e.message);
    }
  };
  setTimeout(ping, 30_000);
  setInterval(ping, SELF_PING_INTERVAL_MS);
} else {
  console.log('ℹ️ Self-ping disabled');
}

// ═══════════════════════════════════════════════════════════
// 6. BOT BOOTSTRAP
// ═══════════════════════════════════════════════════════════
let reconnectAttempts = 0;
let presenceInterval = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: LOGGER,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    // CRITICAL: allow non-FULL history sync so LID mappings populate
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      currentQR = qr;
      botConnected = false;
      console.log(`📱 QR ready — open /qr in browser to scan`);
      // Optionally still print small terminal QR for local dev
      if (!process.env.RENDER) qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      botConnected = true;
      currentQR = null;
      console.log('✅ Connected!');
      console.log('🤖 Features:', FEATURES);

      if (presenceInterval) clearInterval(presenceInterval);
      presenceInterval = setInterval(async () => {
        try { await sock.sendPresenceUpdate('available'); } catch {}
      }, 45000);
      sock.sendPresenceUpdate('available').catch(() => {});
    }

    if (connection === 'close') {
      botConnected = false;
      if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }

      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        reconnectAttempts++;
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts - 1));
        console.log(`❌ Closed (${code}). Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(startBot, delay);
      } else {
        console.log('🚪 Logged out. Delete auth_info/ and restart.');
      }
    }
  });

  // ── Incoming messages ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid) continue;

        // Auto-view status
        if (jid === 'status@broadcast') {
          if (!FEATURES.autoViewStatus) continue;
          const senderJid = m.key.participant;
          if (!senderJid) continue;

          const myPhone = sock.user?.id?.split(':')[0];
          if (myPhone && senderJid.split('@')[0].split(':')[0] === myPhone) continue;
          if (!shouldViewStatus(senderJid)) continue;

          const normalized = normalizeMessageContent(m.message);
          const hasContent = normalized?.imageMessage || normalized?.videoMessage ||
                             normalized?.conversation || normalized?.extendedTextMessage;
          if (!hasContent) continue;

          statusQueue.push({ id: m.key.id, senderJid });
          processStatusQueue(sock).catch(() => {});
          continue;
        }

        if (jid.endsWith('@newsletter')) continue;

        storeMessage(m);
      } catch (e) {
        console.error('upsert handler error:', e.message);
      }
    }
  });

  // ── Anti-delete ──
  sock.ev.on('messages.update', async (updates) => {
    if (!FEATURES.antiDelete) return;
    for (const update of updates) {
      try {
        const isRevoke = update.update?.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
                         update.update?.messageStubType === 1 ||
                         update.update?.message === null;
        if (!isRevoke) continue;

        const deletedId = update.key?.id;
        if (!deletedId) continue;

        const cached = messageStore.get(deletedId);
        if (!cached) {
          console.log(`🗑️ Deletion detected but no cache for id=${deletedId}`);
          continue;
        }

        console.log(`🗑️ Forwarding deleted message id=${deletedId}`);
        forwardDeleted(sock, cached.message).catch(e =>
          console.error('anti-delete error:', e.message)
        );
      } catch (e) {
        console.error('update handler error:', e.message);
      }
    }
  });

  return sock;
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

startBot().catch(e => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});