const socket = io();

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let YOU = {
  id: null,
  name: null,
  room: null,
  role: null,
  hand: [],
  traps: [],
  isHost: false,
};

const ROLES = [
  { id:'MOBILE_DEV',   name:'Mobile Developer',   desc:'User-Friendly: เมื่อคุณเล่นการ์ด Action ที่ส่งผลดีกับตัวเอง จั่ว +1 (ครั้ง/ตา)' },
  { id:'SYS_ARCH',     name:'Front/Back-end Dev', desc:'System Architect: ถือไพ่ได้สูงสุด 11 ใบ' },
  { id:'QA',           name:'Quality Assurance',  desc:'Bug Hunter: ในตาคนอื่น เปิดดูการ์ดสุ่ม 1 ใบ ถ้าเป็น Bug ทิ้งทันที (ครั้ง/รอบ)' },
  { id:'PRODUCT_OWNER',name:'Product Owner',      desc:'Requirement Management: เริ่มตาคุณ สลับไพ่สุ่มกับ 1 คน' },
  { id:'IT_SUPPORT',   name:'IT Support',         desc:'Troubleshooter: เล่น Solution ยกเลิก Bug ที่โดนคุณได้ทุกเวลา' },
];

const CARD_TYPE_LABEL = {
  PROGRESS: 'Progress',
  ACTION: 'Action',
  BUG: 'Bug/Trap',
  SOLUTION: 'Solution'
};

// Parse room code from URL
const urlParams = new URLSearchParams(location.search);
const prefillRoom = urlParams.get('room');
if (prefillRoom) {
  $("#roomCode").value = prefillRoom;
}

// Lobby handlers
$("#createRoomBtn").addEventListener('click', () => {
  const name = ($("#playerName").value || 'Player').trim();
  socket.emit('room:create', { name });
});
$("#joinRoomBtn").addEventListener('click', () => {
  const name = ($("#playerName").value || 'Player').trim();
  const roomId = ($("#roomCode").value || '').trim();
  if (!roomId) return alert('ป้อน Room Code');
  socket.emit('room:join', { roomId, name });
});

$("#startBtn").addEventListener('click', () => {
  socket.emit('game:start');
});

$("#readyToggle").addEventListener('change', (e) => {
  socket.emit('player:ready', { ready: e.target.checked });
});

// Player side buttons
$("#actionDevelop").addEventListener('click', () => {
  socket.emit('turn:draw');
});

$("#actionPOTarget").addEventListener('click', () => {
  const t = $("#targetSelect").value;
  if (!t) return alert('เลือกผู้เล่นเป้าหมาย');
  socket.emit('role:poSwap', { targetPlayerId: t });
});

$("#declareLaunchBtn").addEventListener('click', () => {
  socket.emit('declare:launch');
});

// เมื่อ join สำเร็จ (ทั้งคนสร้างห้องและคนที่เข้ามาทีหลังจะได้ event นี้)
socket.on('room:joined', ({ roomId }) => {
  YOU.room = roomId;
  YOU.id = socket.id;
  // ❌ อย่าบังคับ host
  // YOU.isHost = true;

  $("#lobby").classList.remove('hidden');
  $("#roleArea").classList.remove('hidden');

  // ✅ สร้างรายการบทบาททันที
  renderRoles();

  // ขอ QR (ไม่ใช่ host ก็ได้ลิงก์เดียวกัน)
  requestQR();
});

socket.on('room:update', (data) => {
  // ✅ รู้ host ที่แท้จริงจาก server
  YOU.isHost = (socket.id === data.hostId);

  $("#roleArea").classList.remove('hidden');

  if (!YOU.room && data.id) YOU.room = data.id;

  // ✅ เผื่อกรณี client โหลดหน้านี้โดยตรงแล้วไม่ได้ผ่าน room:joined
  if (!$("#roles").children.length) {
    renderRoles();
  }

  renderPlayersLobby(data.players);
  renderInGame(data);
  renderLog(data.logs);

  $("#startBtn").disabled = !YOU.isHost;

  if (data.launchPending) $("#launchInfo").classList.remove('hidden');
  else $("#launchInfo").classList.add('hidden');
});


socket.on('you:update', ({ hand, traps, role }) => {
  if (hand) YOU.hand = hand;
  if (traps) YOU.traps = traps;
  if (role) YOU.role = role;
  renderHand();
  renderTraps();
});

socket.on('errorMsg', (msg) => alert(msg));

socket.on('room:qrUrl', ({ url }) => {
  const img = $("#qr");
  img.src = `/qr?text=${encodeURIComponent(url)}`;
  $("#roomLink").textContent = url;
  $("#share").classList.remove('hidden');
});

function requestQR() {
  socket.emit('room:qrUrl');
}

function renderRoles() {
  const c = $("#roles");
  c.innerHTML = '';
  ROLES.forEach(r => {
    const el = document.createElement('div');
    el.className = 'role';
    el.innerHTML = `<div class="name">${r.name}</div><div class="muted">${r.desc}</div>`;
    el.addEventListener('click', () => {
      $$(".role").forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      socket.emit('role:choose', { roleId: r.id });
    });
    c.appendChild(el);
  });
}

function renderPlayersLobby(players=[]) {
  const label = id => (ROLES.find(r=>r.id===id)?.name || id || '');
  const ul = $("#players");
  ul.innerHTML = '';
  players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name} ${p.role? '— ' + label(p.role) : ''} ${p.ready? '✅' : ''}`;
    ul.appendChild(li);
  });
}

function renderInGame(data) {
  if (!data.started) {
    $("#game").classList.add('hidden');
    return;
  }
  $("#game").classList.remove('hidden');

  const ul = $("#playersInGame");
  ul.innerHTML = '';
  data.players.forEach(p => {
    const li = document.createElement('li');
    const isTurn = (p.id === data.turnPlayerId);
    li.innerHTML = `<strong>${p.name}</strong> ${isTurn? '🟢' : ''}<br/>
      ไพ่: ${p.handCount} | Traps: ${p.traps}`;
    ul.appendChild(li);
  });
  $("#turnInfo").textContent = `ถึงตา: ${ (data.players.find(p=>p.id===data.turnPlayerId)?.name)||'-' }`;

  const sel = $("#targetSelect");
  sel.innerHTML = `<option value="">เลือกผู้เล่นเป้าหมาย</option>`;
  data.players.filter(p => p.id !== socket.id).forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });

  renderHand();
  renderTraps();
}

function renderHand() {
  const div = $("#hand");
  div.innerHTML = '';
  YOU.hand.forEach(c => {
    const el = document.createElement('div');
    el.className = 'cardItem';
    el.innerHTML = `
      <div class="type ${c.type}">${CARD_TYPE_LABEL[c.type]||c.type}</div>
      <div class="name">${c.name||'-'}</div>
      <div class="text">${c.text||''}</div>
      <div class="actions"></div>
    `;
    const actions = el.querySelector('.actions');

    if (c.type === 'ACTION') {
      const playBtn = document.createElement('button');
      playBtn.textContent = 'Play';
      playBtn.addEventListener('click', () => {
        const target = $("#targetSelect").value || null;
        socket.emit('turn:playCard', { cardId:c.id, targetPlayerId: target });
      });
      actions.appendChild(playBtn);
    }
    if (c.type === 'BUG' && c.isTrap) {
      const setBtn = document.createElement('button');
      setBtn.textContent = 'Set as Trap';
      setBtn.addEventListener('click', () => {
        socket.emit('turn:playCard', { cardId:c.id, asTrap:true });
      });
      actions.appendChild(setBtn);
    }
    if (c.type === 'SOLUTION') {
      const reactBtn = document.createElement('button');
      reactBtn.textContent = 'Use Reaction';
      reactBtn.addEventListener('click', () => {
        const target = $("#targetSelect").value || null;
        socket.emit('reaction:play', { cardId:c.id, targetPlayerId: target });
      });
      actions.appendChild(reactBtn);
    }
    div.appendChild(el);
  });

  const progress = YOU.hand.filter(x=>x.type==='PROGRESS').length;
  $("#declareLaunchBtn").disabled = (progress !== 10);
}

function renderTraps() {
  const ul = $("#myTraps");
  ul.innerHTML = '';
  YOU.traps.forEach(t => {
    const li = document.createElement('li');
    li.textContent = t.faceDown ? '🔒 Face-down Trap' : (t.name || 'Trap');
    ul.appendChild(li);
  });
}

function renderLog(lines=[]) {
  const log = $("#log");
  log.innerHTML = '';
  lines.forEach(l => {
    const p = document.createElement('div');
    p.textContent = l;
    log.appendChild(p);
  });
  log.scrollTop = log.scrollHeight;
}

// QA challenge on others' turns
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'q') {
    const t = $("#targetSelect").value;
    if (!t) return;
    socket.emit('qa:challenge', { targetPlayerId: t });
  }
});
