// ═══════════════════════════════════════════════════════════
// WhatsApp Game Hub Bot — with Nashy Gate
// ═══════════════════════════════════════════════════════════
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { sendButtons, sendInteractiveMessage } = require('@qadeerxtech/qadeer-btns');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const NASHY_PHONE = '263733517788';
const NASHY_JID   = `${NASHY_PHONE}@s.whatsapp.net`;

// ═══════════════════════════════════════════════════════════
// 1. PERSISTENCE LAYER (atomic JSON store)
// ═══════════════════════════════════════════════════════════
const DATA_DIR    = path.join(__dirname, 'data');
const STATS_FILE  = path.join(DATA_DIR, 'stats.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let statsDB = { users: {} };
try {
  if (fs.existsSync(STATS_FILE)) statsDB = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
} catch (e) { console.error('stats load failed:', e.message); }

let saveTimer = null;
function saveStats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = STATS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(statsDB, null, 2));
      fs.renameSync(tmp, STATS_FILE);
    } catch (e) { console.error('stats save failed:', e.message); }
  }, 250);
}

function getUser(jid) {
  if (!statsDB.users[jid]) {
    statsDB.users[jid] = {
      // stats
      gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
      streak: 0, bestStreak: 0,
      perGame: {},
      createdAt: Date.now(),
      // gate
      greeted: false,
      mode: null,              // 'bot' | 'nashy' | null
      nashyQueue: null,        // { since, served? } or null
      nashyNotified: false,
      nashyNotifiedAt: 0
    };
  }
  return statsDB.users[jid];
}

function recordResult(jid, gameId, result /* 'win'|'loss'|'draw' */) {
  const u = getUser(jid);
  u.gamesPlayed++;
  u.perGame[gameId] = u.perGame[gameId] || { wins: 0, losses: 0, draws: 0 };
  u.perGame[gameId][result + 's']++;
  if (result === 'win') {
    u.wins++;
    u.streak++;
    if (u.streak > u.bestStreak) u.bestStreak = u.streak;
  } else if (result === 'loss') {
    u.losses++;
    u.streak = 0;
  } else {
    u.draws++;
  }
  saveStats();
}

function leaderboard(limit = 10) {
  return Object.entries(statsDB.users)
    .map(([jid, u]) => ({ jid, ...u }))
    .sort((a, b) => b.wins - a.wins || b.bestStreak - a.bestStreak)
    .slice(0, limit);
}

function queuePosition(jid) {
  const queued = Object.entries(statsDB.users)
    .filter(([_, u]) => u.nashyQueue && !u.nashyQueue.served)
    .sort((a, b) => a[1].nashyQueue.since - b[1].nashyQueue.since);
  const idx = queued.findIndex(([id]) => id === jid);
  return idx >= 0 ? idx + 1 : queued.length + 1;
}

// ═══════════════════════════════════════════════════════════
// 2. RNG (seeded, reproducible)
// ═══════════════════════════════════════════════════════════
class RNG {
  constructor(seed = Date.now()) { this.s = seed >>> 0 || 1; }
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x / 0xFFFFFFFF;
  }
  int(maxExclusive) { return Math.floor(this.next() * maxExclusive); }
  pick(arr) { return arr[this.int(arr.length)]; }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ═══════════════════════════════════════════════════════════
// 3. SESSION MANAGER
// ═══════════════════════════════════════════════════════════
const sessions = new Map();
function getSession(jid) { return sessions.get(jid); }
function setSession(jid, gameId, state = {}) {
  const s = {
    gameId, state,
    rng: new RNG(Date.now() ^ (jid.length * 2654435761)),
    startedAt: Date.now()
  };
  sessions.set(jid, s);
  return s;
}
function clearSession(jid) { sessions.delete(jid); }

setInterval(() => {
  const now = Date.now();
  for (const [jid, s] of sessions) {
    if (now - s.startedAt > 15 * 60 * 1000) sessions.delete(jid);
  }
}, 60_000);

// ═══════════════════════════════════════════════════════════
// 4. TRANSPORT HELPERS
// ═══════════════════════════════════════════════════════════
async function safeSend(fnName, fn, sock, jid, payload) {
  try { return await fn(sock, jid, payload); }
  catch (e) {
    console.error(`❌ ${fnName} failed: ${e.message}`);
    try {
      await sock.sendMessage(jid, { text: payload.text || '…' });
    } catch (e2) { console.error('fallback failed:', e2.message); }
  }
}

async function keepTyping(sock, jid, ms = 8000) {
  try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  const iv = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(() => {}), 4000);
  const to = setTimeout(() => clearInterval(iv), ms);
  return {
    stop: async () => {
      clearInterval(iv); clearTimeout(to);
      try { await sock.sendPresenceUpdate('paused', jid); } catch {}
    }
  };
}

function normalizeIncoming(m) {
  let text = '';
  let buttonId = '';
  if (m.message.conversation) text = m.message.conversation.trim();
  else if (m.message.extendedTextMessage?.text) text = m.message.extendedTextMessage.text.trim();

  if (m.message.listResponseMessage)
    buttonId = m.message.listResponseMessage.singleSelectReply?.selectedRowId || '';
  if (m.message.buttonsResponseMessage)
    buttonId = m.message.buttonsResponseMessage.selectedButtonId || '';
  if (m.message.templateButtonReplyMessage)
    buttonId = m.message.templateButtonReplyMessage.selectedId || '';

  if (m.message.interactiveResponseMessage) {
    const pj = m.message.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson;
    if (pj) { try { buttonId = JSON.parse(pj).id || ''; } catch {} }
  }

  if (buttonId) return { type: 'button', value: buttonId };
  if (text)     return { type: 'text',   value: text };
  return null;
}

// ═══════════════════════════════════════════════════════════
// 5. GAMES REGISTRY
// ═══════════════════════════════════════════════════════════
const games = {};

// ─── 5.1 Rock Paper Scissors ──────────────────────────────
games.rps = {
  id: 'rps', name: 'Rock Paper Scissors', emoji: '✊',
  async start(ctx) {
    ctx.session.state = { wins: 0, losses: 0, draws: 0, round: 1 };
    return this.render(ctx);
  },
  async render(ctx) {
    const s = ctx.session.state;
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text:
        `✊✋✌️ *Rock Paper Scissors*\n\n` +
        `Round *${s.round}*\n` +
        `🏆 ${s.wins}  🤝 ${s.draws}  💀 ${s.losses}\n\n` +
        `Pick your move:`,
      footer: 'Best of luck!',
      buttons: [
        { id: 'rps_rock',     text: '✊ Rock' },
        { id: 'rps_paper',    text: '✋ Paper' },
        { id: 'rps_scissors', text: '✌️ Scissors' },
        { id: 'game_menu',    text: '🏠 Menu' }
      ]
    });
  },
  async handle(ctx, input) {
    const map = { rps_rock: 'rock', rps_paper: 'paper', rps_scissors: 'scissors' };
    const move = map[input.value];
    if (!move) return false;
    const botMove = ctx.session.rng.pick(['rock', 'paper', 'scissors']);
    const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    let result, emoji;
    const s = ctx.session.state;
    if (move === botMove)              { result = 'draw'; emoji = '🤝'; s.draws++;  recordResult(ctx.jid, 'rps', 'draw'); }
    else if (beats[move] === botMove)  { result = 'win';  emoji = '🏆'; s.wins++;   recordResult(ctx.jid, 'rps', 'win');  }
    else                               { result = 'loss'; emoji = '💀'; s.losses++; recordResult(ctx.jid, 'rps', 'loss'); }
    s.round++;

    const label = { rock: '✊ Rock', paper: '✋ Paper', scissors: '✌️ Scissors' };
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text:
        `You: ${label[move]}\nBot: ${label[botMove]}\n\n${emoji} *You ${result}!*\n\n` +
        `🏆 ${s.wins}  🤝 ${s.draws}  💀 ${s.losses}`,
      footer: 'Rematch?',
      buttons: [
        { id: 'rps_again', text: '🔁 Play Again' },
        { id: 'rps_end',   text: '🛑 End Game' },
        { id: 'game_menu', text: '🏠 Menu' }
      ]
    });
    return true;
  },
  async onButton(ctx, id) {
    if (id === 'rps_again') return this.render(ctx), true;
    if (id === 'rps_end') {
      clearSession(ctx.jid);
      await gameHub(ctx.sock, ctx.jid);
      return true;
    }
    return false;
  }
};

// ─── 5.2 Guess the Number ─────────────────────────────────
games.guess = {
  id: 'guess', name: 'Guess the Number', emoji: '🎯',
  async start(ctx) {
    ctx.session.state = { phase: 'pickRange' };
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text: `🎯 *Guess the Number*\n\nPick a difficulty:`,
      footer: 'Hot/cold hints included',
      buttons: [
        { id: 'guess_10',  text: '😌 1–10 (easy)' },
        { id: 'guess_50',  text: '😐 1–50 (medium)' },
        { id: 'guess_100', text: '😈 1–100 (hard)' },
        { id: 'game_menu', text: '🏠 Menu' }
      ]
    });
  },
  async onButton(ctx, id) {
    const rangeMap = { guess_10: 10, guess_50: 50, guess_100: 100 };
    if (rangeMap[id]) {
      const max = rangeMap[id];
      const target = 1 + ctx.session.rng.int(max);
      ctx.session.state = { phase: 'playing', max, target, tries: 0, history: [] };
      await ctx.sock.sendMessage(ctx.jid, {
        text: `🎯 I picked a number between *1 and ${max}*.\n\nType your guess!\n\n_(Type *cancel* to quit.)_`
      });
      return true;
    }
    return false;
  },
  async handle(ctx, input) {
    const s = ctx.session.state;
    if (s.phase !== 'playing') return false;
    const guess = parseInt(input.value, 10);
    if (!guess || guess < 1 || guess > s.max) return false;

    s.tries++;
    s.history.push(guess);
    if (guess === s.target) {
      const rank = s.tries <= 3 ? '🥇 Legendary'
                 : s.tries <= 6 ? '🥈 Great'
                 : s.tries <= 10 ? '🥉 Good' : '🐢 Slow';
      recordResult(ctx.jid, 'guess', 'win');
      clearSession(ctx.jid);
      await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
        text: `🎉 *Correct!* It was *${s.target}*.\n\nTries: *${s.tries}*\nRank: *${rank}*\nHistory: ${s.history.join(' → ')}`,
        footer: 'Nice one!',
        buttons: [
          { id: 'guess_start', text: '🔁 Play Again' },
          { id: 'game_menu',   text: '🏠 Menu' }
        ]
      });
      return true;
    }

    const diff = Math.abs(guess - s.target);
    const proximity =
      diff <= 1 ? '🔥 ON FIRE — 1 away!' :
      diff <= 3 ? '🔥 Very hot' :
      diff <= Math.max(5, s.max * 0.05) ? '♨️ Hot' :
      diff <= Math.max(10, s.max * 0.15) ? '🌤️ Warm' :
      diff <= Math.max(20, s.max * 0.3) ? '❄️ Cold' :
      '🧊 Freezing';
    const dir = guess < s.target ? '⬆️ Higher' : '⬇️ Lower';

    await ctx.sock.sendMessage(ctx.jid, {
      text: `${proximity} — ${dir}\n\nGuess #${s.tries} (range 1–${s.max})`
    });
    return true;
  }
};

// ─── 5.3 Would You Rather ─────────────────────────────────
const WYR_QUESTIONS = [
  { a: 'Fly 🛫', b: 'Be invisible 👻' },
  { a: 'Never use social media 📵', b: 'Never watch movies 🎬' },
  { a: 'Time travel to past ⏪', b: 'Time travel to future ⏩' },
  { a: 'Always tell the truth 💬', b: 'Always lie 🤥' },
  { a: 'Live in space 🌌', b: 'Live under the sea 🌊' },
  { a: 'Have unlimited money 💰', b: 'Have unlimited time ⏳' },
  { a: 'Read minds 🧠', b: 'See the future 🔮' },
  { a: 'Never sleep 😵', b: 'Never eat 🍽️' },
  { a: 'Fight 1 horse-sized duck 🦆', b: 'Fight 100 duck-sized horses 🐴' },
  { a: 'Only whisper 🤫', b: 'Only shout 📢' }
];

games.wyr = {
  id: 'wyr', name: 'Would You Rather', emoji: '🤔',
  async start(ctx) {
    ctx.session.state = { count: 0 };
    return this.render(ctx);
  },
  async render(ctx) {
    const q = ctx.session.rng.pick(WYR_QUESTIONS);
    ctx.session.state.current = q;
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text: `🤔 *Would You Rather?*\n\n🅰️ ${q.a}\n\n— OR —\n\n🅱️ ${q.b}`,
      footer: 'Tap your choice',
      buttons: [
        { id: 'wyr_a',     text: '🅰️ Option A' },
        { id: 'wyr_b',     text: '🅱️ Option B' },
        { id: 'game_menu', text: '🏠 Menu' }
      ]
    });
  },
  async onButton(ctx, id) {
    if (id !== 'wyr_a' && id !== 'wyr_b') return false;
    const pctA = 30 + ctx.session.rng.int(41);
    const pctB = 100 - pctA;
    const yourSide = id === 'wyr_a' ? '🅰️' : '🅱️';
    const majority = id === 'wyr_a' ? pctA >= 50 : pctB >= 50;
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text:
        `You picked ${yourSide}\n\n` +
        `🌍 *Global results:*\n` +
        `🅰️ ${pctA}%\n🅱️ ${pctB}%\n\n` +
        `You're in the ${majority ? 'majority 🎉' : 'minority 🦄'}!`,
      footer: 'Another one?',
      buttons: [
        { id: 'wyr_next',  text: '➡️ Next Question' },
        { id: 'game_menu', text: '🏠 Menu' }
      ]
    });
    return true;
  },
  async handle(ctx, input) {
    if (input.value === 'wyr_next') { await this.render(ctx); return true; }
    return this.onButton(ctx, input.value);
  }
};

// ─── 5.4 Truth or Dare ────────────────────────────────────
const TRUTHS = [
  "What's the most embarrassing thing you've done in public?",
  "Who was your first crush?",
  "What's a secret you've never told anyone here?",
  "What's the biggest lie you've ever told?",
  "What's your most irrational fear?",
  "What's the weirdest thing you've Googled?",
  "Have you ever pretended to like a gift you hated?",
  "What's the last thing you cried about?",
  "Who in this chat would you trust with your phone unlocked?",
  "What's your guilty pleasure song?"
];
const DARES = [
  "Send a voice note singing your favorite song.",
  "Text the 5th person in your contacts 'I love you'.",
  "Send the last photo in your gallery.",
  "Do 20 push-ups and send proof.",
  "Speak only in rhymes for the next 10 minutes.",
  "Send a selfie with your best silly face.",
  "Type your next message with your eyes closed.",
  "Call a friend and say 'the eagle has landed'.",
  "Post an embarrassing childhood story.",
  "Change your WhatsApp status to something your friends pick."
];

games.tod = {
  id: 'tod', name: 'Truth or Dare', emoji: '🎭',
  async start(ctx) {
    ctx.session.state = { count: 0 };
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text: `🎭 *Truth or Dare*\n\nPick your fate:`,
      footer: 'No backing out 😈',
      buttons: [
        { id: 'tod_truth',  text: '💬 Truth' },
        { id: 'tod_dare',   text: '🔥 Dare' },
        { id: 'tod_random', text: '🎲 Surprise Me' },
        { id: 'game_menu',  text: '🏠 Menu' }
      ]
    });
  },
  async onButton(ctx, id) {
    let kind = null;
    if (id === 'tod_truth')  kind = 'truth';
    if (id === 'tod_dare')   kind = 'dare';
    if (id === 'tod_random') kind = ctx.session.rng.pick(['truth', 'dare']);
    if (!kind) return false;

    const prompt = kind === 'truth' ? ctx.session.rng.pick(TRUTHS) : ctx.session.rng.pick(DARES);
    const header = kind === 'truth' ? '💬 *TRUTH*' : '🔥 *DARE*';
    ctx.session.state.count++;

    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text: `${header}\n\n${prompt}\n\n_Round ${ctx.session.state.count}_`,
      footer: 'Go again?',
      buttons: [
        { id: 'tod_truth',  text: '💬 Truth' },
        { id: 'tod_dare',   text: '🔥 Dare' },
        { id: 'tod_random', text: '🎲 Random' },
        { id: 'game_menu',  text: '🏠 Menu' }
      ]
    });
    return true;
  },
  async handle(ctx, input) {
    if (input.value.startsWith('tod_')) return this.onButton(ctx, input.value);
    return false;
  }
};

// ─── 5.5 Word Chain ───────────────────────────────────────
const SEED_WORDS = ['apple','banana','ocean','tiger','guitar','rocket','planet','silver','dragon','mountain'];
const WC_DICT = ['apple','banana','ocean','tiger','guitar','rocket','planet','silver','dragon','mountain',
  'elephant','notebook','kangaroo','orange','umbrella','yogurt','tomato','onion','nest','tree',
  'egg','grape','eagle','end','dog','goat','tent','top','pen','net','sun','nose','ear','rat',
  'table','lamp','melon','kite','ink','king','rose','owl','ant','turtle','kiwi','iguana'];

games.wordchain = {
  id: 'wordchain', name: 'Word Chain', emoji: '🔗',
  async start(ctx) {
    const start = ctx.session.rng.pick(SEED_WORDS);
    ctx.session.state = { last: start, chain: [start], score: 0, used: new Set([start]) };
    await ctx.sock.sendMessage(ctx.jid, {
      text:
        `🔗 *Word Chain*\n\n` +
        `I'll start with: *${start}*\n\n` +
        `Send a word starting with *"${start.slice(-1).toUpperCase()}"*.\n\n` +
        `Rules: real words, no repeats, no proper nouns.\n_(Type *cancel* to quit.)_`
    });
    return true;
  },
  async handle(ctx, input) {
    const s = ctx.session.state;
    if (!s || !s.last) return false;
    const word = input.value.toLowerCase().trim().replace(/[^a-z]/g, '');
    if (!word || word.length < 2) return false;

    const needed = s.last.slice(-1);
    if (!word.startsWith(needed)) {
      await ctx.sock.sendMessage(ctx.jid, { text: `❌ Must start with *"${needed.toUpperCase()}"*. Try again.` });
      return true;
    }
    if (s.used.has(word)) {
      await ctx.sock.sendMessage(ctx.jid, { text: `❌ Already used *${word}*. Try again.` });
      return true;
    }

    s.used.add(word);
    s.chain.push(word);
    s.score += word.length;

    const needed2 = word.slice(-1);
    const botChoices = WC_DICT.filter(w => w.startsWith(needed2) && !s.used.has(w));

    if (botChoices.length === 0) {
      recordResult(ctx.jid, 'wordchain', 'win');
      clearSession(ctx.jid);
      await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
        text: `🏆 *You win!* I couldn't find a word starting with *"${needed2.toUpperCase()}"*.\n\nChain length: *${s.chain.length}*\nScore: *${s.score}*`,
        footer: 'Great chain!',
        buttons: [
          { id: 'wc_start', text: '🔁 New Game' },
          { id: 'game_menu', text: '🏠 Menu' }
        ]
      });
      return true;
    }

    const botWord = ctx.session.rng.pick(botChoices);
    s.used.add(botWord);
    s.chain.push(botWord);
    s.last = botWord;

    await ctx.sock.sendMessage(ctx.jid, {
      text:
        `✅ *${word}* (+${word.length})\n\n` +
        `🤖 Me: *${botWord}*\n\n` +
        `Your turn — send a word starting with *"${botWord.slice(-1).toUpperCase()}"*.\n` +
        `Chain: ${s.chain.length} words | Score: ${s.score}`
    });
    return true;
  }
};

// ─── 5.6 Hangman ──────────────────────────────────────────
const HANGMAN_WORDS = ['javascript','computer','elephant','guitar','mountain','ocean','bicycle','library','penguin','rocket','pizza','chocolate','diamond','festival','universe'];

function hangmanArt(wrong) {
  const stages = [
    '```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```',
    '```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```',
    '```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```',
    '```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```',
    '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```',
    '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```',
    '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```'
  ];
  return stages[Math.min(wrong, 6)];
}

games.hangman = {
  id: 'hangman', name: 'Hangman', emoji: '🪢',
  async start(ctx) {
    const word = ctx.session.rng.pick(HANGMAN_WORDS);
    ctx.session.state = { word, guessed: new Set(), wrong: 0, maxWrong: 6 };
    return this.render(ctx);
  },
  async render(ctx) {
    const s = ctx.session.state;
    const masked = s.word.split('').map(c => s.guessed.has(c) ? c.toUpperCase() : '_').join(' ');
    const wrongLetters = [...s.guessed].filter(c => !s.word.includes(c)).join(' ');

    const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('')
      .filter(c => !s.guessed.has(c))
      .map(c => ({ id: `hm_${c}`, title: c.toUpperCase(), description: `Guess ${c.toUpperCase()}` }));

    await safeSend('sendInteractiveMessage', sendInteractiveMessage, ctx.sock, ctx.jid, {
      text:
        `${hangmanArt(s.wrong)}\n\n` +
        `Word: *${masked}*\n` +
        `Wrong (${s.wrong}/${s.maxWrong}): ${wrongLetters || '—'}`,
      footer: 'Pick a letter',
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '🔤 Choose Letter',
          sections: [{ title: 'Available Letters', rows: alphabet }]
        })
      }]
    });
    return true;
  },
  async handle(ctx, input) {
    if (!input.value.startsWith('hm_')) return false;
    const letter = input.value.slice(3).toLowerCase();
    const s = ctx.session.state;
    if (!letter || s.guessed.has(letter)) return false;

    s.guessed.add(letter);

    if (!s.word.includes(letter)) {
      s.wrong++;
      if (s.wrong >= s.maxWrong) {
        recordResult(ctx.jid, 'hangman', 'loss');
        clearSession(ctx.jid);
        await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
          text: `${hangmanArt(6)}\n\n💀 *You lost!* The word was *${s.word.toUpperCase()}*.`,
          footer: 'Try again?',
          buttons: [
            { id: 'hm_start',  text: '🔁 New Word' },
            { id: 'game_menu', text: '🏠 Menu' }
          ]
        });
        return true;
      }
    }

    const won = s.word.split('').every(c => s.guessed.has(c));
    if (won) {
      recordResult(ctx.jid, 'hangman', 'win');
      clearSession(ctx.jid);
      await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
        text: `🎉 *You win!* The word was *${s.word.toUpperCase()}*.\n\nMistakes: *${s.wrong}*`,
        footer: 'Champion!',
        buttons: [
          { id: 'hm_start',  text: '🔁 New Word' },
          { id: 'game_menu', text: '🏠 Menu' }
        ]
      });
      return true;
    }

    return this.render(ctx);
  }
};

// ─── 5.7 Tic-Tac-Toe (minimax) ────────────────────────────
function tttWinner(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b2,c] of lines) if (b[a] && b[a] === b[b2] && b[a] === b[c]) return b[a];
  return b.every(x => x) ? 'draw' : null;
}
function tttMinimax(board, player, ai, human) {
  const w = tttWinner(board);
  if (w === ai) return { score: 10 };
  if (w === human) return { score: -10 };
  if (w === 'draw') return { score: 0 };
  const moves = [];
  for (let i = 0; i < 9; i++) {
    if (!board[i]) {
      board[i] = player;
      const r = tttMinimax(board, player === ai ? human : ai, ai, human);
      moves.push({ idx: i, score: r.score });
      board[i] = null;
    }
  }
  return player === ai
    ? moves.reduce((a, b) => b.score > a.score ? b : a)
    : moves.reduce((a, b) => b.score < a.score ? b : a);
}
function tttRender(board) {
  const cells = board.map((c, i) => c === 'X' ? '❌' : c === 'O' ? '⭕' : `${i + 1}️⃣`);
  return `${cells[0]} ${cells[1]} ${cells[2]}\n${cells[3]} ${cells[4]} ${cells[5]}\n${cells[6]} ${cells[7]} ${cells[8]}`;
}

games.ttt = {
  id: 'ttt', name: 'Tic-Tac-Toe', emoji: '⭕',
  async start(ctx) {
    ctx.session.state = { board: Array(9).fill(null), player: 'X', ai: 'O', done: false };
    return this.render(ctx);
  },
  async render(ctx) {
    const s = ctx.session.state;
    const rows = [];
    for (let i = 0; i < 9; i++) {
      if (!s.board[i]) rows.push({ id: `ttt_${i}`, title: `Cell ${i + 1}`, description: 'Empty — place your ❌' });
    }
    await safeSend('sendInteractiveMessage', sendInteractiveMessage, ctx.sock, ctx.jid, {
      text: `⭕ *Tic-Tac-Toe*\n\nYou: ❌  |  Bot: ⭕\n\n${tttRender(s.board)}\n\nYour move:`,
      footer: 'Pick a cell',
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '🎯 Choose Cell',
          sections: [{ title: 'Empty Cells', rows }]
        })
      }]
    });
    return true;
  },
  async handle(ctx, input) {
    if (!input.value.startsWith('ttt_')) return false;
    const idx = parseInt(input.value.slice(4), 10);
    const s = ctx.session.state;
    if (s.done || s.board[idx]) return false;

    s.board[idx] = s.player;
    let w = tttWinner(s.board);
    if (w) return this.finish(ctx, w);

    const aiMove = tttMinimax(s.board, s.ai, s.ai, s.player);
    if (aiMove && aiMove.idx !== undefined) s.board[aiMove.idx] = s.ai;
    w = tttWinner(s.board);
    if (w) return this.finish(ctx, w);

    return this.render(ctx);
  },
  async finish(ctx, result) {
    const s = ctx.session.state;
    s.done = true;
    const label = result === 'X' ? 'win' : result === 'O' ? 'loss' : 'draw';
    recordResult(ctx.jid, 'ttt', label);
    const msg = result === 'draw' ? '🤝 *Draw!*'
              : result === 'X'    ? '🏆 *You win!*'
              :                     '💀 *Bot wins!*';
    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text: `${tttRender(s.board)}\n\n${msg}`,
      footer: 'Rematch?',
      buttons: [
        { id: 'ttt_start', text: '🔁 Play Again' },
        { id: 'game_menu', text: '🏠 Menu' }
      ]
    });
    return true;
  }
};

// ─── 5.8 Escape Room ──────────────────────────────────────
// Puzzle: spider legs (8) - hydra heads (7) + 1 = 2, then microscope shows 7 → code 27
const ESCAPE_ROOMS = {
  start: {
    text:
      "🚪 *ESCAPE ROOM — The Locked Lab*\n\n" +
      "You wake up in a dimly lit laboratory. The door is sealed.\n" +
      "On a desk you see:\n" +
      "  🔬 a microscope\n" +
      "  📓 a notebook\n" +
      "  🔒 a locked drawer\n" +
      "  🚪 the sealed door\n\n" +
      "What do you do?",
    choices: [
      { id: 'esc_notebook',   label: '📓 Read notebook' },
      { id: 'esc_microscope', label: '🔬 Use microscope' },
      { id: 'esc_drawer',     label: '🔒 Try the drawer' },
      { id: 'esc_door',       label: '🚪 Examine door' }
    ]
  },
  notebook: {
    text:
      "📓 *The Notebook*\n\n" +
      "Handwritten entry:\n" +
      "\"The code is: [spider legs - hydra heads + 1] then the number from the microscope.\"\n\n" +
      "Spider = 8 legs. Hydra = 7 heads.",
    choices: [{ id: 'esc_start', label: '↩️ Back to room' }]
  },
  microscope: {
    text:
      "🔬 *Microscope*\n\n" +
      "A slide labeled \"DOOR CODE — PART 2\".\n" +
      "You see: `7`",
    choices: [{ id: 'esc_start', label: '↩️ Back to room' }]
  },
  drawer: {
    text:
      "🔒 *Locked Drawer*\n\n" +
      "A decoy keypad. It won't budge. You should focus on the *door* instead.",
    choices: [{ id: 'esc_start', label: '↩️ Back to room' }]
  },
  door: {
    text:
      "🚪 *The Door*\n\n" +
      "4-digit keypad. Enter the code.\n\n" +
      "_Hint: notebook formula + microscope number._",
    choices: null,
    expectCode: '27'
  },
  success: {
    text:
      "🎉 *ESCAPED!*\n\n" +
      "The door hisses open. Fresh air. You step out.\n\n" +
      "Well played, detective. 🕵️",
    choices: [
      { id: 'esc_start',  label: '🔁 Play Again' },
      { id: 'game_menu',  label: '🏠 Menu' }
    ]
  }
};

games.escape = {
  id: 'escape', name: 'Escape Room', emoji: '🚪',
  async start(ctx) {
    ctx.session.state = { room: 'start' };
    return this.render(ctx);
  },
  async render(ctx) {
    const room = ESCAPE_ROOMS[ctx.session.state.room];
    if (room.choices) {
      if (room.choices.length <= 3) {
        await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
          text: room.text,
          footer: 'Pick an action',
          buttons: room.choices.map(c => ({ id: c.id, text: c.label }))
        });
      } else {
        await safeSend('sendInteractiveMessage', sendInteractiveMessage, ctx.sock, ctx.jid, {
          text: room.text,
          footer: 'Pick an action',
          interactiveButtons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title: '🎯 Choose Action',
              sections: [{
                title: 'Actions',
                rows: room.choices.map(c => ({ id: c.id, title: c.label, description: '' }))
              }]
            })
          }]
        });
      }
    } else {
      await ctx.sock.sendMessage(ctx.jid, { text: room.text });
    }
    return true;
  },
  async handle(ctx, input) {
    const s = ctx.session.state;
    const currentRoom = ESCAPE_ROOMS[s.room];

    // If current room expects a code, check it
    if (currentRoom.expectCode) {
      const code = String(input.value).replace(/\D/g, '');
      if (code === currentRoom.expectCode) {
        s.room = 'success';
        recordResult(ctx.jid, 'escape', 'win');
        return this.render(ctx);
      }
      if (/^\d{2,4}$/.test(code)) {
        await ctx.sock.sendMessage(ctx.jid, { text: `🔒 *${code}* — wrong code. Try again.` });
        return true;
      }
      return false;
    }

    // Room navigation
    if (input.value.startsWith('esc_')) {
      const roomKey = input.value.slice(4);
      if (ESCAPE_ROOMS[roomKey]) {
        s.room = roomKey;
        return this.render(ctx);
      }
    }
    return false;
  }
};

// ─── 5.9 Murder Mystery ───────────────────────────────────
const MYSTERY = {
  victim: 'Lord Ashford',
  suspects: {
    butler: {
      name: '🎩 Mr. Pemberton (Butler)',
      alibi: "I was polishing the silver in the pantry. Heard nothing.",
      evidence: "Was seen arguing with Lord Ashford about unpaid wages earlier.",
      guilty: false
    },
    niece: {
      name: '👩‍🦰 Lady Vivienne (Niece)',
      alibi: "I was in the garden reading. The roses, you know.",
      evidence: "Inherits the entire estate. Had muddy shoes at midnight.",
      guilty: true
    },
    gardener: {
      name: '🌿 Old Tom (Gardener)',
      alibi: "In my shed fixing the mower.",
      evidence: "Owes Lord Ashford a large sum. Was heard muttering threats.",
      guilty: false
    },
    maid: {
      name: '🧹 Bessie (Maid)',
      alibi: "Sleeping in the servant's quarters.",
      evidence: "Secretly in love with the butler. Would lie to protect him.",
      guilty: false
    }
  }
};

games.mystery = {
  id: 'mystery', name: 'Murder Mystery', emoji: '🔍',
  async start(ctx) {
    ctx.session.state = { interrogated: new Set(), accused: false };
    await safeSend('sendInteractiveMessage', sendInteractiveMessage, ctx.sock, ctx.jid, {
      text:
        `🔍 *MURDER AT BLACKWOOD MANOR*\n\n` +
        `*${MYSTERY.victim}* has been found dead in the library — poisoned, at midnight.\n\n` +
        `Four suspects. One killer. You have until dawn.\n\n` +
        `Interrogate suspects, then make your accusation.`,
      footer: 'Choose a suspect',
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '🕵️ Interrogate',
          sections: [{
            title: 'Suspects',
            rows: Object.entries(MYSTERY.suspects).map(([k, v]) => ({
              id: `mm_ask_${k}`, title: v.name, description: 'Question this suspect'
            }))
          }]
        })
      }]
    });
    return true;
  },
  async handle(ctx, input) {
    const s = ctx.session.state;

    if (input.value === 'mm_accuse') return this.accuse(ctx);

    if (input.value.startsWith('mm_ask_')) {
      const key = input.value.slice(7);
      const sus = MYSTERY.suspects[key];
      if (!sus) return false;
      s.interrogated.add(key);

      const already = s.interrogated.size > 1
        ? `_(You've questioned ${s.interrogated.size} of 4 suspects.)_`
        : '';

      const rows = [
        ...Object.entries(MYSTERY.suspects)
          .filter(([k]) => !s.interrogated.has(k))
          .map(([k, v]) => ({ id: `mm_ask_${k}`, title: v.name, description: 'Question them' })),
        { id: 'mm_accuse', title: '⚖️ Make Accusation', description: 'Name the killer' }
      ];

      await safeSend('sendInteractiveMessage', sendInteractiveMessage, ctx.sock, ctx.jid, {
        text:
          `*${sus.name}*\n\n` +
          `💬 "${sus.alibi}"\n\n` +
          `🔎 *Evidence:* ${sus.evidence}\n\n${already}`,
        footer: 'Continue investigating',
        interactiveButtons: [{
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: '🕵️ Continue',
            sections: [{ title: 'Next', rows }]
          })
        }]
      });
      return true;
    }

    if (input.value.startsWith('mm_vote_')) {
      return this.vote(ctx, input.value.slice(8));
    }

    return false;
  },
  async accuse(ctx) {
    const s = ctx.session.state;
    if (s.accused) return false;
    s.accused = true;
    await safeSend('sendInteractiveMessage', sendInteractiveMessage, ctx.sock, ctx.jid, {
      text: `⚖️ *Who is the killer?*\n\nYou've questioned ${s.interrogated.size}/4 suspects.\n\nMake your accusation — you only get one shot.`,
      footer: 'Choose wisely',
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '⚖️ Accuse',
          sections: [{
            title: 'Suspects',
            rows: Object.entries(MYSTERY.suspects).map(([k, v]) => ({
              id: `mm_vote_${k}`, title: v.name, description: 'Accuse this person'
            }))
          }]
        })
      }]
    });
    return true;
  },
  async vote(ctx, key) {
    const sus = MYSTERY.suspects[key];
    if (!sus) return false;
    const correct = sus.guilty;
    recordResult(ctx.jid, 'mystery', correct ? 'win' : 'loss');
    clearSession(ctx.jid);

    const reveal = Object.entries(MYSTERY.suspects).map(([k, v]) =>
      `${v.name} — ${v.guilty ? '🔴 KILLER' : '⚪ innocent'}`
    ).join('\n');

    await safeSend('sendButtons', sendButtons, ctx.sock, ctx.jid, {
      text:
        (correct
          ? `🎉 *CASE CLOSED!* You correctly accused *${sus.name}*.\n\n`
          : `❌ *WRONG!* You accused *${sus.name}*, but the killer was *Lady Vivienne (Niece)*.\n\n`) +
        `*The Full Truth:*\n${reveal}\n\n` +
        `Lady Vivienne poisoned the wine to inherit the estate. The muddy shoes betrayed her midnight trip to the garden — where she hid the poison vial.`,
      footer: 'Case file closed',
      buttons: [
        { id: 'mm_start',  text: '🔁 New Case' },
        { id: 'game_menu', text: '🏠 Menu' }
      ]
    });
    return true;
  }
};

// ═══════════════════════════════════════════════════════════
// 6. GATE (Nashy vs Bot)
// ═══════════════════════════════════════════════════════════
async function sendGate(sock, jid, isReturning = false) {
  const text = isReturning
    ? `👋 *Welcome back!*\n\nWho would you like to talk to?`
    : `👋 *Hey there!*\n\nI'm the *Game Bot* 🎮 — I host games like Rock Paper Scissors, Hangman, Tic-Tac-Toe, Escape Rooms and more.\n\n*Nashy* 👤 is a real human who'll reply when he's back online.\n\nWho would you like to talk to?`;

  await safeSend('sendButtons', sendButtons, sock, jid, {
    text,
    footer: 'Pick one to continue',
    buttons: [
      { id: 'gate_bot',   text: '🎮 Talk to Bot' },
      { id: 'gate_nashy', text: '👤 Talk to Nashy' }
    ]
  });
}

async function enqueueForNashy(sock, jid) {
  const u = getUser(jid);
  const since = Date.now();

  if (!u.nashyQueue || u.nashyQueue.served) {
    u.nashyQueue = { since, served: false };
    u.mode = 'nashy';
    saveStats();

    await safeSend('sendButtons', sendButtons, sock, jid, {
      text:
        `👤 *Got it!*\n\n` +
        `Nashy will reply to you as soon as he's back online.\n\n` +
        `⏱️ You've been added to his queue.\n` +
        `You can keep this chat open — no need to send anything else.\n\n` +
        `_Changed your mind? Tap below to play games instead._`,
      footer: `You are #${queuePosition(jid)} in line`,
      buttons: [
        { id: 'gate_bot',    text: '🎮 Play Games Instead' },
        { id: 'gate_status', text: '📊 Queue Status' }
      ]
    });

    if (!u.nashyNotified || Date.now() - u.nashyNotifiedAt > 10 * 60 * 1000) {
      u.nashyNotified = true;
      u.nashyNotifiedAt = Date.now();
      saveStats();
      notifyNashy(sock, jid, u).catch(e => console.error('notify nashy failed:', e.message));
    }
  } else {
    await sock.sendMessage(jid, {
      text: `⏳ You're already in Nashy's queue (position #${queuePosition(jid)}). He'll reply when he's back.`
    });
  }
}

async function notifyNashy(sock, userJid, u) {
  const phone = userJid.split('@')[0];
  const queueSize = Object.values(statsDB.users)
    .filter(x => x.nashyQueue && !x.nashyQueue.served).length;
  await sock.sendMessage(NASHY_JID, {
    text:
      `🔔 *New person waiting for you*\n\n` +
      `📱 +${phone}\n` +
      `🕐 Since: ${new Date(u.nashyQueue.since).toLocaleString()}\n` +
      `👥 Queue size: ${queueSize}\n\n` +
      `Reply to them directly when you're free.`
  });
}

async function sendQueueStatus(sock, jid) {
  const u = getUser(jid);
  if (!u.nashyQueue || u.nashyQueue.served) {
    return sendGate(sock, jid, true);
  }
  const pos = queuePosition(jid);
  const waiting = Math.floor((Date.now() - u.nashyQueue.since) / 60000);
  await safeSend('sendButtons', sendButtons, sock, jid, {
    text:
      `📊 *Queue Status*\n\n` +
      `Position: *#${pos}*\n` +
      `Waiting: *${waiting} min*\n\n` +
      `Nashy will message you here when he's online. Sit tight! 🪑`,
    footer: 'Thanks for your patience',
    buttons: [
      { id: 'gate_bot',    text: '🎮 Play Games' },
      { id: 'gate_status', text: '🔄 Refresh' }
    ]
  });
}

async function forwardToNashy(sock, userJid, text) {
  const phone = userJid.split('@')[0];
  try {
    await sock.sendMessage(NASHY_JID, {
      text: `📨 *From +${phone}:*\n\n${text}`
    });
  } catch (e) { /* silent */ }
}

// ═══════════════════════════════════════════════════════════
// 7. NASHY ADMIN COMMANDS
// ═══════════════════════════════════════════════════════════
async function handleNashyAdmin(sock, jid, text) {
  const lower = text.toLowerCase().trim();

  if (lower === '/queue') {
    const queued = Object.entries(statsDB.users)
      .filter(([_, u]) => u.nashyQueue && !u.nashyQueue.served)
      .sort((a, b) => a[1].nashyQueue.since - b[1].nashyQueue.since);
    if (queued.length === 0) {
      await sock.sendMessage(jid, { text: '✅ Queue is empty.' });
      return true;
    }
    const list = queued.map(([jid2, u], i) => {
      const phone = jid2.split('@')[0];
      const mins = Math.floor((Date.now() - u.nashyQueue.since) / 60000);
      return `${i + 1}. +${phone} — waiting ${mins}m`;
    }).join('\n');
    await sock.sendMessage(jid, { text: `📋 *Queue (${queued.length})*\n\n${list}` });
    return true;
  }

  if (lower.startsWith('/served ')) {
    const phone = lower.slice(8).trim().replace(/\D/g, '');
    const targetJid = `${phone}@s.whatsapp.net`;
    const u = statsDB.users[targetJid];
    if (u && u.nashyQueue) {
      u.nashyQueue.served = true;
      saveStats();
      await sock.sendMessage(jid, { text: `✅ Marked +${phone} as served.` });
      try {
        await sock.sendMessage(targetJid, {
          text: `✅ You've been marked as served. Thanks for waiting!\n\n_Type_ *menu* _to play games._`
        });
      } catch {}
    } else {
      await sock.sendMessage(jid, { text: `⚠️ +${phone} not found in queue.` });
    }
    return true;
  }

  if (lower.startsWith('/msg ')) {
    // /msg 263771234567 Your message here
    const parts = text.slice(5).trim().split(/\s+/);
    const phone = parts.shift().replace(/\D/g, '');
    const msg = parts.join(' ');
    if (!phone || !msg) {
      await sock.sendMessage(jid, { text: '⚠️ Usage: /msg 263771234567 your message' });
      return true;
    }
    try {
      await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: `👤 *Nashy:*\n\n${msg}` });
      await sock.sendMessage(jid, { text: `✅ Sent to +${phone}` });
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
    }
    return true;
  }

  if (lower === '/help' || lower === 'help') {
    await sock.sendMessage(jid, {
      text:
        `🛠️ *Nashy Admin*\n\n` +
        `/queue — list people waiting\n` +
        `/served <phone> — mark someone as served\n` +
        `/msg <phone> <text> — send a message as Nashy\n` +
        `/help — show this menu`
    });
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════
// 8. GAME HUB
// ═══════════════════════════════════════════════════════════
async function gameHub(sock, jid) {
  const u = getUser(jid);
  const gameRows = Object.values(games).map(g => ({
    id: `play_${g.id}`,
    title: `${g.emoji} ${g.name}`,
    description: 'Start playing'
  }));

  await safeSend('sendInteractiveMessage', sendInteractiveMessage, sock, jid, {
    text:
      `🎮 *Game Hub*\n\n` +
      `🏆 Wins: ${u.wins} | 💀 Losses: ${u.losses} | 🤝 Draws: ${u.draws}\n` +
      `🔥 Current streak: ${u.streak} | ⭐ Best: ${u.bestStreak}\n\n` +
      `Pick a game:`,
    footer: 'Powered by your Game Hub',
    interactiveButtons: [{
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: '🎯 Choose Game',
        sections: [
          { title: '🎮 Games', rows: gameRows },
          { title: '📊 Stats', rows: [
            { id: 'stats_view', title: '📊 My Stats', description: 'See your full record' },
            { id: 'stats_lb',   title: '🏅 Leaderboard', description: 'Top 10 players' },
            { id: 'stats_help', title: '❓ Help', description: 'How to play' }
          ]},
          { title: '👤 Human', rows: [
            { id: 'gate_nashy', title: '👤 Talk to Nashy', description: 'Queue for a human reply' }
          ]}
        ]
      })
    }]
  });
}

// ═══════════════════════════════════════════════════════════
// 9. MAIN ROUTER
// ═══════════════════════════════════════════════════════════
async function routeMessage(sock, jid, input) {
  const value = input.value;
  const lower = (value || '').toLowerCase();
  const u = getUser(jid);

  // ── Nashy's own messages = admin ──
  if (jid === NASHY_JID) {
    const handled = await handleNashyAdmin(sock, jid, value);
    if (!handled) {
      await sock.sendMessage(jid, { text: 'Type /help to see admin commands.' });
    }
    return true;
  }

  // ── Global commands ──
  if (lower === '/menu' || lower === '/start' || value === 'game_menu') {
    if (u.mode === 'nashy' && u.nashyQueue && !u.nashyQueue.served) {
      return sendQueueStatus(sock, jid);
    }
    clearSession(jid);
    u.mode = 'bot';
    saveStats();
    return gameHub(sock, jid);
  }

  if (value === 'gate_bot') {
    u.mode = 'bot';
    if (u.nashyQueue) u.nashyQueue.served = true;
    u.nashyQueue = null;
    u.nashyNotified = false;
    saveStats();
    clearSession(jid);
    await sock.sendMessage(jid, { text: '🎮 Great! Loading the Game Hub...' });
    return gameHub(sock, jid);
  }

  if (value === 'gate_nashy') return enqueueForNashy(sock, jid);
  if (value === 'gate_status') return sendQueueStatus(sock, jid);

  // ── First-contact gate ──
  const isGreeting = /^(hi|hie|hey|hello|yo|sup|hola|howdy|start|hallo)\b/i.test(lower);

  if (!u.greeted) {
    u.greeted = true;
    saveStats();
    return sendGate(sock, jid, false);
  }

  // ── Queued for Nashy ──
  if (u.mode === 'nashy' && u.nashyQueue && !u.nashyQueue.served) {
    if (isGreeting) return sendQueueStatus(sock, jid);
    await sock.sendMessage(jid, {
      text: `📬 Message received — Nashy will see it when he's back.\n\n_Type_ *menu* _to play games instead._`
    });
    forwardToNashy(sock, jid, value).catch(() => {});
    return true;
  }

  // ── Greeting from un-committed user ──
  if (isGreeting && u.mode !== 'bot') {
    return sendGate(sock, jid, true);
  }

  // ── Stats ──
  if (value === 'stats_view') {
    const perGame = Object.entries(u.perGame).map(([g, s]) =>
      `${games[g]?.emoji || '🎮'} *${games[g]?.name || g}*: ${s.wins}W / ${s.losses}L / ${s.draws}D`
    ).join('\n') || '_No games played yet._';
    await safeSend('sendButtons', sendButtons, sock, jid, {
      text:
        `📊 *Your Stats*\n\n` +
        `Games: *${u.gamesPlayed}*\n` +
        `Wins: *${u.wins}* | Losses: *${u.losses}* | Draws: *${u.draws}*\n` +
        `Streak: *${u.streak}* (best: ${u.bestStreak})\n\n` +
        `*Per game:*\n${perGame}`,
      footer: 'Keep playing!',
      buttons: [
        { id: 'game_menu', text: '🏠 Menu' },
        { id: 'stats_lb',  text: '🏅 Leaderboard' }
      ]
    });
    return true;
  }

  if (value === 'stats_lb') {
    const lb = leaderboard(10);
    const text = lb.length === 0
      ? '🏅 *Leaderboard*\n\nNo players yet. Be the first!'
      : '🏅 *Top 10 Players*\n\n' + lb.map((entry, i) =>
          `${i + 1}. ${entry.jid.split('@')[0].slice(0, 6)}*** — ${entry.wins}W / ${entry.losses}L 🔥${entry.bestStreak}`
        ).join('\n');
    await safeSend('sendButtons', sendButtons, sock, jid, {
      text,
      footer: 'Respect the grind',
      buttons: [{ id: 'game_menu', text: '🏠 Menu' }]
    });
    return true;
  }

  if (value === 'stats_help') {
    await safeSend('sendInteractiveMessage', sendInteractiveMessage, sock, jid, {
      text:
        `❓ *How to play*\n\n` +
        `Every game uses either *buttons/lists* or *plain text* (for words, numbers, letters).\n\n` +
        `• Tap a game to start\n` +
        `• Follow the on-screen prompts\n` +
        `• Type *cancel* anytime to quit\n` +
        `• Type *menu* or tap 🏠 to return to hub\n\n` +
        `Wins build streaks. Best streak is tracked forever. 🏆`,
      footer: 'Have fun!',
      interactiveButtons: [{
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: '🏠 Menu', id: 'game_menu' })
      }]
    });
    return true;
  }

  // ── Cancel ──
  if (lower === 'cancel' || lower === '/cancel') {
    clearSession(jid);
    await sock.sendMessage(jid, { text: '↩️ Cancelled.' });
    return gameHub(sock, jid);
  }

  // ── Start game ──
  if (value.startsWith('play_')) {
    const gameId = value.slice(5);
    const game = games[gameId];
    if (!game) return false;
    const session = setSession(jid, gameId, {});
    await game.start({ sock, jid, session });
    return true;
  }

  // ── In-game restart shortcuts ──
  const restartMap = {
    rps_again: 'rps', ttt_start: 'ttt', hm_start: 'hangman',
    guess_start: 'guess', wc_start: 'wordchain',
    mm_start: 'mystery', esc_start: 'escape'
  };
  if (restartMap[value]) {
    const gameId = restartMap[value];
    const session = setSession(jid, gameId, {});
    await games[gameId].start({ sock, jid, session });
    return true;
  }

  // ── Active session ──
  const session = getSession(jid);
  if (session) {
    const game = games[session.gameId];
    if (!game) { clearSession(jid); return false; }
    const ctx = { sock, jid, session };
    if (game.onButton) {
      const handled = await game.onButton(ctx, value);
      if (handled) return true;
    }
    const handled = await game.handle(ctx, input);
    if (handled) return true;
    await sock.sendMessage(jid, {
      text: `🤔 Not a valid move for *${game.name}*. Try again, or type *cancel*.`
    });
    return true;
  }

  // ── Fallback ──
  await safeSend('sendButtons', sendButtons, sock, jid, {
    text: `🤖 I didn't catch that. Type */menu* to see the Game Hub.`,
    footer: 'Game Hub',
    buttons: [{ id: 'game_menu', text: '🎮 Open Game Hub' }]
  });
  return true;
}

// ═══════════════════════════════════════════════════════════
// 10. KEEP-ALIVE SERVER
// ═══════════════════════════════════════════════════════════
const app = express();
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sessions: sessions.size,
    users: Object.keys(statsDB.users).length,
    queue: Object.values(statsDB.users).filter(x => x.nashyQueue && !x.nashyQueue.served).length,
    timestamp: new Date().toISOString()
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

// ═══════════════════════════════════════════════════════════
// 11. BOT BOOTSTRAP
// ═══════════════════════════════════════════════════════════
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.clear();
      console.log('📱 Scan QR:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('✅ Connected! Send /menu to start.');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      console.log(`❌ Closed (${code}). Reconnect: ${reconnect}`);
      if (reconnect) setTimeout(startBot, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const jid = m.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;

      const input = normalizeIncoming(m);
      if (!input) continue;
      console.log(`📩 ${jid} [${input.type}] → ${input.value.slice(0, 40)}`);

      const typing = await keepTyping(sock, jid, 4000);
      try {
        await routeMessage(sock, jid, input);
      } catch (e) {
        console.error('route error:', e);
        try { await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` }); } catch {}
      } finally {
        await typing.stop();
      }
    }
  });
}

process.on('SIGINT',  () => { saveStats(); process.exit(0); });
process.on('SIGTERM', () => { saveStats(); process.exit(0); });

startBot();