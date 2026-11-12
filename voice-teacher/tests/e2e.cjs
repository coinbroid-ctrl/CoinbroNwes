/* Tes alur suara lengkap di Chromium dengan mesin suara tiruan (browser headless tidak punya
   pengenalan suara asli):  TEACHER_MOCK=1 PORT=8765 python server.py &  node tests/e2e.cjs  */
const { chromium } = require('playwright');
const assert = require('assert');
const URL = process.env.APP_URL || 'http://localhost:8765';
const SHOTS = process.env.SHOTS;

const fakes = () => {
  window.__log = [];
  const synth = {
    speaking: false, cur: null,
    getVoices: () => [], addEventListener() {},
    speak(u) {
      if (!u.text.trim()) return;
      const run = () => {
        synth.speaking = true; synth.cur = u; window.__log.push('tts:' + u.text); u.onstart?.();
        u.timer = setTimeout(() => { synth.speaking = false; synth.cur = null; u.onend?.(); }, window.__ttsMs || 120);
      };
      synth.cur ? (synth.next = run) : run();
    },
    cancel() { if (synth.cur) clearTimeout(synth.cur.timer); synth.speaking = false; synth.cur = null; window.__log.push('tts-cancel'); },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  class FakeSR {
    start() { window.__sr = this; window.__log.push('sr-start:' + this.lang + (synth.speaking ? ':WHILE-SPEAKING' : '')); }
    abort() { if (window.__sr === this) window.__sr = null; }
    stop() { this.abort(); }
  }
  window.SpeechRecognition = FakeSR;
  // Murid "berbicara": hasil sementara lalu hasil final, seperti Web Speech API asli.
  window.__say = (text) => {
    const r = window.__sr;
    if (!r) throw new Error('mikrofon tidak sedang mendengarkan');
    const result = (t, isFinal) => { const a = [{ transcript: t }]; a.isFinal = isFinal; return a; };
    r.onresult({ resultIndex: 0, results: [result(text.split(' ').slice(0, 2).join(' '), false)] });
    r.onresult({ resultIndex: 0, results: [result(text, true)] });
    window.__sr = null; r.onend?.();
  };
};

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e); process.exitCode = 1; });
  await page.addInitScript(fakes);
  await page.goto(URL);
  const state = (s, mode) => page.waitForFunction(([s, mode]) => {
    const a = document.getElementById('app');
    return a.dataset.state === s && (!mode || a.dataset.mode === mode) && window.__sr;
  }, [s, mode], { timeout: 8000 });
  const shot = async (n) => SHOTS && (await page.waitForTimeout(600), page.screenshot({ path: `${SHOTS}/${n}.png` }));

  // Tidak ada antarmuka mengetik sama sekali.
  assert.equal(await page.locator('input, textarea, [contenteditable]').count(), 0, 'tidak boleh ada kolom ketik');
  await shot('1-setup');

  // 1. Guru membuka percakapan sendiri, lalu otomatis mendengarkan.
  await page.click('#start');
  await state('listening', 'talk');
  let text = await page.locator('#transcript').innerText();
  assert.match(text, /What did you do today\?/);
  await shot('2-listening');

  // 2. Murid menjawab salah -> kartu koreksi lengkap -> mode ulangi.
  await page.evaluate(() => window.__say('I go to work yesterday'));
  await state('listening', 'repeat');
  const card = page.locator('.card').first();
  assert.match(await card.locator('.wrong').innerText(), /I go to work yesterday/);
  assert.match(await card.locator('.right').innerText(), /I went to work yesterday/);
  assert.match(await card.locator('.phonetic').innerText(), /Ai went tu werk yesterdei/);
  assert.match(await card.locator('.explain').innerText(), /masa lalu/);
  let log = await page.evaluate(() => window.__log);
  assert(log.includes('tts:I went to work yesterday.'), 'kalimat benar harus diucapkan');
  await shot('3-correction');

  // 3. Pengulangan pertama kurang tepat -> dinilai, diminta ulang; kedua benar -> membaik, lanjut bertanya.
  await page.evaluate(() => window.__say('I want to walk yesterday'));
  await page.waitForSelector('.attempt');
  await state('listening', 'repeat');
  assert.match(await card.locator('.attempts').innerText(), /Percobaan 1\s*60%/);
  // Ekor suara guru yang bocor ke mikrofon tepat setelah ia selesai bicara harus dibuang...
  await page.evaluate(() => window.__say('I went to work yesterday'));
  await page.waitForTimeout(1200);
  assert.equal(await card.locator('.attempt').count(), 1, 'gema tidak boleh dihitung sebagai jawaban');
  // ...sedangkan jawaban murid yang sebenarnya diterima.
  await page.evaluate(() => window.__say('i went to work yesterday'));
  await state('listening', 'talk');
  assert.match(await card.locator('.attempts').innerText(), /Percobaan 2\s*100%\s*▲ membaik 40 poin/);
  text = await page.locator('#transcript').innerText();
  assert.match(text, /What is your hobby\?|What did you eat|Where do you live/);
  await shot('4-improved');

  // 4. Guru tidak pernah mendengarkan suaranya sendiri.
  log = await page.evaluate(() => window.__log);
  assert(!log.some((l) => l.includes('WHILE-SPEAKING')), 'pengenalan suara aktif saat guru berbicara');

  // 5. Murid bisa memotong ucapan guru.
  await page.evaluate(() => { window.__ttsMs = 3000; window.__say('I like football'); });
  await page.waitForFunction(() => document.getElementById('app').dataset.state === 'speaking');
  await shot('5-speaking');
  await page.click('#avatar');
  await state('listening', 'talk');
  log = await page.evaluate(() => window.__log);
  assert.equal(log.at(-2), 'tts-cancel');
  await page.evaluate(() => { window.__ttsMs = 120; window.__say('sorry I have a question'); });
  await page.waitForFunction(() => S.state !== 'listening');
  await state('listening', 'talk');
  const sent = await page.evaluate(() => S.history.filter((m) => m.role === 'user').at(-1).content);
  assert.match(sent, /^\[murid memotong ucapanmu\]/);
  const roles = await page.evaluate(() => S.history.map((m) => m.role[0]).join(''));
  assert.match(roles, /^(ua)+$/, 'riwayat harus bergantian: ' + roles);

  // 6. Akhiri percakapan -> ringkasan koreksi.
  await page.click('#end');
  assert.equal(await page.locator('#summary .card').count(), 1);
  assert.equal(await page.evaluate(() => window.__sr), null);
  await shot('6-summary');

  await browser.close();
  if (!process.exitCode) console.log('E2E OK');
})().catch((e) => { console.error(e); process.exit(1); });
