import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Simple QR endpoint (PNG) for room URL sharing
app.get('/qr', async (req, res) => {
  try {
    const text = req.query.text || 'https://example.com';
    const png = await QRCode.toBuffer(text, { type: 'png', margin: 1, scale: 6 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

// ---------- Game Data ----------
const ROLES = {
  MOBILE_DEV:   { id:'MOBILE_DEV',   name:'Mobile Developer',   desc:'User-Friendly: When you play a self-buff Action, draw +1 Progress (once/turn).', oncePerTurnKey:'mobile_bonus_used' },
  SYS_ARCH:     { id:'SYS_ARCH',     name:'Front/Back-end Developer', desc:'System Architect: Hand size limit is 11.' },
  QA:           { id:'QA',           name:'Quality Assurance',  desc:'Bug Hunter: Once/round, during someone else’s turn, reveal a random card from them; if it is a Bug, discard it.', oncePerRoundKey:'qa_used' },
  PRODUCT_OWNER:{ id:'PRODUCT_OWNER',name:'Product Owner',      desc:'Requirement Management: At start of your turn, swap a random card with a chosen player.' },
  IT_SUPPORT:   { id:'IT_SUPPORT',   name:'IT Support',         desc:'Troubleshooter: You can play Solution cards anytime to cancel a Bug on you.' },
};

const CARD_TYPES = {
  PROGRESS: 'PROGRESS',
  ACTION:   'ACTION',
  BUG:      'BUG',       // Traps, usually face-down
  SOLUTION: 'SOLUTION'   // Counters (reactions)
};

// A tiny ID helper
const rid = () => Math.random().toString(36).slice(2, 9);

// Build a deck with a reasonable distribution for 3–8 players
function buildDeck() {
  const deck = [];
  // 48 Progress cards
  for (let i=0;i<48;i++) {
    deck.push({ id:`PRG-${rid()}`, type:CARD_TYPES.PROGRESS, name:'Project Progress', text:'A step closer to launch.' });
  }

  // Action cards (examples)
  const actions = [
    { key:'CLIENT_CHANGED_MIND',  name:'ลูกค้าเปลี่ยนใจ!', text:'Choose a player; they discard 2 Progress if possible.', needTarget:true, benefitSelf:false },
    { key:'SERVER_DOWN',          name:'Server ล่ม!',       text:'All players discard half their Progress (rounded down).', global:true, benefitSelf:false },
    { key:'CLEAR_REQUIREMENTS',   name:'ได้ Requirement ชัดเจน!', text:'Draw 3 cards.', draw:3, benefitSelf:true },
    { key:'AGILE_ROTATE',         name:'ทำงานแบบ Agile',   text:'Everyone passes a random card to the left.', global:true, rotateLeft:true, benefitSelf:false },
    { key:'PARTNER_SUPPORT',      name:'ได้รับการสนับสนุนจากพาร์ทเนอร์', text:'Gain 2 Progress from the deck.', gainProgress:2, benefitSelf:true },
    { key:'STEAL_ONE',            name:'หยิบการ์ด 1 ใบ',   text:'Steal 1 random card from a player.', needTarget:true, steal:1, benefitSelf:true }
  ];
  actions.forEach(a => {
    for (let i=0;i<4;i++) deck.push({ id:`ACT-${rid()}`, type:CARD_TYPES.ACTION, ...a });
  });

  // Bug (Trap) cards
  const bugs = [
    { key:'QA_FAIL_TRAP',  name:'Code ไม่ผ่าน QA', text:'Trap: When someone declares Launch, they discard 3 Progress.', isTrap:true, trigger:'onLaunch', onLaunchDiscard:3 },
    { key:'DEADLINE_PUSH', name:'Deadline เลื่อนเข้ามา!', text:'Trap: When someone draws, they skip draw and end their turn.', isTrap:true, trigger:'onDrawSkip' },
    { key:'SECURITY_VULN', name:'พบช่องโหว่ความปลอดภัย!', text:'Trap: If someone steals from you, you steal 1 back.', isTrap:true, trigger:'onStolenStealBack', stealBack:1 }
  ];
  bugs.forEach(b => {
    for (let i=0;i<3;i++) deck.push({ id:`BUG-${rid()}`, type:CARD_TYPES.BUG, faceDown:true, ...b });
  });

  // Solution (Counter) cards
  const solutions = [
    { key:'IT_SUPPORT_ARRIVES', name:'IT Support มาแล้ว!', text:'Cancel a Bug effect (including global).', cancelBug:true },
    { key:'STACK_OVERFLOW',     name:'เจอ Solution ใน Stack Overflow!', text:'Cancel the last Action played by someone else.', cancelAction:true },
    { key:'FUNDING_GUARANTEE',  name:'การันตีค่าตอบแทน!', text:'If an effect makes you discard, cancel and draw 1 Progress.', cancelDiscard:true, drawProgress:1 }
  ];
  solutions.forEach(s => {
    for (let i=0;i<3;i++) deck.push({ id:`SOL-${rid()}`, type:CARD_TYPES.SOLUTION, ...s });
  });

  shuffle(deck);
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- State ----------
const rooms = new Map(); // roomId -> room

function createRoom(hostSocketId, hostName) {
  const id = makeRoomCode();
  const room = {
    id,
    createdAt: Date.now(),
    host: hostSocketId,
    players: [],
    deck: [],
    discard: [],
    turn: 0,
    started: false,
    launchPending: null, // { playerId, endsAt }
    logs: []
  };
  rooms.set(id, room);
  addPlayer(room, hostSocketId, hostName || 'Host');
  return room;
}

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<5;i++) s += letters[Math.floor(Math.random()*letters.length)];
  return s;
}

function addPlayer(room, socketId, name) {
  const player = {
    id: socketId,
    name: name || 'Player',
    role: null,
    hand: [],
    traps: [],
    ready: false,
    meta: {
      mobile_bonus_used: false,
      qa_used: false
    }
  };
  room.players.push(player);
  return player;
}

function removePlayer(room, socketId) {
  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx >= 0) {
    const [p] = room.players.splice(idx,1);
    // return cards to discard
    room.discard.push(...p.hand, ...p.traps);
  }
}

function getRoomBySocket(socket) {
  const rid = socket.data.roomId;
  return rid ? rooms.get(rid) : null;
}

function currentPlayer(room) {
  if (!room.started || !room.players.length) return null;
  const idx = (room.turn % room.players.length + room.players.length) % room.players.length;
  return room.players[idx];
}

function nextTurn(room) {
  // reset once-per-turn flags
  room.players.forEach(p => p.meta.mobile_bonus_used = false);
  room.turn = (room.turn + 1) % room.players.length;
  // Product Owner: mark that swap is available at the start of their turn
  const cp = currentPlayer(room);
  if (cp && cp.role === ROLES.PRODUCT_OWNER.id) {
    room.logs.push(`${cp.name} (PO) may swap a random card with a chosen player at start of turn.`);
  }
}

function drawFromDeck(room, n=1) {
  const out = [];
  for (let i=0;i<n;i++) {
    if (room.deck.length === 0) {
      // reshuffle discard
      if (room.discard.length === 0) break;
      room.deck = shuffle(room.discard);
      room.discard = [];
    }
    const c = room.deck.pop();
    out.push(c);
  }
  return out;
}

function countProgress(cards) {
  return cards.filter(c => c.type === CARD_TYPES.PROGRESS).length;
}

function enforceHandLimit(player) {
  const limit = player.role === ROLES.SYS_ARCH.id ? 11 : 10;
  if (player.hand.length > limit) {
    // Discard extras from the end (UI should prevent, but safety here)
    const extras = player.hand.splice(limit);
    return extras;
  }
  return [];
}

function dealInitial(room) {
  room.deck = buildDeck();
  room.discard = [];
  // 3 cards each
  room.players.forEach(p => {
    p.hand.push(...drawFromDeck(room, 3));
  });
}

function allPlayers(room) {
  return room.players.map(p => ({ id:p.id, name:p.name, role:p.role, handCount:p.hand.length, traps:p.traps.length }));
}

function broadcastRoom(room) {
  io.to(room.id).emit('room:update', {
    id: room.id,
    players: allPlayers(room),
    hostId: room.host,
    started: room.started,
    turnPlayerId: currentPlayer(room)?.id || null,
    logs: room.logs.slice(-200),
    launchPending: room.launchPending
  });
}

function findPlayer(room, pid) {
  return room.players.find(p => p.id === pid);
}

function discardCards(room, player, cards) {
  // move from hand to discard
  cards.forEach(c => {
    const idx = player.hand.findIndex(h => h.id === c.id);
    if (idx >= 0) {
      const [rm] = player.hand.splice(idx,1);
      room.discard.push(rm);
    }
  });
}

function randomCardFromHand(player, filterFn = null) {
  const pool = filterFn ? player.hand.filter(filterFn) : player.hand;
  if (pool.length === 0) return null;
  const card = pool[Math.floor(Math.random()*pool.length)];
  return card;
}

function passRandomCard(fromP, toP) {
  if (fromP.hand.length === 0) return null;
  const idx = Math.floor(Math.random() * fromP.hand.length);
  const [card] = fromP.hand.splice(idx,1);
  toP.hand.push(card);
  return card;
}

// ---------- Traps ----------
function triggerDrawTraps(room, drawingPlayer) {
  // DEADLINE_PUSH: when someone draws, skip draw and end their turn
  // Any player’s face-down trap can trigger; we pick the first applicable
  for (const owner of room.players) {
    if (owner.traps.length === 0) continue;
    const tIdx = owner.traps.findIndex(t => t.type===CARD_TYPES.BUG && t.trigger==='onDrawSkip' && t.faceDown);
    if (tIdx >= 0) {
      const [trap] = owner.traps.splice(tIdx,1);
      trap.faceDown = false;
      room.discard.push(trap);
      room.logs.push(`TRAP! ${owner.name} flipped "${trap.name}" — ${drawingPlayer.name} skips draw and their turn ends.`);
      return true; // blocked
    }
  }
  return false;
}

function triggerStealBackTraps(room, victim, thief) {
  // SECURITY_VULN: if someone steals from you, you steal 1 back
  for (const owner of room.players) {
    if (owner.id !== victim.id) continue;
    const tIdx = owner.traps.findIndex(t => t.type===CARD_TYPES.BUG && t.trigger==='onStolenStealBack' && t.faceDown);
    if (tIdx >= 0) {
      const [trap] = owner.traps.splice(tIdx,1);
      trap.faceDown = false;
      room.discard.push(trap);
      const stolenBack = passRandomCard(thief, owner);
      room.logs.push(`TRAP! ${owner.name} flipped "${trap.name}" and stole back ${stolenBack? '1 card' : 'nothing (no cards)'} from ${thief.name}.`);
      return true;
    }
  }
  return false;
}

function triggerLaunchTraps(room, launcher) {
  // QA_FAIL_TRAP: when someone declares Launch, they discard 3 Progress
  let totalHits = 0;
  for (const owner of room.players) {
    const tIdxs = [];
    owner.traps.forEach((t, idx) => {
      if (t.type===CARD_TYPES.BUG && t.trigger==='onLaunch' && t.faceDown) tIdxs.push(idx);
    });
    // Activate ALL such traps
    if (tIdxs.length) {
      // Activate in reverse order so splicing works
      tIdxs.reverse().forEach(idx => {
        const [trap] = owner.traps.splice(idx,1);
        trap.faceDown = false;
        room.discard.push(trap);
        // Discard up to N Progress
        let toDiscard = trap.onLaunchDiscard || 0;
        while (toDiscard > 0) {
          const c = launcher.hand.find(c => c.type===CARD_TYPES.PROGRESS);
          if (!c) break;
          const ci = launcher.hand.findIndex(x => x.id === c.id);
          const [rm] = launcher.hand.splice(ci,1);
          room.discard.push(rm);
          toDiscard--;
          totalHits++;
        }
        room.logs.push(`TRAP! ${owner.name} flipped "${trap.name}" — ${launcher.name} loses up to ${trap.onLaunchDiscard} Progress.`);
      });
    }
  }
  return totalHits;
}

// ---------- Solutions (counters) ----------
// We implement a simple "last effect" stack for cancellable things.
const effectStack = []; // push { roomId, type:'ACTION'|'BUG'|'DISCARD', ref, targetId? }

function pushEffect(room, effect) {
  effectStack.push({ roomId: room.id, ...effect, time: Date.now() });
  // trim old
  while (effectStack.length > 50) effectStack.shift();
}

function popLastEffect(room, predicate) {
  for (let i = effectStack.length-1; i >= 0; i--) {
    const e = effectStack[i];
    if (e.roomId !== room.id) continue;
    if (!predicate || predicate(e)) {
      const [rm] = effectStack.splice(i,1);
      return rm;
    }
  }
  return null;
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  // Join / Create
  socket.on('room:create', ({ name }) => {
    const room = createRoom(socket.id, name);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('room:joined', { roomId: room.id });
    broadcastRoom(room);
  });

  socket.on('room:join', ({ roomId, name }) => {
    const room = rooms.get((roomId||'').toUpperCase());
    if (!room) return socket.emit('errorMsg', 'Room not found.');
    socket.join(room.id);
    socket.data.roomId = room.id;
    addPlayer(room, socket.id, name);
    broadcastRoom(room);
  });

  socket.on('room:leave', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    removePlayer(room, socket.id);
    socket.leave(room.id);
    broadcastRoom(room);
  });

  socket.on('room:qrUrl', async () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    const url = `${getBaseUrl()}/?room=${room.id}`;
    socket.emit('room:qrUrl', { url });
  });

  socket.on('role:choose', ({ roleId }) => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    const p = findPlayer(room, socket.id);
    if (!p) return;
    if (!ROLES[roleId]) return socket.emit('errorMsg', 'Unknown role');
    p.role = ROLES[roleId].id;
    broadcastRoom(room);
  });

  socket.on('player:ready', ({ ready }) => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    const p = findPlayer(room, socket.id);
    if (!p) return;
    p.ready = !!ready;
    broadcastRoom(room);
  });

  socket.on('game:start', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    if (socket.id !== room.host) return socket.emit('errorMsg', 'Only host can start.');
    if (room.players.length < 2) return socket.emit('errorMsg', 'Need at least 2 players.');
    if (!room.players.every(p => p.role && p.ready)) return socket.emit('errorMsg', 'Everyone must choose role and ready.');
    room.started = true;
    room.turn = 0;
    room.logs = ['Game started!'];
    dealInitial(room);
    broadcastRoom(room);
    // Send each player their starting hand privately
    room.players.forEach(p => {
      io.to(p.id).emit('you:update', { hand: p.hand, traps: p.traps, role: p.role });
    });
  });

  socket.on('turn:draw', () => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;
    // Trigger draw traps (may skip)
    const skipped = triggerDrawTraps(room, cp);
    if (skipped) {
      room.logs.push(`${cp.name} draw skipped by a trap. Turn ends.`);
      nextTurn(room);
      broadcastRoom(room);
      return;
    }
    const drawn = drawFromDeck(room, 1);
    cp.hand.push(...drawn);
    room.logs.push(`${cp.name} drew 1 card.`);
    // Enforce hand limit
    const extras = enforceHandLimit(cp);
    if (extras.length) {
      room.discard.push(...extras);
      room.logs.push(`${cp.name} exceeded hand limit; auto-discarded ${extras.length}.`);
    }
    // Update private hand
    io.to(cp.id).emit('you:update', { hand: cp.hand, traps: cp.traps, role: cp.role });
    nextTurn(room);
    broadcastRoom(room);
  });

  socket.on('turn:playCard', ({ cardId, targetPlayerId, asTrap=false }) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;

    const card = cp.hand.find(c => c.id === cardId);
    if (!card) return socket.emit('errorMsg', 'Card not in hand');

    if (card.type === CARD_TYPES.BUG && asTrap && card.isTrap) {
      // Set face-down trap
      const idx = cp.hand.findIndex(c => c.id === cardId);
      const [trap] = cp.hand.splice(idx,1);
      trap.faceDown = true;
      cp.traps.push(trap);
      room.logs.push(`${cp.name} set a face-down trap.`);
      io.to(cp.id).emit('you:update', { hand: cp.hand, traps: cp.traps, role: cp.role });
      nextTurn(room);
      return broadcastRoom(room);
    }

    // Solutions cannot be played on turn as "actions"; they are reactions.
    if (card.type === CARD_TYPES.SOLUTION) {
      return socket.emit('errorMsg', 'Solution cards are reactions. Use when prompted or when targeted.');
    }

    if (card.type === CARD_TYPES.ACTION) {
      // Execute action
      const actionResult = applyActionCard(room, cp, card, targetPlayerId);
      // Hand + discard update
      const ci = cp.hand.findIndex(c => c.id === cardId);
      if (ci >= 0) {
        const [rm] = cp.hand.splice(ci,1);
        room.discard.push(rm);
      }
      // Mobile Dev bonus
      if (cp.role === ROLES.MOBILE_DEV.id && card.benefitSelf && !cp.meta.mobile_bonus_used) {
        const p = drawFromDeck(room, 1)[0];
        if (p) {
          // ensure it's a Progress; if not, just add drawn anyway (could be any card)
          cp.hand.push(p);
          room.logs.push(`${cp.name} (Mobile Dev) gains +1 draw due to self-buff action.`);
        }
        cp.meta.mobile_bonus_used = true;
      }
      io.to(cp.id).emit('you:update', { hand: cp.hand, traps: cp.traps, role: cp.role });
      nextTurn(room);
      broadcastRoom(room);
    } else if (card.type === CARD_TYPES.PROGRESS) {
      // Progress has no active play; playing it means "commit" to discard? Not allowed.
      return socket.emit('errorMsg', 'Progress cards cannot be played. Keep them to reach 10.');
    }
  });

  socket.on('role:poSwap', ({ targetPlayerId }) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;
    if (cp.role !== ROLES.PRODUCT_OWNER.id) return socket.emit('errorMsg', 'Not Product Owner.');
    const target = findPlayer(room, targetPlayerId);
    if (!target) return socket.emit('errorMsg', 'Target not found');
    // swap random one each
    const c1 = randomCardFromHand(cp);
    const c2 = randomCardFromHand(target);
    if (c1) cp.hand.splice(cp.hand.findIndex(c=>c.id===c1.id),1);
    if (c2) target.hand.splice(target.hand.findIndex(c=>c.id===c2.id),1);
    if (c1) target.hand.push(c1);
    if (c2) cp.hand.push(c2);
    room.logs.push(`${cp.name} (PO) swapped a random card with ${target.name}.`);
    io.to(cp.id).emit('you:update', { hand: cp.hand, traps: cp.traps, role: cp.role });
    io.to(target.id).emit('you:update', { hand: target.hand, traps: target.traps, role: target.role });
    broadcastRoom(room);
  });

  socket.on('qa:challenge', ({ targetPlayerId }) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    const challenger = findPlayer(room, socket.id);
    const target = findPlayer(room, targetPlayerId);
    const cp = currentPlayer(room);
    if (!challenger || !target) return;
    if (cp && cp.id === challenger.id) return socket.emit('errorMsg', 'Use QA on others’ turns only.');
    if (challenger.role !== ROLES.QA.id) return socket.emit('errorMsg', 'Not QA.');
    if (challenger.meta.qa_used) return socket.emit('errorMsg', 'QA already used this round.');

    const revealed = randomCardFromHand(target);
    if (!revealed) {
      room.logs.push(`${challenger.name} (QA) challenged ${target.name} but they had no cards.`);
    } else {
      room.logs.push(`${challenger.name} (QA) revealed a card from ${target.name}: "${revealed.name}".`);
      if (revealed.type === CARD_TYPES.BUG) {
        // discard it
        target.hand.splice(target.hand.findIndex(c=>c.id===revealed.id),1);
        room.discard.push(revealed);
        room.logs.push(`It was a Bug — discarded!`);
        io.to(target.id).emit('you:update', { hand: target.hand, traps: target.traps, role: target.role });
      }
    }
    challenger.meta.qa_used = true;
    broadcastRoom(room);
  });

  socket.on('declare:launch', () => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    const player = findPlayer(room, socket.id);
    if (!player) return;
    const progressCount = countProgress(player.hand);
    if (progressCount !== 10) return socket.emit('errorMsg', 'You must have exactly 10 Progress.');

    // Trigger onLaunch traps immediately
    const hits = triggerLaunchTraps(room, player);
    if (hits > 0) {
      io.to(player.id).emit('you:update', { hand: player.hand, traps: player.traps, role: player.role });
    }

    if (countProgress(player.hand) !== 10) {
      room.logs.push(`${player.name} tried to Launch, but lost Progress due to traps.`);
      broadcastRoom(room);
      return;
    }

    // Open a 15s reaction window for Solutions/Bugs that target or global
    const endsAt = Date.now() + 15000;
    room.launchPending = { playerId: player.id, endsAt };
    room.logs.push(`${player.name} DECLARED LAUNCH! Others have 15s to react with Solutions/Bugs.`);
    broadcastRoom(room);

    // After window ends, check again and award win
    setTimeout(() => {
      const r = rooms.get(room.id);
      if (!r || !r.launchPending || r.launchPending.playerId !== player.id) return;
      r.launchPending = null;
      if (countProgress(player.hand) === 10) {
        r.logs.push(`🎉 ${player.name} LAUNCHED SUCCESSFULLY and wins the game!`);
        r.started = false; // stop game
      } else {
        r.logs.push(`${player.name} launch was foiled!`);
      }
      broadcastRoom(r);
    }, 15500);
  });

  socket.on('reaction:play', ({ cardId, targetPlayerId }) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    const me = findPlayer(room, socket.id);
    if (!me) return;
    const card = me.hand.find(c => c.id === cardId);
    if (!card) return socket.emit('errorMsg', 'Card not in hand');
    if (card.type !== CARD_TYPES.SOLUTION && card.type !== CARD_TYPES.BUG) {
      return socket.emit('errorMsg', 'Only Solution or Bug (trap set) permitted as reaction.');
    }

    // If Bug and isTrap, allow setting during reaction too
    if (card.type === CARD_TYPES.BUG && card.isTrap) {
      const ci = me.hand.findIndex(c=>c.id===cardId);
      const [trap] = me.hand.splice(ci,1);
      trap.faceDown = true;
      me.traps.push(trap);
      room.logs.push(`${me.name} set a face-down trap during reaction window.`);
      io.to(me.id).emit('you:update', { hand: me.hand, traps: me.traps, role: me.role });
      return broadcastRoom(room);
    }

    if (card.type === CARD_TYPES.SOLUTION) {
      // Try cancel last effect relevant to this player or global
      // IT Support can cancel Bug, StackOverflow cancels last Action, Funding cancels last Discard targeting you
      if (card.cancelBug) {
        const e = popLastEffect(room, e => e.type === 'BUG' && (!e.targetId || e.targetId === me.id));
        if (e) {
          room.logs.push(`${me.name} canceled a Bug effect (${e.ref?.name || 'BUG'}).`);
        } else {
          room.logs.push(`${me.name} tried to cancel a Bug, but nothing relevant was on stack.`);
        }
      } else if (card.cancelAction) {
        const e = popLastEffect(room, e => e.type === 'ACTION' && e.by !== me.id);
        if (e) {
          room.logs.push(`${me.name} canceled an Action effect (${e.ref?.name || 'ACTION'})!`);
          // Note: we do not rewind state already changed; this is a simple demo cancel-detection.
        } else {
          room.logs.push(`${me.name} tried to cancel an Action, but nothing to cancel.`);
        }
      } else if (card.cancelDiscard) {
        const e = popLastEffect(room, e => e.type === 'DISCARD' && e.targetId === me.id);
        if (e) {
          room.logs.push(`${me.name} prevented a discard and draws 1 Progress.`);
          const p = drawFromDeck(room,1)[0];
          if (p) me.hand.push(p);
          io.to(me.id).emit('you:update', { hand: me.hand, traps: me.traps, role: me.role });
        } else {
          room.logs.push(`${me.name} tried to prevent a discard, but no pending discard on stack.`);
        }
      }
      // move solution card to discard
      const ci = me.hand.findIndex(c=>c.id===cardId);
      if (ci>=0) {
        const [rm] = me.hand.splice(ci,1);
        room.discard.push(rm);
      }
      io.to(me.id).emit('you:update', { hand: me.hand, traps: me.traps, role: me.role });
      return broadcastRoom(room);
    }
  });

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    removePlayer(room, socket.id);
    broadcastRoom(room);
  });
});

function applyActionCard(room, cp, card, targetPlayerId) {
  const target = targetPlayerId ? findPlayer(room, targetPlayerId) : null;
  switch (card.key) {
    case 'CLIENT_CHANGED_MIND': {
      if (!target) return;
      // push intended discard effect for solutions to catch
      pushEffect(room, { type:'DISCARD', by: cp.id, targetId: target.id, ref: card });
      let cnt = 2;
      while (cnt>0) {
        const prog = target.hand.find(c=>c.type===CARD_TYPES.PROGRESS);
        if (!prog) break;
        const i = target.hand.findIndex(c=>c.id===prog.id);
        room.discard.push(...target.hand.splice(i,1));
        cnt--;
      }
      room.logs.push(`${cp.name} played "${card.name}" — ${target.name} discards up to 2 Progress.`);
      io.to(target.id).emit('you:update', { hand: target.hand, traps: target.traps, role: target.role });
      break;
    }
    case 'SERVER_DOWN': {
      pushEffect(room, { type:'BUG', by: cp.id, ref: card }); // treat as cancellable by IT support
      room.players.forEach(p => {
        const total = countProgress(p.hand);
        const toLose = Math.floor(total/2);
        let lost = 0;
        for (let i=0;i<toLose;i++) {
          const pr = p.hand.find(c=>c.type===CARD_TYPES.PROGRESS);
          if (!pr) break;
          const idx = p.hand.findIndex(c=>c.id===pr.id);
          const [rm] = p.hand.splice(idx,1);
          room.discard.push(rm);
          lost++;
        }
        if (lost>0) io.to(p.id).emit('you:update', { hand: p.hand, traps: p.traps, role: p.role });
      });
      room.logs.push(`${cp.name} played "${card.name}" — everyone loses half their Progress.`);
      break;
    }
    case 'CLEAR_REQUIREMENTS': {
      const drawn = drawFromDeck(room, 3);
      cp.hand.push(...drawn);
      room.logs.push(`${cp.name} drew 3 cards via "${card.name}".`);
      break;
    }
    case 'AGILE_ROTATE': {
      // Pass one random card to the left
      const order = room.players;
      const passed = [];
      for (let i=0;i<order.length;i++) {
        const from = order[i];
        const to = order[(i+1)%order.length];
        const card = passRandomCard(from, to);
        passed.push([from.name,to.name, !!card]);
      }
      room.logs.push(`${cp.name} played "${card.name}" — everyone passed 1 random card left.`);
      order.forEach(p => io.to(p.id).emit('you:update', { hand: p.hand, traps: p.traps, role: p.role }));
      break;
    }
    case 'PARTNER_SUPPORT': {
      const ps = drawFromDeck(room, card.gainProgress || 0).filter(c => c);
      // ensure they are Progress — if not, place non-progress into hand anyway (simplified)
      cp.hand.push(...ps);
      room.logs.push(`${cp.name} gained ${ps.length} card(s) from partner support.`);
      break;
    }
    case 'STEAL_ONE': {
      if (!target) return;
      const stolen = passRandomCard(target, cp);
      triggerStealBackTraps(room, target, cp);
      io.to(cp.id).emit('you:update', { hand: cp.hand, traps: cp.traps, role: cp.role });
      io.to(target.id).emit('you:update', { hand: target.hand, traps: target.traps, role: target.role });
      room.logs.push(`${cp.name} stole ${stolen? '1 card' : 'nothing (no cards)'} from ${target.name}.`);
      break;
    }
    default: {
      room.logs.push(`${cp.name} played an unknown action.`);
    }
  }
}

function getBaseUrl() {
  // best-effort base URL (works for localhost)
  const host = process.env.BASE_URL || `http://localhost:${PORT}`;
  return host;
}

server.listen(PORT, () => {
  console.log(`DII: Project Launch server at http://localhost:${PORT}`);
});
