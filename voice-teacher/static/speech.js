/* Lapisan suara: text-to-speech (Speaker), pengenalan suara (Listener), level mikrofon (Mic),
   dan penilaian pengulangan (compare). Tidak tahu apa-apa soal UI. */
'use strict';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// Di ponsel, pengenalan suara dan getUserMedia tidak bisa memakai mikrofon bersamaan,
// jadi stream mikrofon dilepas dulu setiap kali mulai mendengarkan.
const EXCLUSIVE_MIC = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const toWords = (s) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Bandingkan kalimat target dengan yang terdengar (urutan kata, LCS). */
function compare(target, heard) {
  const tokens = target.split(/\s+/).filter((t) => toWords(t).length);
  const a = tokens.map((t) => toWords(t).join(''));
  const b = toWords(heard).map((w) => w.replace(/'/g, ''));
  const a2 = a.map((w) => w.replace(/'/g, ''));
  const dp = Array.from({ length: a2.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a2.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a2[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const marks = [];
  let i = 0, j = 0;
  while (i < a2.length) {
    if (j < b.length && a2[i] === b[j]) { marks.push({ word: tokens[i], ok: true }); i++; j++; }
    else if (j < b.length && dp[i][j + 1] >= dp[i + 1][j]) j++;
    else { marks.push({ word: tokens[i], ok: false }); i++; }
  }
  const hit = marks.filter((m) => m.ok).length;
  return {
    score: a2.length ? Math.round((hit / a2.length) * 100) : 0,
    marks,
    missed: marks.filter((m) => !m.ok).map((m) => toWords(m.word).join('')),
  };
}

class Speaker {
  constructor() {
    this.queue = [];
    this.busy = false;
    this.gen = 0;
    this.rates = { en: 1, id: 1 };
    this.onidle = null;
    this.speakingNow = false; // benar-benar sedang mengeluarkan suara
    this.voices = [];
    const load = () => { this.voices = speechSynthesis.getVoices(); };
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  /** Harus dipanggil dari ketukan pengguna supaya iOS/Android mengizinkan suara. */
  unlock() {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  voiceFor(lang) {
    const list = this.voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang));
    const pref = lang === 'en' ? list.filter((v) => /en-US/i.test(v.lang.replace('_', '-'))) : list;
    const pool = pref.length ? pref : list;
    return pool.find((v) => /natural|google|samantha|enhanced|premium/i.test(v.name)) || pool[0] || null;
  }

  /** item: {lang, text, onstart, onprogress(chars), onend(cut)} atau {run} untuk langkah visual berurutan. */
  enqueue(item) {
    this.queue.push(item);
    if (!this.busy) this._next();
  }

  _next() {
    const item = this.queue.shift();
    if (!item) {
      this.busy = false;
      this.onidle?.();
      return;
    }
    this.busy = true;
    if (item.run) { item.run(); return this._next(); }

    const gen = this.gen;
    const u = new SpeechSynthesisUtterance(item.text);
    const voice = this.voiceFor(item.lang);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || (item.lang === 'id' ? 'id-ID' : 'en-US');
    u.rate = this.rates[item.lang] || 1;

    const est = (item.text.length * 68) / u.rate + 300; // perkiraan durasi (ms)
    let started = 0, exact = false, ticker = 0, watchdog = 0, finished = false;
    const begin = () => {
      if (started || gen !== this.gen) return;
      started = performance.now();
      this.speakingNow = true;
      item.onstart?.();
      // Transkrip muncul seiring ucapan: pakai event boundary bila ada, kalau tidak pakai perkiraan waktu.
      ticker = setInterval(() => {
        if (!exact) item.onprogress?.(Math.floor(((performance.now() - started) / est) * item.text.length));
      }, 70);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      clearTimeout(watchdog);
      this.speakingNow = false;
      this.current = null;
      if (gen !== this.gen) return; // dibatalkan: cancel() sudah mengurus sisanya
      begin();
      clearInterval(ticker);
      item.onprogress?.(item.text.length);
      item.onend?.(false);
      this._next();
    };
    u.onstart = begin;
    u.onboundary = (e) => {
      if (e.name && e.name !== 'word') return;
      exact = true;
      const rest = item.text.slice(e.charIndex);
      item.onprogress?.(e.charIndex + (rest.match(/^\S+/)?.[0].length || 0));
    };
    u.onend = finish;
    u.onerror = finish;
    // Beberapa browser tidak pernah mengirim onend; jangan sampai percakapan macet.
    watchdog = setTimeout(finish, est * 2.5 + 4000);
    this.current = { item, stop: () => { finished = true; clearInterval(ticker); clearTimeout(watchdog); } };
    speechSynthesis.speak(u);
  }

  /** Hentikan ucapan seketika (dipakai saat murid memotong atau panggilan diakhiri). */
  cancel() {
    this.gen++;
    this.queue = [];
    const cur = this.current;
    this.current = null;
    cur?.stop();
    this.busy = false;
    this.speakingNow = false;
    speechSynthesis.cancel();
    cur?.item.onend?.(true);
  }
}

class Listener {
  constructor() {
    this.active = false;
    this.onInterim = null;  // (teks sementara)
    this.onFinal = null;    // (teks, alternatif[])
    this.onError = null;    // (jenis)
    this.heardAt = 0;       // kapan terakhir ada aktivitas suara (untuk animasi)
  }

  start({ lang, grace }) {
    this.stop();
    Object.assign(this, { active: true, lang, grace, parts: [], alts: [], errors: 0 });
    this._spawn();
  }

  _spawn() {
    const r = new SR();
    r.lang = this.lang;
    r.interimResults = true;
    r.maxAlternatives = 3;
    r.continuous = false;
    let gotFinal = false, interim = '', lastError = '';
    r.onresult = (e) => {
      if (r !== this.rec || !this.active) return;
      this.errors = 0;
      this.heardAt = performance.now();
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          gotFinal = true;
          this.parts.push(res[0].transcript.trim());
          this.alts.push(Array.from(res, (a) => a.transcript.trim()));
        } else interim += res[0].transcript;
      }
      clearTimeout(this.timer);
      this.onInterim?.([...this.parts, interim].join(' ').trim());
      if (gotFinal && !interim.trim()) this._arm();
    };
    r.onspeechstart = () => { this.heardAt = performance.now(); };
    r.onerror = (e) => {
      lastError = e.error;
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        this.stop();
        this.onError?.(e.error);
      }
    };
    r.onend = () => {
      if (r !== this.rec || !this.active) return;
      if (!gotFinal && interim.trim()) { this.parts.push(interim.trim()); this._arm(); }
      if (lastError === 'network' && ++this.errors >= 3) { this.stop(); return this.onError?.('network'); }
      // Tetap mendengarkan: belum ada jawaban, atau murid mungkin melanjutkan kalimatnya.
      this.restart = setTimeout(() => this.active && this._spawn(), lastError === 'network' ? 1000 : 120);
    };
    this.rec = r;
    try { r.start(); } catch { /* sudah berjalan */ }
  }

  /** Setelah satu potong kalimat selesai, tunggu sebentar: pemula sering berhenti di tengah kalimat. */
  _arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const text = this.parts.join(' ').trim();
      const alts = this.alts.length === 1 ? this.alts[0] : [text];
      this.stop();
      if (text) this.onFinal?.(text, alts);
    }, this.grace);
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.restart);
    const r = this.rec;
    this.rec = null;
    if (r) { try { r.abort(); } catch { /* abaikan */ } }
  }
}

/** Stream mikrofon mentah: untuk gelombang suara dan mendeteksi murid yang memotong ucapan guru. */
class Mic {
  get isOpen() { return !!this.stream; }

  async open() {
    if (this.stream || this.opening) return this.opening;
    this.opening = navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((stream) => {
        this.stream = stream;
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        this.ctx.resume?.();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.source = this.ctx.createMediaStreamSource(stream);
        this.source.connect(this.analyser);
        this.time = new Uint8Array(this.analyser.fftSize);
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.stream = this.source = null;
  }

  rms() {
    if (!this.stream) return 0;
    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (const v of this.time) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / this.time.length);
  }

  bars(n) {
    if (!this.stream) return null;
    this.analyser.getByteFrequencyData(this.freq);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.freq[2 + Math.floor((i / n) * 60)] / 255;
    return out;
  }
}
