const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { sendButtons, sendInteractiveMessage } = require('@qadeerxtech/qadeer-btns');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ---------- KEEP-ALIVE SERVER (Render) ----------
const app = express();
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
  console.log(`   Ping this URL to keep the bot awake: /health`);
});

// ---------- CONVERSATION STATE ----------
const userState = new Map();

// ---------- SAFE SEND WRAPPER ----------
async function safeSend(fnName, fn, sock, jid, payload) {
  try {
    const result = await fn(sock, jid, payload);
    return result;
  } catch (e) {
    console.error(`❌ ${fnName} FAILED: ${e.message}`);
    try {
      const fallbackText = payload.text || payload.caption || 'Bot message';
      await sock.sendMessage(jid, { text: fallbackText });
      console.log('✅ Fallback plain text sent');
    } catch (e2) {
      console.error('❌ Fallback also failed:', e2.message);
    }
  }
}

// ---------- TYPING INDICATOR HELPER ----------
async function keepTyping(sock, jid, maxMs = 30000) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (e) {}

  const interval = setInterval(() => {
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
  }, 5000);

  const timeout = setTimeout(() => {
    clearInterval(interval);
  }, maxMs);

  return {
    stop: async () => {
      clearInterval(interval);
      clearTimeout(timeout);
      try {
        await sock.sendPresenceUpdate('paused', jid);
      } catch (e) {}
    }
  };
}

// ---------- API HELPERS ----------

async function searchOpenAlex(query, limit = 5) {
  const { data } = await axios.get('https://api.openalex.org/works', {
    params: {
      search: query,
      per_page: limit,
      sort: 'cited_by_count:desc',
      mailto: 'you@example.com'
    }
  });
  return data.results.map(w => ({
    title: w.title,
    year: w.publication_year,
    doi: w.doi,
    citations: w.cited_by_count,
    authors: w.authorships.slice(0, 3).map(a => a.author.display_name).join(', ')
  }));
}

async function latestArxiv(category, limit = 5) {
  const { data } = await axios.get('https://export.arxiv.org/api/query', {
    params: {
      search_query: `cat:${category}`,
      sortBy: 'submittedDate',
      sortOrder: 'descending',
      max_results: limit
    }
  });
  const entries = [...data.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map(e => {
    const block = e[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim();
    const link = (block.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim();
    return { title, link };
  });
}

async function getPaper(arxivId) {
  const { data } = await axios.get(
    `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}`,
    { params: { fields: 'title,abstract,year,authors,venue,citationCount,externalIds' } }
  );
  return data;
}

async function searchAuthor(name, limit = 5) {
  const { data } = await axios.get('https://api.openalex.org/authors', {
    params: { search: name, per_page: 1, mailto: 'you@example.com' }
  });
  const author = data.results[0];
  if (!author) return null;

  const { data: works } = await axios.get('https://api.openalex.org/works', {
    params: {
      filter: `author.id:${author.id}`,
      per_page: limit,
      sort: 'cited_by_count:desc',
      mailto: 'you@example.com'
    }
  });
  return { author: author.display_name, papers: works.results };
}

// ---------- FORMAT HELPERS ----------

function formatPaperList(papers) {
  return papers.map((p, i) =>
    `*${i + 1}. ${p.title}* (${p.year})\n` +
    `👥 ${p.authors}\n` +
    `📊 ${p.citations} citations\n` +
    `🔗 ${p.doi || 'no DOI'}`
  ).join('\n\n');
}

async function sendMainMenu(sock, jid) {
  await safeSend('sendInteractiveMessage', sendInteractiveMessage, sock, jid, {
    text: '🎓 *Research Assistant*\n\nWhat would you like to do?\n\n1️⃣ Search Papers\n2️⃣ Latest Preprints\n3️⃣ Find Author\n4️⃣ Help\n\nReply with a number or use /commands.',
    footer: 'Powered by OpenAlex + arXiv',
    interactiveButtons: [{
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Tap to Open Menu 📂',
        sections: [{
          title: '🔍 Search',
          rows: [
            { id: 'menu_search', title: '🔍 Search Papers', description: 'Find papers by topic' },
            { id: 'menu_latest', title: '📰 Latest Preprints', description: 'Newest in cs.AI, cs.LG, etc.' },
            { id: 'menu_author', title: '👤 Find Author', description: 'Papers by a researcher' }
          ]
        }, {
          title: '❓ Help',
          rows: [
            { id: 'menu_help', title: '📖 Show Commands', description: 'See all available commands' }
          ]
        }]
      })
    }]
  });
}

// ---------- COMMAND RUNNERS (with typing indicator) ----------

async function runSearch(sock, jid, query) {
  const typing = await keepTyping(sock, jid);
  try {
    const papers = await searchOpenAlex(query);
    if (papers.length === 0) {
      await sock.sendMessage(jid, { text: '😕 No results found.' });
      return;
    }
    await safeSend('sendButtons', sendButtons, sock, jid, {
      text: formatPaperList(papers),
      footer: 'Search completed',
      buttons: [
        { id: 'menu_main', text: '📂 Main Menu' },
        { id: 'menu_search', text: '🔍 New Search' }
      ]
    });
  } finally {
    await typing.stop();
  }
}

async function runLatest(sock, jid, category) {
  const typing = await keepTyping(sock, jid);
  try {
    const papers = await latestArxiv(category);
    if (papers.length === 0) {
      await sock.sendMessage(jid, { text: `😕 No papers found in \`${category}\`.` });
      return;
    }
    const reply = papers.map((p, i) => `*${i + 1}. ${p.title}*\n📄 ${p.link}`).join('\n\n');
    await safeSend('sendButtons', sendButtons, sock, jid, {
      text: reply,
      footer: `Category: ${category}`,
      buttons: [
        { id: 'menu_main', text: '📂 Main Menu' },
        { id: 'menu_latest', text: '📰 Another Category' }
      ]
    });
  } finally {
    await typing.stop();
  }
}

async function runAuthor(sock, jid, name) {
  const typing = await keepTyping(sock, jid);
  try {
    const result = await searchAuthor(name);
    if (!result) {
      await sock.sendMessage(jid, { text: `😕 Author "${name}" not found.` });
      return;
    }
    const reply = `*${result.author}*\n\n` + result.papers.map((p, i) =>
      `${i + 1}. ${p.title} (${p.publication_year})\n📊 ${p.cited_by_count} citations`
    ).join('\n\n');
    await safeSend('sendButtons', sendButtons, sock, jid, {
      text: reply,
      footer: 'Author papers',
      buttons: [
        { id: 'menu_main', text: '📂 Main Menu' },
        { id: 'menu_author', text: '👤 Another Author' }
      ]
    });
  } finally {
    await typing.stop();
  }
}

async function runPaper(sock, jid, arxivId) {
  const typing = await keepTyping(sock, jid);
  try {
    const p = await getPaper(arxivId);
    const reply =
      `*${p.title}* (${p.year})\n\n` +
      `${(p.abstract || 'No abstract available.').slice(0, 400)}...\n\n` +
      `📊 ${p.citationCount} citations\n` +
      `🏛️ ${p.venue || 'N/A'}`;

    const interactiveButtons = [];
    if (p.externalIds?.ArXiv) {
      interactiveButtons.push({
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: '📄 Open PDF',
          url: `https://arxiv.org/pdf/${p.externalIds.ArXiv}`
        })
      });
    }
    interactiveButtons.push({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: '📂 Main Menu', id: 'menu_main' })
    });

    await safeSend('sendInteractiveMessage', sendInteractiveMessage, sock, jid, {
      text: reply,
      footer: 'Paper details',
      interactiveButtons
    });
  } finally {
    await typing.stop();
  }
}

// ---------- WHATSAPP BOT ----------

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.clear();
      console.log('📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device');
    }
    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!');
      console.log('💡 Send "/menu" in a private chat to start.');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startBot(), 3000);
      else console.log('🚪 Logged out. Delete auth_info/ and restart.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const jid = m.key.remoteJid;
      if (jid.endsWith('@g.us')) continue;
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;

      // ---------- EXTRACT TEXT / BUTTON ID ----------
      let text = '';
      let buttonId = '';

      if (m.message.conversation) text = m.message.conversation.trim();
      else if (m.message.extendedTextMessage?.text) text = m.message.extendedTextMessage.text.trim();

      if (m.message.listResponseMessage) {
        buttonId = m.message.listResponseMessage.singleSelectReply?.selectedRowId || '';
      }
      if (m.message.buttonsResponseMessage) {
        buttonId = m.message.buttonsResponseMessage.selectedButtonId || '';
      }
      if (m.message.templateButtonReplyMessage) {
        buttonId = m.message.templateButtonReplyMessage.selectedId || '';
      }

      // Interactive response (native flow menus)
      if (m.message.interactiveResponseMessage) {
        const paramsJson = m.message.interactiveResponseMessage
          .nativeFlowResponseMessage?.paramsJson;
        if (paramsJson) {
          try {
            const parsed = JSON.parse(paramsJson);
            buttonId = parsed.id || '';
          } catch (e) {
            console.error('Failed to parse paramsJson:', e.message);
          }
        }
      }

      const effectiveText = buttonId || text;
      if (!effectiveText) continue;

      console.log(`📩 ${jid} → "${effectiveText}"`);

      try {
        // ---------- HANDLE PENDING STATE ----------
        const pending = userState.get(jid);
        if (pending) {
          userState.delete(jid);
          if (effectiveText.toLowerCase() === 'cancel' || effectiveText === 'menu_main') {
            await sendMainMenu(sock, jid);
            continue;
          }
          if (pending === 'search') { await runSearch(sock, jid, effectiveText); continue; }
          if (pending === 'latest') { await runLatest(sock, jid, effectiveText); continue; }
          if (pending === 'author') { await runAuthor(sock, jid, effectiveText); continue; }
          if (pending === 'paper')  { await runPaper(sock, jid, effectiveText);  continue; }
        }

        // ---------- MAIN MENU ----------
        if (effectiveText === '/menu' || effectiveText === '/start' || effectiveText === 'menu_main') {
          await sendMainMenu(sock, jid);
        }

        // ---------- HELP ----------
        else if (effectiveText === '/help' || effectiveText === 'menu_help') {
          await safeSend('sendInteractiveMessage', sendInteractiveMessage, sock, jid, {
            text: '*Research Assistant Commands*\n\n' +
                  '🔍 `/search <topic>` — Search papers\n' +
                  '📰 `/latest <category>` — New preprints\n' +
                  '👤 `/author <name>` — Papers by researcher\n' +
                  '📄 `/paper <arxivId>` — Paper details\n' +
                  '📂 `/menu` — Show the main menu',
            footer: 'Tap a button or type a command',
            interactiveButtons: [{
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({ display_text: '📂 Back to Menu', id: 'menu_main' })
            }]
          });
        }

        // ---------- MENU BUTTON TAPS ----------
        else if (effectiveText === 'menu_search') {
          userState.set(jid, 'search');
          await sock.sendMessage(jid, {
            text: '🔍 *Search Papers*\n\nSend me a topic to search.\n\nExample: `quantum computing`\n\n_(Type *cancel* to go back.)_'
          });
        }
        else if (effectiveText === 'menu_latest') {
          userState.set(jid, 'latest');
          await sock.sendMessage(jid, {
            text: '📰 *Latest Preprints*\n\nSend me a category.\n\nExamples: `cs.AI`, `cs.LG`, `cs.CL`\n\n_(Type *cancel* to go back.)_'
          });
        }
        else if (effectiveText === 'menu_author') {
          userState.set(jid, 'author');
          await sock.sendMessage(jid, {
            text: '👤 *Find Author*\n\nSend me an author name.\n\nExample: `Yoshua Bengio`\n\n_(Type *cancel* to go back.)_'
          });
        }

        // ---------- NUMBER SHORTCUTS ----------
        else if (effectiveText === '1') {
          userState.set(jid, 'search');
          await sock.sendMessage(jid, { text: '🔍 Send me a topic to search.\n\n_(Type *cancel* to go back.)_' });
        }
        else if (effectiveText === '2') {
          userState.set(jid, 'latest');
          await sock.sendMessage(jid, { text: '📰 Send me a category.\n\nExamples: `cs.AI`, `cs.LG`\n\n_(Type *cancel* to go back.)_' });
        }
        else if (effectiveText === '3') {
          userState.set(jid, 'author');
          await sock.sendMessage(jid, { text: '👤 Send me an author name.\n\nExample: `Yoshua Bengio`\n\n_(Type *cancel* to go back.)_' });
        }
        else if (effectiveText === '4') {
          userState.set(jid, 'paper');
          await sock.sendMessage(jid, { text: '📄 Send me an arXiv ID.\n\nExample: `1706.03762`\n\n_(Type *cancel* to go back.)_' });
        }

        // ---------- INLINE TEXT COMMANDS ----------
        else if (effectiveText.startsWith('/search ')) {
          await runSearch(sock, jid, effectiveText.slice(8).trim());
        }
        else if (effectiveText.startsWith('/latest ')) {
          await runLatest(sock, jid, effectiveText.slice(8).trim());
        }
        else if (effectiveText.startsWith('/author ')) {
          await runAuthor(sock, jid, effectiveText.slice(8).trim());
        }
        else if (effectiveText.startsWith('/paper ')) {
          await runPaper(sock, jid, effectiveText.slice(7).trim());
        }

        // ---------- FALLBACK ----------
        else {
          await safeSend('sendButtons', sendButtons, sock, jid, {
            text: '🤖 I didn\'t understand that.\n\nTry /menu to see options.',
            footer: 'Research Assistant',
            buttons: [{ id: 'menu_main', text: '📂 Show Menu' }]
          });
        }

      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        await sock.sendMessage(jid, { text: `❌ Error: ${err.message}` });
      }
    }
  });
}

startBot();