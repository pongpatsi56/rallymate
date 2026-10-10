// Thai-first client. Admin controls are only rendered when this browser holds the
// host token, and the server re-checks the token on every admin request.

const POLL_MS = 3000;
const $ = (sel) => document.querySelector(sel);

const T = {
  mode: { fair: 'โหมดยุติธรรม', champion: 'โหมดแชมป์' },
  modeShort: { fair: 'ยุติธรรม', champion: 'แชมป์' },
  sessionStatus: { setup: 'เตรียมก๊วน', active: 'กำลังเล่น', ended: 'จบก๊วนแล้ว' },
  matchStatus: { scheduled: 'จัดทีมแล้ว รอเริ่ม', in_progress: 'กำลังแข่ง', completed: 'จบแล้ว', cancelled: 'ยกเลิก' },
  playerStatus: {
    waiting: 'รอคิว', in_match: 'ลงสนาม', champion_hold: 'แชมป์ครองคอร์ท', unavailable: 'พักชั่วคราว', left: 'กลับบ้านแล้ว',
  },
  outcome: {
    rotate_fair: 'หมุนออกทั้งสองทีม',
    rotate_mode_switched: 'เปลี่ยนเป็นโหมดยุติธรรม หมุนออกทั้งสองทีม',
    rotate_override_force: 'ผู้จัดสั่งหมุนออกทั้งสองทีม',
    rotate_override_release: 'ผู้จัดปลดแชมป์ หมุนออกทั้งสองทีม',
    rotate_max_wins: 'แชมป์ชนะครบ 2 ตา หมุนออกทั้งสองทีม',
    champion_retained: 'แชมป์ป้องกันตำแหน่งได้',
    champion_crowned: 'ได้แชมป์คอร์ท',
    challenger_crowned: 'ผู้ท้าชิงชนะ ขึ้นเป็นแชมป์ใหม่',
  },
  errors: {
    UNAUTHORIZED: 'ต้องเป็นผู้จัดก๊วนเท่านั้น',
    FORBIDDEN: 'ลิงก์ผู้จัดไม่ถูกต้อง',
    SESSION_NOT_FOUND: 'ไม่พบก๊วนนี้',
    NOT_ENOUGH_PLAYERS: 'ผู้เล่นที่รอคิวไม่พอจัดแมตช์',
    COURT_BUSY: 'คอร์ทนี้มีแมตช์อยู่แล้ว',
    COURT_IDLE: 'คอร์ทนี้ยังไม่มีแมตช์',
    MATCH_ALREADY_FINISHED: 'แมตช์นี้จบหรือถูกยกเลิกไปแล้ว (อาจมีคนกดซ้ำ)',
    INVALID_MATCH_STATE: 'สถานะแมตช์ไม่ถูกต้องสำหรับการกระทำนี้',
    INVALID_SESSION_STATE: 'สถานะก๊วนไม่ถูกต้องสำหรับการกระทำนี้',
    PLAYER_IN_MATCH: 'ผู้เล่นกำลังอยู่ในแมตช์ ให้ใช้ “เปลี่ยนตัว” แทน',
    PLAYER_NOT_AVAILABLE: 'ผู้เล่นตัวสำรองไม่ได้อยู่ในคิว',
    INVALID_PLAYER_STATE: 'สถานะผู้เล่นไม่ถูกต้องสำหรับการกระทำนี้',
    DUPLICATE_NAME: 'มีผู้เล่นชื่อนี้อยู่แล้ว',
    NO_CHAMPION: 'คอร์ทนี้ไม่มีแชมป์',
    NOT_CHAMPION_MODE: 'แมตช์นี้เล่นด้วยกติกาโหมดยุติธรรม',
    NO_PENDING_OVERRIDE: 'ไม่มีคำสั่งที่รอดำเนินการ',
    ACTIVE_MATCHES: 'ต้องจบหรือยกเลิกทุกแมตช์ก่อนจบก๊วน',
    CONFIRMATION_REQUIRED: 'ต้องยืนยันก่อนดำเนินการ',
    VERSION_CONFLICT: 'ข้อมูลมีการเปลี่ยนแปลง กรุณาลองใหม่',
    VALIDATION_ERROR: 'ข้อมูลไม่ถูกต้อง',
  },
};

const state = { sessionId: null, token: null, session: null, role: 'viewer', pollTimer: null, busy: false, renderedAt: 0 };

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
const fmtMinutes = (ms) => `${Math.max(0, Math.round(ms / 60000))} นาที`;
const pname = (id) => esc(state.session?.players[id]?.name ?? id);
const isHost = () => state.role === 'host';

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['X-Host-Token'] = state.token;
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error?.code ?? 'INTERNAL_ERROR', json.error?.message ?? res.statusText);
  return json;
}

/** Runs a host action: disables controls while in flight so double-taps cannot double-submit. */
async function hostAction(method, path, body, successMessage) {
  if (state.busy) return null;
  state.busy = true;
  document.body.classList.add('busy');
  document.querySelectorAll('#session button').forEach((b) => { b.disabled = true; });
  try {
    const json = await request(method, `/api/sessions/${state.sessionId}${path}`, body);
    if (json.session) applySession(json.session, state.role);
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(json) : successMessage);
    return json;
  } catch (err) {
    toast(T.errors[err.code] ?? `เกิดข้อผิดพลาด: ${err.message}`, 'error');
    await refresh();
    return null;
  } finally {
    state.busy = false;
    document.querySelectorAll('#session button').forEach((b) => { b.disabled = false; });
  }
}

/** Generic dialog. Resolves with FormData when confirmed, null when cancelled. */
function openDialog({ title, body, okLabel = 'ยืนยัน', danger = false }) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  const ok = $('#dialog-ok');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (state.session) render(); // catch up on polls skipped while the dialog was open
      resolve(dialog.returnValue === 'ok' ? new FormData($('#dialog-form')) : null);
    }, { once: true });
  });
}

const confirmDialog = (title, message, opts = {}) =>
  openDialog({ title, body: `<p>${message}</p>`, ...opts }).then((r) => r !== null);

// ---------------------------------------------------------------------------
// Routing & data
// ---------------------------------------------------------------------------

function route() {
  clearInterval(state.pollTimer);
  const hash = location.hash.replace(/^#/, '');
  const m = hash.match(/^\/s\/([\w-]+)(?:\?k=([\w-]+))?$/);
  if (!m) {
    state.sessionId = null;
    $('#home').hidden = false;
    $('#session').hidden = true;
    $('#role-badge').hidden = true;
    return;
  }
  const [, id, key] = m;
  if (key) {
    try { localStorage.setItem(`host:${id}`, key); } catch { /* storage blocked: keep token in memory */ }
    state.token = key;
    history.replaceState(null, '', `#/s/${id}`);
  } else {
    let stored = null;
    try { stored = localStorage.getItem(`host:${id}`); } catch { /* storage blocked */ }
    state.token = stored ?? (state.sessionId === id ? state.token : null);
  }
  state.sessionId = id;
  state.session = null;
  $('#home').hidden = true;
  $('#session').hidden = false;
  refresh();
  state.pollTimer = setInterval(() => { if (!document.hidden && !state.busy) refresh(); }, POLL_MS);
}

async function refresh() {
  if (!state.sessionId) return;
  try {
    const json = await request('GET', `/api/sessions/${state.sessionId}`);
    applySession(json.session, json.role);
  } catch (err) {
    if (err.code === 'SESSION_NOT_FOUND') {
      $('#session-header').innerHTML = '<h1>ไม่พบก๊วนนี้</h1><p><a href="#/">สร้างก๊วนใหม่</a></p>';
      clearInterval(state.pollTimer);
    }
  }
}

function applySession(session, role) {
  const changed = !state.session || session.version !== state.session.version || role !== state.role;
  // Re-render at least every 30s so waiting times keep counting up.
  const stale = session.serverTime - state.renderedAt > 30000;
  state.session = session;
  state.role = role;
  if ((changed || stale) && !$('#dialog').open) render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const s = state.session;
  if (!s) return;
  state.renderedAt = s.serverTime;
  document.title = `${s.name} · จัดก๊วนแบด`;
  const roleBadge = $('#role-badge');
  roleBadge.hidden = false;
  roleBadge.textContent = isHost() ? 'ผู้จัดก๊วน' : 'ผู้ชม (ดูอย่างเดียว)';
  $('#host-tools').hidden = !isHost() || s.status === 'ended';
  renderHeader(s);
  renderCourts(s);
  renderQueue(s);
  renderPlayers(s);
  renderEvents(s);
  if (isHost()) renderShare(s);
}

function renderHeader(s) {
  const pendingCourts = s.courts.filter((c) => c.pendingMode);
  const host = isHost() && s.status !== 'ended';
  $('#session-header').innerHTML = `
    <div class="session-head">
      <div>
        <h1>${esc(s.name)}</h1>
        <div class="row">
          <span class="badge status-badge">${T.sessionStatus[s.status]}</span>
          <span class="badge mode-${s.mode}">${T.mode[s.mode]}</span>
          <span class="muted">ผู้เล่น ${Object.values(s.players).filter((p) => p.status !== 'left').length} คน · ${s.courts.length} คอร์ท</span>
        </div>
      </div>
      ${host ? `
        <div class="stack">
          <div class="mode-switch" role="group" aria-label="เลือกโหมด">
            <span class="muted">โหมด:</span>
            <button class="btn seg" data-action="set-mode" data-mode="fair" aria-pressed="${s.mode === 'fair'}">ยุติธรรม</button>
            <button class="btn seg" data-action="set-mode" data-mode="champion" aria-pressed="${s.mode === 'champion'}">แชมป์</button>
          </div>
          <div class="row">
            ${s.status === 'setup' ? '<button class="btn primary" data-action="start-session">เริ่มก๊วน</button>' : ''}
            ${s.status === 'active' ? '<button class="btn danger" data-action="end-session">จบก๊วน</button>' : ''}
          </div>
        </div>` : ''}
    </div>
    ${pendingCourts.length ? `<div class="notice">⏳ รอเปลี่ยนโหมด: ${pendingCourts.map((c) => `${esc(c.name)} → ${T.modeShort[c.pendingMode]}`).join(', ')} (มีผลหลังแมตช์ปัจจุบันจบ)</div>` : ''}
    <p class="muted">${s.mode === 'champion'
      ? 'โหมดแชมป์: ทีมที่ชนะอยู่ต่อได้สูงสุด 2 ตาติดต่อกัน ผู้ท้าชิงที่ชนะจะเป็นแชมป์ใหม่'
      : 'โหมดยุติธรรม: ทั้งสองทีมออกหลังจบแมตช์ คนที่เล่นน้อยได้ลงก่อน'}</p>`;
}

function renderCourts(s) {
  $('#courts').innerHTML = s.courts.map((court) => renderCourt(s, court)).join('');
}

function renderCourt(s, court) {
  const match = court.currentMatchId ? s.matches[court.currentMatchId] : null;
  const host = isHost() && s.status === 'active';
  const max = s.config.maxChampionWins;
  const lastDone = [...s.matchOrder].reverse().map((id) => s.matches[id]).find((m) => m.courtId === court.id && m.status !== 'scheduled' && m.status !== 'in_progress');

  const championBlock = court.champion ? `
    <div class="champion">👑 แชมป์: ${court.champion.team.map(pname).join(' & ')}
      <span class="muted">· ชนะติดต่อกัน ${court.champion.streak}/${max}</span>
      <span class="streak" aria-hidden="true">${Array.from({ length: max }, (_, i) => `<i class="${i < court.champion.streak ? 'on' : ''}"></i>`).join('')}</span>
    </div>` : '';

  const notices = [];
  if (court.pendingMode) notices.push(`⏳ จะเปลี่ยนเป็น${T.mode[court.pendingMode]}หลังแมตช์นี้จบ`);
  if (court.pendingOverride === 'release') notices.push('⚠️ ผู้จัดสั่งปลดแชมป์หลังแมตช์นี้');
  if (court.pendingOverride === 'force_rotate') notices.push('⚠️ ผู้จัดสั่งหมุนออกทั้งสองทีมหลังแมตช์นี้');

  let matchBlock;
  if (match) {
    const team = (key, label) => {
      const ids = match[key === 'A' ? 'teamA' : 'teamB'];
      const champ = match.championTeam === key;
      return `<div class="team ${champ ? 'is-champion' : ''}">
        <span class="team-label">ทีม ${label}${champ ? ' 👑' : ''}</span>
        ${ids.map((id) => `<span class="pname">${pname(id)}${host ? `<button class="btn small" data-action="substitute" data-match="${match.id}" data-player="${id}" title="เปลี่ยนตัว" aria-label="เปลี่ยนตัว ${pname(id)}">⇄</button>` : ''}</span>`).join('')}
      </div>`;
    };
    matchBlock = `
      <p class="muted">แมตช์ #${match.no} · ${T.matchStatus[match.status]}</p>
      <div class="match">${team('A', 'A')}<span class="vs">VS</span>${team('B', 'B')}</div>
      ${host ? `<div class="actions">
        ${match.status === 'scheduled' ? `<button class="btn primary" data-action="start-match" data-match="${match.id}">เริ่มแมตช์</button>` : ''}
        ${match.status === 'in_progress' ? `
          <button class="btn primary" data-action="result" data-match="${match.id}" data-winner="A">ทีม A ชนะ</button>
          <button class="btn primary" data-action="result" data-match="${match.id}" data-winner="B">ทีม B ชนะ</button>` : ''}
        <button class="btn danger" data-action="cancel-match" data-match="${match.id}">ยกเลิกแมตช์</button>
      </div>` : ''}`;
  } else {
    const waitingNeed = court.champion ? 2 : 4;
    matchBlock = `<p class="muted">คอร์ทว่าง${s.status === 'active' ? ` · ต้องการผู้เล่นรอคิว ${waitingNeed} คน (มี ${s.queue.length})` : ''}</p>
      ${lastDone ? `<p class="muted">ล่าสุด: แมตช์ #${lastDone.no} ${lastDone.status === 'cancelled' ? 'ถูกยกเลิก' : `ทีม ${lastDone.winner} ชนะ · ${T.outcome[lastDone.outcome] ?? ''}`}</p>` : ''}
      ${host ? `<div class="actions"><button class="btn primary" data-action="next" data-court="${court.id}">จัดแมตช์ถัดไป</button></div>` : ''}`;
  }

  const canOverride = host && (court.champion || (match && match.mode === 'champion'));
  return `<article class="card court">
    <header><h3>${esc(court.name)}</h3><span class="badge mode-${court.effectiveMode}">${T.modeShort[court.effectiveMode]}</span></header>
    ${notices.map((n) => `<div class="notice">${n}</div>`).join('')}
    ${championBlock}
    ${matchBlock}
    ${canOverride ? `<div class="actions" style="margin-top:.5rem"><button class="btn small" data-action="override" data-court="${court.id}">⚙️ จัดการแชมป์</button></div>` : ''}
  </article>`;
}

function renderQueue(s) {
  const rows = s.priorityQueue.map((id) => {
    const p = s.players[id];
    return `<li>${esc(p.name)} <span class="muted">· เล่น ${p.gamesPlayed} · รอ ${fmtMinutes(s.serverTime - p.queuedAt)}</span></li>`;
  });
  $('#queue').innerHTML = `<h2>คิวรอลงสนาม (${rows.length})</h2>
    <p class="muted">เรียงตามความยุติธรรม: เล่นน้อยก่อน แล้วตามลำดับคิว</p>
    ${rows.length ? `<ol class="queue">${rows.join('')}</ol>` : '<p class="muted">ไม่มีคนรอคิว</p>'}`;
}

function renderPlayers(s) {
  const host = isHost() && s.status !== 'ended';
  const players = Object.values(s.players).sort((a, b) => (a.status === 'left') - (b.status === 'left') || a.name.localeCompare(b.name, 'th'));
  const actions = (p) => {
    if (!host) return '';
    const btns = [];
    if (p.status === 'waiting' || p.status === 'champion_hold') btns.push(`<button class="btn small" data-action="unavailable" data-player="${p.id}">พัก</button>`);
    if (p.status === 'unavailable' || p.status === 'left') btns.push(`<button class="btn small" data-action="return" data-player="${p.id}">กลับเข้าคิว</button>`);
    if (p.status !== 'left' && p.status !== 'in_match') btns.push(`<button class="btn small danger" data-action="remove" data-player="${p.id}">กลับบ้าน</button>`);
    return `<td><div class="actions">${btns.join('')}</div></td>`;
  };
  $('#players').innerHTML = `<h2>ผู้เล่นทั้งหมด</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>ชื่อ</th><th>สถานะ</th><th>เล่น</th><th>ชนะ-แพ้</th><th>รอรวม</th>${host ? '<th></th>' : ''}</tr></thead>
      <tbody>${players.map((p) => {
        const wait = p.totalWaitMs + (p.status === 'waiting' && s.status !== 'ended' ? s.serverTime - p.queuedAt : 0);
        return `<tr>
          <td>${esc(p.name)}</td><td>${T.playerStatus[p.status]}</td>
          <td class="num">${p.gamesPlayed}</td><td class="num">${p.wins}-${p.losses}</td><td class="num">${fmtMinutes(wait)}</td>
          ${actions(p)}</tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function describeEvent(e) {
  const d = e.data;
  const court = (id) => esc(state.session.courts.find((c) => c.id === id)?.name ?? id);
  const team = (ids) => (ids ?? []).map(pname).join(' & ');
  switch (e.type) {
    case 'SESSION_CREATED': return 'สร้างก๊วน';
    case 'SESSION_STARTED': return 'เริ่มก๊วน';
    case 'SESSION_ENDED': return 'จบก๊วน';
    case 'MODE_CHANGE_REQUESTED':
      return `ผู้จัดเปลี่ยนเป็น${T.mode[d.to]}${d.pendingCourts.length ? ` (${d.pendingCourts.map(court).join(', ')} มีผลหลังแมตช์จบ)` : ''}`;
    case 'MODE_CHANGE_APPLIED': return `${court(d.courtId)} ใช้${T.mode[d.to]}แล้ว`;
    case 'MATCH_SCHEDULED': return `${court(d.courtId)}: จัดทีม ${team(d.teamA)} พบ ${team(d.teamB)}`;
    case 'MATCH_STARTED': return `${court(d.courtId)}: เริ่มแข่ง`;
    case 'MATCH_COMPLETED': return `${court(d.courtId)}: ${team(d.winners)} ชนะ · ${T.outcome[d.outcome] ?? ''}`;
    case 'MATCH_CANCELLED': return `${court(d.courtId)}: ยกเลิกแมตช์ (ไม่บันทึกผล)${d.reason ? ` · ${esc(d.reason)}` : ''}`;
    case 'CHAMPION_CROWNED': return `${court(d.courtId)}: 👑 ${team(d.team)} เป็นแชมป์`;
    case 'CHAMPION_RETAINED': return `${court(d.courtId)}: 👑 ${team(d.team)} ป้องกันแชมป์ (${d.streak} ตาติด)`;
    case 'CHAMPION_ROTATED': return `${court(d.courtId)}: ${team(d.team)} หมุนออก`;
    case 'CHAMPION_RELEASED': return `${court(d.courtId)}: ปลดแชมป์ ${team(d.team)}`;
    case 'CHAMPION_OVERRIDE_REQUESTED': return `${court(d.courtId)}: ผู้จัดสั่ง “${overrideLabel(d.action)}”`;
    case 'CHAMPION_OVERRIDE_APPLIED': return `${court(d.courtId)}: ดำเนินการคำสั่งผู้จัดแล้ว (ไม่นับเป็นแพ้/ชนะ)`;
    case 'CHAMPION_OVERRIDE_WITHDRAWN': return `${court(d.courtId)}: ยกเลิกคำสั่งจัดการแชมป์`;
    case 'PLAYER_ADDED': return `เพิ่มผู้เล่น ${esc(d.name)}${d.midSession ? ' (ระหว่างก๊วน)' : ''}`;
    case 'PLAYER_UNAVAILABLE': return `${pname(d.playerId)} พักชั่วคราว`;
    case 'PLAYER_RETURNED': return `${pname(d.playerId)} กลับเข้าคิว`;
    case 'PLAYER_REMOVED': return `${pname(d.playerId)} กลับบ้าน`;
    case 'PLAYER_SUBSTITUTED':
      return `${court(d.courtId)}: เปลี่ยนตัว ${pname(d.outPlayerId)} → ${pname(d.inPlayerId)}${d.phase === 'in_progress' ? ' (ระหว่างแข่ง)' : ''}`;
    default: return esc(e.type);
  }
}

function overrideLabel(action) {
  return {
    release_after_match: 'ปลดแชมป์หลังแมตช์นี้',
    release_now: 'ปลดแชมป์ทันที',
    force_rotate_after_match: 'หมุนออกทั้งสองทีมหลังแมตช์นี้',
    cancel_pending: 'ยกเลิกคำสั่ง',
  }[action] ?? action;
}

function renderEvents(s) {
  const items = [...s.events].reverse().slice(0, 100);
  $('#events').innerHTML = `<h2>ประวัติก๊วน</h2>
    <ul class="events">${items.map((e) => `<li><time>${fmtTime(e.at)}</time><span>${describeEvent(e)}</span></li>`).join('')}</ul>`;
}

function renderShare(s) {
  const base = `${location.origin}${location.pathname}#/s/${s.id}`;
  $('#share-links').innerHTML = `
    <label>ลิงก์สำหรับผู้ชม (ดูอย่างเดียว)
      <div class="row"><input readonly value="${esc(base)}"><button class="btn small" data-action="copy" data-value="${esc(base)}">คัดลอก</button></div>
    </label>
    <label>ลิงก์ผู้จัด (ห้ามแชร์ให้คนอื่น)
      <div class="row"><input readonly value="${esc(`${base}?k=${state.token}`)}" type="password"><button class="btn small" data-action="copy" data-value="${esc(`${base}?k=${state.token}`)}">คัดลอก</button></div>
    </label>`;
}

// ---------------------------------------------------------------------------
// Host actions
// ---------------------------------------------------------------------------

const actions = {
  async 'set-mode'(el) {
    const s = state.session;
    const mode = el.dataset.mode;
    if (mode === s.mode && !s.courts.some((c) => c.pendingMode)) return;
    const busy = s.courts.filter((c) => c.currentMatchId);
    const hasChampion = s.courts.some((c) => c.champion);
    let msg = `เปลี่ยนเป็น<strong>${T.mode[mode]}</strong>?`;
    if (busy.length) msg += `<br>คอร์ทที่กำลังแข่ง (${busy.map((c) => esc(c.name)).join(', ')}) จะเปลี่ยนหลังแมตช์ปัจจุบันจบ แมตช์ที่กำลังเล่นจะไม่ถูกยกเลิก`;
    if (mode === 'fair' && hasChampion) msg += '<br>⚠️ แชมป์และสถิติชนะติดต่อกันจะถูกล้าง (สถิติการเล่นยังอยู่ครบ)';
    if (mode === 'champion') msg += '<br>เริ่มนับแชมป์จากแมตช์ถัดไปที่จบ';
    if (!(await confirmDialog('เปลี่ยนโหมด', msg))) return;
    await hostAction('PUT', '/mode', { mode }, (json) =>
      json.result.pendingCourts.length ? `ตั้งค่าแล้ว · รอเปลี่ยนโหมดหลังแมตช์จบ` : `เปลี่ยนเป็น${T.mode[mode]}แล้ว`);
  },
  async 'start-session'() {
    await hostAction('POST', '/start', {}, 'เริ่มก๊วนแล้ว');
  },
  async 'end-session'() {
    if (!(await confirmDialog('จบก๊วน', 'ยืนยันจบก๊วนนี้? หลังจบจะแก้ไขไม่ได้', { danger: true, okLabel: 'จบก๊วน' }))) return;
    await hostAction('POST', '/end', { confirm: true }, 'จบก๊วนแล้ว ขอบคุณที่มาเล่น!');
  },
  async next(el) {
    await hostAction('POST', `/courts/${el.dataset.court}/next`, {}, 'จัดแมตช์แล้ว');
  },
  async 'start-match'(el) {
    await hostAction('POST', `/matches/${el.dataset.match}/start`, {}, 'เริ่มแมตช์แล้ว');
  },
  async result(el) {
    const m = state.session.matches[el.dataset.match];
    const winners = (el.dataset.winner === 'A' ? m.teamA : m.teamB).map(pname).join(' & ');
    if (!(await confirmDialog('บันทึกผล', `ทีม ${el.dataset.winner} (${winners}) ชนะ?`, { okLabel: 'บันทึกผล' }))) return;
    await hostAction('POST', `/matches/${m.id}/result`, { winner: el.dataset.winner }, (json) =>
      `บันทึกผลแล้ว · ${T.outcome[json.result.outcome] ?? ''}`);
  },
  async 'cancel-match'(el) {
    const m = state.session.matches[el.dataset.match];
    const form = await openDialog({
      title: 'ยกเลิกแมตช์',
      body: `<p>ยกเลิกแมตช์ #${m.no} โดย<strong>ไม่บันทึกผู้ชนะ</strong>? ผู้เล่นจะกลับไปหัวคิว${m.championTeam ? ' แชมป์ยังครองคอร์ทต่อ' : ''}</p>
        <label>เหตุผล (ไม่บังคับ)<input name="reason" maxlength="200"></label>`,
      okLabel: 'ยกเลิกแมตช์',
      danger: true,
    });
    if (!form) return;
    await hostAction('POST', `/matches/${m.id}/cancel`, { confirm: true, reason: form.get('reason') || undefined }, 'ยกเลิกแมตช์แล้ว');
  },
  async substitute(el) {
    const s = state.session;
    const m = s.matches[el.dataset.match];
    const outId = el.dataset.player;
    const inProgress = m.status === 'in_progress';
    const isChampion = m.championTeam && (m.championTeam === 'A' ? m.teamA : m.teamB).includes(outId);
    if (!s.priorityQueue.length) return toast('ไม่มีผู้เล่นในคิวให้เปลี่ยนตัว', 'error');
    const form = await openDialog({
      title: `เปลี่ยนตัว ${pname(outId)}`,
      body: `
        ${inProgress ? '<div class="notice">แมตช์กำลังแข่งอยู่ — การเปลี่ยนตัวระหว่างแข่งต้องยืนยัน</div>' : ''}
        ${isChampion ? '<div class="notice">⚠️ ผู้เล่นคนนี้เป็นแชมป์ การเปลี่ยนตัวจะสิ้นสุดสถิติแชมป์ของคอร์ทนี้</div>' : ''}
        <label>ผู้เล่นที่ลงแทน
          <select name="in">${s.priorityQueue.map((id, i) => `<option value="${id}">${pname(id)}${i === 0 ? ' (คิวแรก)' : ''}</option>`).join('')}</select>
        </label>
        <fieldset class="stack"><legend class="muted">${pname(outId)} จะ…</legend>
          <label class="radio"><input type="radio" name="outStatus" value="waiting" checked> กลับหัวคิว</label>
          <label class="radio"><input type="radio" name="outStatus" value="unavailable"> พักชั่วคราว</label>
          <label class="radio"><input type="radio" name="outStatus" value="left"> กลับบ้าน</label>
        </fieldset>`,
      okLabel: 'ยืนยันเปลี่ยนตัว',
      danger: inProgress || isChampion,
    });
    if (!form) return;
    await hostAction('POST', `/matches/${m.id}/substitute`, {
      outPlayerId: outId,
      inPlayerId: form.get('in'),
      outStatus: form.get('outStatus'),
      confirm: true,
    }, 'เปลี่ยนตัวแล้ว');
  },
  async override(el) {
    const s = state.session;
    const court = s.courts.find((c) => c.id === el.dataset.court);
    const match = court.currentMatchId ? s.matches[court.currentMatchId] : null;
    const options = [];
    if (!match && court.champion) options.push(['release_now', 'ปลดแชมป์ทันที — แชมป์กลับเข้าคิว']);
    if (match?.championTeam) options.push(['release_after_match', 'ปลดแชมป์หลังแมตช์นี้ — แชมป์ไม่อยู่ต่อ (ผู้ท้าชิงชนะยังเป็นแชมป์ได้)']);
    if (match?.mode === 'champion') options.push(['force_rotate_after_match', 'หมุนออกทั้งสองทีมหลังแมตช์นี้ — ไม่มีใครอยู่ต่อ']);
    if (court.pendingOverride) options.push(['cancel_pending', 'ยกเลิกคำสั่งที่รออยู่']);
    if (!options.length) return toast('ไม่มีคำสั่งที่ใช้ได้ในตอนนี้', 'error');
    const form = await openDialog({
      title: `จัดการแชมป์ · ${esc(court.name)}`,
      body: `<p class="muted">การสั่งของผู้จัดไม่นับเป็นแพ้/ชนะ และไม่ลบประวัติแมตช์ที่จบแล้ว</p>
        <fieldset class="stack">${options.map(([v, label], i) => `<label class="radio"><input type="radio" name="action" value="${v}" ${i === 0 ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>`,
      okLabel: 'ยืนยันคำสั่ง',
      danger: true,
    });
    if (!form) return;
    const action = form.get('action');
    await hostAction('POST', `/courts/${court.id}/champion-override`, { action, confirm: true }, `${overrideLabel(action)} · เรียบร้อย`);
  },
  async unavailable(el) {
    const p = state.session.players[el.dataset.player];
    const champ = p.status === 'champion_hold';
    if (champ && !(await confirmDialog('พักผู้เล่น', `${esc(p.name)} เป็นแชมป์อยู่ การพักจะปลดแชมป์และคู่จะกลับเข้าคิว`, { danger: true }))) return;
    await hostAction('POST', `/players/${p.id}/unavailable`, { confirm: champ || undefined }, `${p.name} พักชั่วคราว`);
  },
  async return(el) {
    const p = state.session.players[el.dataset.player];
    await hostAction('POST', `/players/${p.id}/return`, {}, `${p.name} กลับเข้าคิวแล้ว`);
  },
  async remove(el) {
    const p = state.session.players[el.dataset.player];
    const champ = p.status === 'champion_hold';
    const msg = `${esc(p.name)} กลับบ้าน? สถิติจะยังเก็บไว้${champ ? '<br>⚠️ ผู้เล่นเป็นแชมป์อยู่ การออกจะปลดแชมป์' : ''}`;
    if (!(await confirmDialog('ผู้เล่นกลับบ้าน', msg, { danger: true, okLabel: 'ยืนยัน' }))) return;
    await hostAction('DELETE', `/players/${p.id}`, { confirm: true }, `${p.name} กลับบ้านแล้ว`);
  },
  async copy(el) {
    try {
      await navigator.clipboard.writeText(el.dataset.value);
      toast('คัดลอกลิงก์แล้ว');
    } catch {
      toast('คัดลอกไม่สำเร็จ', 'error');
    }
  },
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.dataset.action !== 'copy' && !isHost()) return;
  actions[el.dataset.action](el);
});

$('#create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const playerNames = String(fd.get('players')).split('\n').map((n) => n.trim()).filter(Boolean);
  const btn = ev.target.querySelector('button');
  btn.disabled = true;
  try {
    const json = await request('POST', '/api/sessions', {
      name: fd.get('name'),
      courtCount: Number(fd.get('courtCount')),
      mode: fd.get('mode'),
      playerNames,
    });
    toast('สร้างก๊วนแล้ว');
    location.hash = `#/s/${json.session.id}?k=${json.hostToken}`;
  } catch (err) {
    toast(T.errors[err.code] ?? `สร้างไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#add-player-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = ev.target.elements.name;
  const name = input.value.trim();
  if (!name) return;
  const json = await hostAction('POST', '/players', { name }, `เพิ่ม ${name} เข้าคิวแล้ว`);
  if (json) input.value = '';
});

window.addEventListener('hashchange', route);
route();
