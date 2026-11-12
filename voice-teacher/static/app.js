/* Alur percakapan: mendengarkan -> memproses -> guru berbicara -> mendengarkan lagi. */
'use strict';

const $ = (id) => document.getElementById(id);
const app = $('app');
const speaker = new Speaker();
const listener = new Listener();
const mic = new Mic();

const LEVEL_NAMES = { beginner: 'Pemula', intermediate: 'Menengah', advanced: 'Mahir' };
const RATES = { beginner: { en: 0.8, id: 0.95 }, intermediate: { en: 0.92, id: 1 }, advanced: { en: 1, id: 1.05 } };
const STATUS = {
  listening: 'Mendengarkan… silakan bicara',
  repeat: 'Giliranmu: ulangi kalimatnya',
  processing: 'Memproses jawabanmu…',
  speaking: 'Miss Ava berbicara',
};

const S = {
  level: 'beginner', topic: '', answerLang: 'en',
  state: 'idle', history: [], turn: null, repeat: null, interrupted: false,
  corrections: [], lastCard: null, lastSpoken: '', speakEndAt: 0, startedAt: 0, interimLine: null,
};

/* ---------- tampilan ---------- */
function setState(state, mode = '') {
  S.state = state;
  S.stateAt = performance.now();
  app.dataset.state = state;
  app.dataset.mode = mode;
  $('status-text').textContent = STATUS[mode === 'repeat' ? 'repeat' : state] || '';
  accent = getComputedStyle(app).getPropertyValue('--accent').trim() || '#9b8cff';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function append(node) {
  const box = $('transcript');
  box.append(node);
  box.scrollTop = box.scrollHeight;
  return node;
}

function addLine(kind, who, text) {
  const line = el('div', `line ${kind}`);
  if (who) line.append(el('span', 'who', who));
  line.append(el('p', '', text));
  return append(line);
}

function addAiLine(text, lang) {
  const line = addLine('ai', lang === 'id' ? 'Miss Ava · Indonesia' : 'Miss Ava', '');
  line.dataset.lang = lang;
  const spoken = el('span', 'spoken'), pending = el('span', 'pending', text);
  line.lastChild.append(spoken, pending);
  return {
    progress(n) { spoken.textContent = text.slice(0, n); pending.textContent = text.slice(n); },
    cut() { pending.textContent = pending.textContent ? ' —' : ''; },
  };
}

function row(cls, label, text) {
  const r = el('div', `row ${cls}`);
  r.append(el('span', 'label', label), el('p', '', text));
  return r;
}

function buildCard(c) {
  const card = el('article', 'card');
  card.append(el('h3', '', 'Koreksi'));
  if (c.wrong) card.append(row('wrong', 'Kalimatmu', c.wrong));
  card.append(row('right', 'Yang benar', c.right));
  if (c.phonetic) card.append(row('phonetic', 'Cara baca', c.phonetic));
  if (c.explain) card.append(row('explain', 'Penjelasan', c.explain));
  const attempts = el('div', 'row attempts');
  card.append(attempts);
  return card;
}

function showAttempt(rep, result, heard) {
  const prev = rep.attempts.at(-2);
  let box = rep.card?.querySelector('.attempts');
  if (!box) { // pengulangan tanpa kartu koreksi (jarang): buat kartu ringkas
    rep.card = append(buildCard({ right: rep.target }));
    box = rep.card.querySelector('.attempts');
  }
  if (!box.children.length) box.append(el('span', 'label', 'Latihan mengucapkan'));
  const a = el('div', 'attempt');
  a.append(el('span', '', `Percobaan ${rep.attempts.length}`),
    el('span', `score ${result.score >= 80 ? 'ok' : 'low'}`, `${result.score}%`));
  if (prev != null && result.score > prev) a.append(el('span', 'delta', `▲ membaik ${result.score - prev} poin`));
  const words = el('span', 'words');
  result.marks.forEach((m) => words.append(el('span', m.ok ? 'w-ok' : 'w-miss', m.word), ' '));
  a.append(words);
  box.append(a);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

/* ---------- giliran guru ---------- */
async function* readEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith('data: ')) yield JSON.parse(chunk.slice(6));
    }
  }
}

async function teacherTurn(content) {
  listener.stop();
  S.history.push({ role: 'user', content });
  setState('processing');
  if (EXCLUSIVE_MIC) mic.open().catch(() => {}); // siap mendeteksi murid yang memotong
  const turn = (S.turn = { raw: '', spoken: '', ctrl: new AbortController() });
  try {
    const res = await fetch('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: S.level, topic: S.topic, messages: S.history }),
      signal: turn.ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for await (const ev of readEvents(res)) {
      if (turn.aborted) return;
      onTeacherEvent(ev, turn);
    }
    if (!turn.done && !turn.aborted) onTeacherEvent({ type: 'error', message: 'Koneksi terputus.' }, turn);
  } catch (e) {
    if (!turn.aborted) onTeacherEvent({ type: 'error', message: 'Koneksi ke server terputus.' }, turn);
  }
}

function onTeacherEvent(ev, turn) {
  if (ev.type === 'say') {
    turn.raw += ev.raw;
    let line;
    speaker.enqueue({
      lang: ev.lang, text: ev.text,
      onstart: () => {
        if (S.state !== 'speaking') setState('speaking');
        line = addAiLine(ev.text, ev.lang);
        turn.spoken = ev.text; // ucapan terakhir: satu-satunya yang ekornya bisa bocor ke mikrofon
      },
      onprogress: (n) => line?.progress(n),
      onend: (cut) => cut && line?.cut(),
    });
  } else if (ev.type === 'correction') {
    turn.raw += ev.raw;
    speaker.enqueue({ run: () => {
      turn.card = S.lastCard = append(buildCard(ev));
      S.corrections.push(ev);
    } });
  } else if (ev.type === 'repeat') {
    turn.raw += ev.raw;
    turn.repeat = ev.text;
  } else if (ev.type === 'done' || ev.type === 'error') {
    if (ev.type === 'error' || !turn.raw) {
      // Giliran gagal: buang giliran murid dari riwayat supaya bisa dicoba lagi, lalu dengarkan kembali.
      S.history.pop();
      turn.failed = true;
      addLine('note', '', ev.message || 'Maaf, ada gangguan.');
      speaker.enqueue({ lang: 'id', text: 'Maaf, ada gangguan. Coba ucapkan sekali lagi ya.' });
    } else {
      S.history.push({ role: 'assistant', content: turn.raw });
    }
    turn.done = true;
    if (!speaker.busy) afterSpeaking(turn);
  }
}

speaker.onidle = () => {
  const t = S.turn;
  if (t && t.done && !t.aborted) afterSpeaking(t);
};

function applyRepeat(turn) {
  if (turn.failed) return;
  if (!turn.repeat) S.repeat = null;
  else if (turn.card || !S.repeat) S.repeat = { target: turn.repeat, card: turn.card, attempts: [] };
  else S.repeat.target = turn.repeat; // percobaan berikutnya untuk kartu yang sama
}

function afterSpeaking(turn) {
  if (turn.finished || S.state === 'ended') return;
  turn.finished = true;
  S.lastSpoken = turn.spoken;
  S.speakEndAt = performance.now();
  applyRepeat(turn);
  // Jeda singkat supaya ekor suara guru tidak ikut terekam sebagai ucapan murid.
  setTimeout(startListening, 250);
}

/* ---------- giliran murid ---------- */
function startListening() {
  if (S.state === 'ended') return;
  if (EXCLUSIVE_MIC) mic.close();
  S.interimLine = null;
  S.heardStartAt = 0;
  setState('listening', S.repeat ? 'repeat' : 'talk');
  listener.start({
    lang: !S.repeat && S.answerLang === 'id' ? 'id-ID' : 'en-US',
    grace: S.repeat ? 700 : S.level === 'beginner' ? 1300 : 900,
  });
}

listener.onInterim = (text) => {
  if (!text || S.state !== 'listening') return;
  S.heardStartAt = S.heardStartAt || performance.now();
  if (!S.interimLine) S.interimLine = addLine('user interim', 'Kamu', '');
  S.interimLine.lastChild.textContent = text;
  $('transcript').scrollTop = $('transcript').scrollHeight;
};

listener.onFinal = (text, alts) => {
  if (S.state !== 'listening') return;
  // Pengaman gema: suara yang mulai terdengar sesaat setelah guru selesai dan isinya sama dengan
  // kalimat terakhir guru adalah ekor suara guru sendiri, bukan jawaban murid.
  if (S.heardStartAt - S.speakEndAt < 700 && compare(text, S.lastSpoken).score >= 70) {
    S.interimLine?.remove();
    return startListening();
  }
  const line = S.interimLine || addLine('user', 'Kamu', '');
  line.classList.remove('interim');
  S.interimLine = null;

  let content;
  if (S.repeat) {
    const rep = S.repeat;
    let best = null, heard = text;
    for (const alt of alts) {
      const r = compare(rep.target, alt);
      if (!best || r.score > best.score) { best = r; heard = alt; }
    }
    line.lastChild.textContent = heard;
    const prev = rep.attempts.at(-1);
    rep.attempts.push(best.score);
    showAttempt(rep, best, heard);
    content = `[PENGULANGAN] target: "${rep.target}" | terdengar: "${heard}" | skor: ${best.score}`
      + (prev != null ? ` | skor sebelumnya: ${prev}` : '')
      + ` | percobaan: ${rep.attempts.length}`
      + (best.missed.length ? ` | kata belum tepat: ${best.missed.join(', ')}` : '');
  } else {
    line.lastChild.textContent = text;
    content = (S.answerLang === 'id' ? '[bahasa Indonesia] ' : '') + text;
    if (S.interrupted) content = '[murid memotong ucapanmu] ' + content;
  }
  S.interrupted = false;
  teacherTurn(content);
};

listener.onError = (kind) => {
  const msg = kind === 'network'
    ? 'Pengenalan suara butuh koneksi internet. Periksa koneksimu, lalu mulai lagi.'
    : 'Mikrofon tidak bisa diakses. Izinkan mikrofon untuk situs ini di pengaturan browser.';
  addLine('note', '', msg);
  $('status-text').textContent = 'Mikrofon tidak aktif';
};

/** Murid memotong ucapan guru (bicara, atau mengetuk wajah guru). */
function bargeIn() {
  const turn = S.turn;
  if (S.state !== 'speaking' || !turn || turn.finished) return;
  turn.aborted = turn.finished = true;
  turn.ctrl.abort();
  speaker.cancel();
  if (!turn.done && !turn.failed) S.history.push({ role: 'assistant', content: turn.raw });
  S.interrupted = true;
  S.lastSpoken = turn.spoken;
  S.speakEndAt = performance.now();
  applyRepeat(turn);
  setTimeout(startListening, 150);
}

/* ---------- gelombang suara + deteksi memotong ---------- */
const canvas = $('wave');
const g = canvas.getContext('2d');
const BARS = 56;
const smooth = new Array(BARS).fill(0);
let accent = '#9b8cff', noise = 0.01, hot = 0, lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;
  if (app.dataset.screen !== 'call') return;

  const level = mic.rms();
  if (S.state === 'speaking' && mic.isOpen) {
    // Ambang menyesuaikan sisa gema suara guru; murid harus terdengar jelas di atasnya selama ~1/4 detik.
    const threshold = Math.max(0.05, noise * 3.5);
    if (level > threshold) hot += dt;
    else { hot = Math.max(0, hot - dt * 2); noise += (level - noise) * 0.02; }
    if (hot > 260 && now - S.stateAt > 400) { hot = 0; bargeIn(); }
  } else hot = 0;

  const real = S.state === 'listening' ? mic.bars(BARS) : null;
  const t = now / 1000;
  let mouth = 0;
  for (let i = 0; i < BARS; i++) {
    let v;
    if (real) v = real[i];
    else if (S.state === 'listening') { // ponsel: mikrofon dipegang pengenal suara, animasi mengikuti aktivitasnya
      const active = now - listener.heardAt < 500;
      v = (active ? 0.55 : 0.1) * (0.5 + 0.5 * Math.sin(t * (active ? 9 : 2) + i * 0.9));
    } else if (S.state === 'speaking' && speaker.speakingNow) {
      v = 0.25 + 0.3 * Math.abs(Math.sin(t * 7 + i * 0.45) * Math.sin(t * 3.1 + i * 1.3));
    } else if (S.state === 'processing') v = 0.1 + 0.14 * (0.5 + 0.5 * Math.sin(t * 5 - i * 0.35));
    else v = 0.04;
    smooth[i] += (v - smooth[i]) * 0.3;
    mouth += smooth[i];
  }
  const W = canvas.width, c = W / 2, r0 = W * 0.31;
  g.clearRect(0, 0, W, W);
  g.strokeStyle = accent;
  g.lineWidth = 7;
  g.lineCap = 'round';
  for (let i = 0; i < BARS; i++) {
    const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
    const len = 4 + smooth[i] * W * 0.16;
    g.globalAlpha = 0.35 + smooth[i] * 0.65;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    g.lineTo(c + Math.cos(a) * (r0 + len), c + Math.sin(a) * (r0 + len));
    g.stroke();
  }
  $('mouth').style.height = (S.state === 'speaking' ? 5 + (mouth / BARS) * 34 : 5) + 'px';
}
requestAnimationFrame(frame);

/* ---------- mulai / akhiri ---------- */
function pick(groupId, attr, key) {
  $(groupId).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...$(groupId).children].forEach((b) => b.setAttribute('aria-pressed', b === btn));
    S[key] = btn.dataset[attr];
  });
}
pick('levels', 'level', 'level');
pick('topics', 'topic', 'topic');

function notice(text) {
  $('support-notice').textContent = text;
  $('support-notice').hidden = false;
}
if (!SR || !window.speechSynthesis || !navigator.mediaDevices) {
  notice(window.isSecureContext
    ? 'Browser ini belum mendukung percakapan suara. Buka dengan Google Chrome (Android / komputer) atau Safari terbaru.'
    : 'Mikrofon hanya bisa dipakai lewat HTTPS atau localhost. Buka aplikasi ini melalui alamat https://.');
  $('start').disabled = true;
}

let timerId = 0;
async function start() {
  speaker.unlock();
  try { await mic.open(); } catch {
    return notice('Mikrofon tidak diizinkan. Izinkan akses mikrofon untuk situs ini, lalu coba lagi.');
  }
  Object.assign(S, { history: [], corrections: [], repeat: null, turn: null, interrupted: false, startedAt: Date.now() });
  speaker.rates = RATES[S.level];
  $('transcript').replaceChildren();
  $('level-label').textContent = LEVEL_NAMES[S.level];
  app.dataset.screen = 'call';
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - S.startedAt) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  teacherTurn('[MULAI SESI]'); // guru yang membuka percakapan
}

function end() {
  clearInterval(timerId);
  if (S.turn) { S.turn.aborted = true; S.turn.ctrl.abort(); }
  setState('ended');
  speaker.cancel();
  listener.stop();
  mic.close();
  const mins = Math.max(1, Math.round((Date.now() - S.startedAt) / 60000));
  const answers = S.history.filter((m) => m.role === 'user').length - 1;
  $('summary-lead').textContent = S.corrections.length
    ? `Kamu berlatih sekitar ${mins} menit dan berbicara ${Math.max(answers, 0)} kali. Ini kalimat yang kita perbaiki hari ini:`
    : `Kamu berlatih sekitar ${mins} menit dan berbicara ${Math.max(answers, 0)} kali. Belum ada koreksi — kerja bagus!`;
  $('summary-cards').replaceChildren(...S.corrections.map(buildCard));
  app.dataset.screen = 'summary';
}

$('start').addEventListener('click', start);
$('end').addEventListener('click', end);
$('again').addEventListener('click', () => { app.dataset.screen = 'setup'; setState('idle'); });
$('avatar').addEventListener('click', bargeIn);
$('lang-toggle').addEventListener('click', () => {
  S.answerLang = S.answerLang === 'en' ? 'id' : 'en';
  $('lang-name').textContent = S.answerLang === 'en' ? 'English' : 'Indonesia';
  $('lang-toggle').setAttribute('aria-pressed', S.answerLang === 'id');
  if (S.state === 'listening' && !S.repeat) startListening();
});
