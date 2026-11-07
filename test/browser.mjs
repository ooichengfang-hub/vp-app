/**
 * UI checks for the observed-liquidation histogram.
 * Serves the app on 127.0.0.1:8792 only. Never 8791.
 * OKX candles and the Binance socket are deterministic fakes.
 * Telegram, Bark, GitHub gists, and order endpoints are blocked.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8792;
if (PORT !== 8792) throw new Error('refusing to listen on a port other than 8792');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ART = '/opt/cursor/artifacts';
const SRC = 'Binance BTCUSDT · 官方快照 · 非完整总量';
const BANNED = /api\.telegram\.org|api\.day\.app|gist\.github\.com|\/api\/v5\/trade|\/fapi\/v1\/order|\/fapi\/v1\/batchOrders|fapi\/v1\/allForceOrders/i;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };

function candles(tf) {
  const sec = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1H': 3600 }[tf] || 300;
  const now = Date.now() / 1000;
  const end = Math.floor(now / sec) * sec;
  const n = tf === '1H' ? 120 : 300;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ts = (end - i * sec) * 1000;
    const px = 100000 + Math.sin(i / 4) * 400 + (i % 5) * 15;
    const o = px, h = px + 80, l = px - 70, c = px + (i % 2 ? 25 : -20);
    rows.push([String(ts), o.toFixed(1), h.toFixed(1), l.toFixed(1), c.toFixed(1), '12', '0.2', String(800000 + (i % 7) * 1000), '1']);
  }
  return rows;
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(404); res.end(String(e.message || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function installFakes() {
  const banned = [];
  window.__banned = banned;
  window.__ws = [];
  const OrigFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input && input.url || input);
    if (BANNED.test(url)) { banned.push(url); throw new Error('blocked ' + url); }
    if (/okx\.com\/api\/v5\/market\/(candles|history-candles|ticker)/.test(url)) {
      const u = new URL(url);
      if (u.pathname.endsWith('/ticker')) {
        return new Response(JSON.stringify({ code: '0', data: [{ last: '100000', open24h: '99000' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.pathname.endsWith('/history-candles')) {
        return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const bar = u.searchParams.get('bar') || '1m';
      return new Response(JSON.stringify({ code: '0', data: candles(bar) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return OrigFetch(input, init);
  };
  class MockSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      window.__ws.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; if (this.onopen) this.onopen({}); } });
    }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
    push(data) { if (this.onmessage) this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  }
  MockSocket.CONNECTING = 0; MockSocket.OPEN = 1; MockSocket.CLOSING = 2; MockSocket.CLOSED = 3;
  window.WebSocket = MockSocket;
}

const baseInit = () => {
  const BANNED = /api\.telegram\.org|api\.day\.app|gist\.github\.com|\/api\/v5\/trade|\/fapi\/v1\/order|\/fapi\/v1\/batchOrders|fapi\/v1\/allForceOrders/i;
  const banned = [];
  window.__banned = banned;
  window.__ws = [];
  const OrigFetch = window.fetch.bind(window);
  function candles(tf) {
    const sec = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1H': 3600 }[tf] || 300;
    const now = Date.now() / 1000;
    const end = Math.floor(now / sec) * sec;
    const n = tf === '1H' ? 120 : 300;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const ts = (end - i * sec) * 1000;
      const px = 100000 + Math.sin(i / 4) * 400 + (i % 5) * 15;
      const o = px, h = px + 80, l = px - 70, c = px + (i % 2 ? 25 : -20);
      rows.push([String(ts), o.toFixed(1), h.toFixed(1), l.toFixed(1), c.toFixed(1), '12', '0.2', String(800000 + (i % 7) * 1000), '1']);
    }
    return rows;
  }
  window.fetch = async (input, init) => {
    const url = String(input && input.url || input);
    if (BANNED.test(url)) { banned.push(url); throw new Error('blocked ' + url); }
    if (/okx\.com\/api\/v5\/market\/(candles|history-candles|ticker)/.test(url)) {
      const u = new URL(url);
      if (u.pathname.endsWith('/ticker')) return new Response(JSON.stringify({ code: '0', data: [{ last: '100000', open24h: '99000' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.pathname.endsWith('/history-candles')) return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ code: '0', data: candles(u.searchParams.get('bar') || '1m') }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return OrigFetch(input, init);
  };
  class MockSocket {
    constructor(url) {
      this.url = String(url); this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      window.__ws.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; if (this.onopen) this.onopen({}); } });
    }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  }
  window.WebSocket = MockSocket;
};

function frame(side, z, ap, q, p, T) {
  return { e: 'forceOrder', E: T, o: { s: 'BTCUSDT', S: side, o: 'LIMIT', f: 'IOC', q: String(q), p: String(p), ap: String(ap), X: 'FILLED', l: String(z), z: String(z), T } };
}

async function waitApp(page) {
  await page.waitForFunction(() => window.__vp && window.__vp.READY && window.__vp.liqReady && window.__vp.WL && window.__vp.WL.bars.length > 20 && window.__vp.WH.bars.length > 20, { timeout: 30000 });
}

async function shot(page, name) {
  await page.screenshot({ path: `${ART}/${name}.png`, fullPage: false });
}

const fails = [];
function check(cond, msg) { if (!cond) fails.push(msg); }

async function main() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(String(err)));
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(baseInit);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitApp(page);

    const seeded = await page.evaluate(() => {
      const vp = window.__vp;
      const last = vp.WL.bars[vp.WL.bars.length - 1];
      const S = 300;
      const tForm = last.ts;
      const t1 = tForm - S;
      const tGap = tForm - 2 * S;
      const tOld = tForm - 3 * S;
      const ms = sec => sec * 1000 + 1500;
      const dup = { e: 'forceOrder', E: ms(t1), o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '1', p: '99000', ap: '100000', X: 'FILLED', l: '0.2', z: '0.2', T: ms(t1) } };
      vp.liqIngest(dup);
      const dupR = vp.liqIngest(dup);
      const buy = vp.liqIngest({ e: 'forceOrder', E: ms(t1) + 800, o: { s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', f: 'IOC', q: '9', p: '10', ap: '100000', X: 'FILLED', l: '0.4', z: '0.4', T: ms(t1) + 800 } });
      const ignored = vp.liqIngest({ e: 'forceOrder', E: ms(tOld), o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '10', p: '100', ap: '100', X: 'FILLED', l: '0', z: '0', T: ms(tOld) } });
      const qp = vp.liqIngest({ e: 'forceOrder', E: ms(tOld), o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '10', p: '100', ap: '200', X: 'FILLED', l: '0.5', z: '0.5', T: ms(tOld) } });
      const bad = vp.liqIngest('{');
      const eth = vp.liqIngest({ e: 'forceOrder', o: { s: 'ETHUSDT', S: 'BUY', z: '1', ap: '1', q: '1', p: '1', T: ms(tOld) } });
      const cont = vp.liqIngest({ e: 'forceOrder', E: ms(tOld) + 1000, o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '10', p: '100', ap: '200', X: 'FILLED', l: '0.5', z: '1.5', T: ms(tOld) + 1000 } });
      const now = Date.now();
      const curT = Math.max(tForm * 1000 + 1, now - 40);
      const cur = vp.liqIngest({ e: 'forceOrder', E: curT, o: { s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', f: 'IOC', q: '0.1', p: '100000', ap: '100000', X: 'FILLED', l: '0.1', z: '0.1', T: curT } });
      const futureT = (tForm + 7200) * 1000;
      vp.liqIngest({ e: 'forceOrder', E: futureT, o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '3', p: '100000', ap: '100000', X: 'FILLED', l: '3', z: '3', T: futureT } });
      const LQ = vp.LQ;
      vp.LIQ.coverClose(LQ, now);
      LQ.spans = [{ a: tOld * 1000, b: tGap * 1000 }, { a: t1 * 1000, b: tForm * 1000 }];
      LQ.open = tForm * 1000;
      LQ.conn = 'open';
      LQ.ver++;
      vp.WH.sig = ''; vp.WL.sig = ''; vp.WH.lgDirty = true; vp.WL.lgDirty = true;
      const hour = Math.floor(t1 / 3600) * 3600;
      const b5 = vp.LIQ.bucket(LQ, t1 * 1000, (t1 + S) * 1000, now);
      const bOld = vp.LIQ.bucket(LQ, tOld * 1000, tGap * 1000, now);
      const bGap = vp.LIQ.bucket(LQ, tGap * 1000, t1 * 1000, now);
      const bNow = vp.LIQ.bucket(LQ, tForm * 1000, (tForm + S) * 1000, now);
      const bH = vp.LIQ.bucket(LQ, hour * 1000, (hour + 3600) * 1000, now);
      const urls = window.__ws.map(s => s.url);
      return {
        dup: dupR && dupR.action, buy: buy && buy.added, ignored: ignored && ignored.reason, qp: qp && qp.added,
        bad: bad && bad.ok, eth: eth && eth.reason, cont: cont && cont.action, contAdd: cont && cont.added,
        cur: cur && cur.added, b5, bOld, bGap, bNow, bH, urls,
        sock: vp.liqSock && vp.liqSock.readyState, events: LQ.events.length, tf: vp.CFG.tf
      };
    });

    check(seeded.tf === '5m', 'default timeframe is 5m, got ' + seeded.tf);
    check(seeded.dup === 'duplicate', 'duplicate snapshot action ' + seeded.dup);
    check(seeded.buy === 40000, 'short notional ' + seeded.buy);
    check(seeded.ignored === 'z', 'zero fill reason ' + seeded.ignored);
    check(seeded.qp === 100, 'z*ap notional ' + seeded.qp);
    check(seeded.bad === false, 'bad json should not apply');
    check(seeded.eth === 'symbol', 'other symbol ' + seeded.eth);
    check(seeded.cont === 'continuation' && seeded.contAdd === 200, 'continuation ' + JSON.stringify(seeded.cont) + ' ' + seeded.contAdd);
    check(seeded.cur === 10000, 'current bucket add ' + seeded.cur);
    check(seeded.b5.long === 20000 && seeded.b5.short === 40000 && seeded.b5.status === 'value', '5m bucket ' + JSON.stringify(seeded.b5));
    check(seeded.bOld.long === 300 && seeded.bOld.short === 0, 'old bucket counts delta only ' + JSON.stringify(seeded.bOld));
    check(seeded.bGap.status === 'gap' && seeded.bGap.n === 0, 'gap bucket ' + JSON.stringify(seeded.bGap));
    check(seeded.bNow.status === 'open' && seeded.bNow.short === 10000 && seeded.bNow.inProgress === true, 'open bucket ' + JSON.stringify(seeded.bNow));
    check(seeded.bH.long >= 20000 && seeded.bH.short >= 40000, '1H bucket ' + JSON.stringify(seeded.bH));
    check(seeded.bH.long < 300000, '1H must hide the future 3 BTC print, got ' + seeded.bH.long);
    check(seeded.urls.includes('wss://fstream.binance.com/market/ws/btcusdt@forceOrder'), 'binance url ' + seeded.urls.join(','));
    check(seeded.sock === 1, 'collector socket open');

    await page.waitForFunction((src) => {
      const t = document.body.innerText;
      return t.includes(src) && t.includes('已连接') && t.includes('记录自') && t.includes('进行中');
    }, { timeout: 8000 }, SRC);
    await new Promise(r => setTimeout(r, 400));
    await shot(page, 'liq-desktop');

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 500));
    const mobile = await page.evaluate((src) => {
      const srcEl = document.querySelector('#liqSrc2');
      const btn = document.querySelector('#liqBtn');
      return {
        src: srcEl && srcEl.innerText.includes(src),
        visible: srcEl && srcEl.getBoundingClientRect().width > 0,
        btn: btn && btn.getBoundingClientRect().width > 0,
        text: document.body.innerText.includes('已连接')
      };
    }, SRC);
    check(mobile.src && mobile.visible && mobile.btn && mobile.text, 'mobile label/toggle ' + JSON.stringify(mobile));
    await shot(page, 'liq-mobile');

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await page.click('#setBtn');
    await page.waitForSelector('#scrim.open');
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.grp-t')].find(e => e.textContent.includes('实际清算量'));
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await new Promise(r => setTimeout(r, 200));
    await shot(page, 'liq-help');
    const help = await page.evaluate(() => document.body.innerText);
    check(help.includes('不需要 API Key'), 'help mentions no API key');
    check(help.includes('不是全市场清算总量'), 'help says not a full total');
    check(help.includes('CoinGlass'), 'help mentions the free stream cannot match CoinGlass history');
    check(help.includes('关掉浏览器'), 'help says closing the browser stops recording');
    check(!/coinglass\.com\/api|open-api\.coinglass/i.test(help), 'help must not point at a CoinGlass API');
    await page.click('#setDone');

    const hidden = await page.evaluate(() => {
      const before = window.__vp.LQ.events.length;
      document.querySelector('#liqBtn').click();
      const off = window.__vp.CFG.liq === false && document.querySelector('#liqSrc1').hidden === true && window.__vp.liqSock.readyState === 1;
      const r = window.__vp.liqIngest({ e: 'forceOrder', E: Date.now(), o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '0.01', p: '100', ap: '100', z: '0.01', l: '0.01', X: 'FILLED', T: Date.now() - 500 } });
      return { off, grew: window.__vp.LQ.events.length > before, added: r && r.added, ready: window.__vp.liqSock.readyState };
    });
    check(hidden.off && hidden.grew && hidden.ready === 1, 'hiding the pane keeps the collector ' + JSON.stringify(hidden));
    await new Promise(r => setTimeout(r, 250));
    await shot(page, 'liq-toggle-off');
    await page.click('#liqBtn');

    await page.evaluate(() => { document.querySelector('#liqBtn').click(); });
    // the click above toggled off again if the previous click turned it on. Normalize to on.
    await page.evaluate(() => { if (!window.__vp.CFG.liq) document.querySelector('#liqBtn').click(); });

    const toggles = await page.evaluate(() => {
      const click = id => document.querySelector(id).click();
      click('#fvgBtn'); click('#smcBtn'); click('#pdhBtn'); click('#lvBtn'); click('#msBtn');
      const cfg = JSON.parse(localStorage.getItem('vp2_cfg'));
      return { fvg: cfg.fvg, smc: cfg.smc, pdh: cfg.pdh, lv: cfg.lv, ms: cfg.ms, liq: cfg.liq, tf: cfg.tf };
    });
    check(toggles.fvg === false && toggles.smc === false && toggles.pdh === false && toggles.lv === false && toggles.ms === false, 'indicator toggles saved ' + JSON.stringify(toggles));
    check(toggles.liq === true && toggles.tf === '5m', 'liq toggle and tf persisted ' + JSON.stringify(toggles));

    const nBefore = await page.evaluate(() => window.__vp.LQ.events.length);
    await page.evaluate(() => { const s = [...window.__ws].reverse().find(x => x.url.includes('forceOrder')); s.close(); });
    const mid = await page.evaluate(() => document.querySelector('#liqSrc1 .st').textContent);
    check(mid.includes('重新连接中'), 'status while reconnecting: ' + mid);
    await page.waitForFunction(() => document.querySelector('#liqSrc1 .st').textContent.includes('已连接'), { timeout: 5000 });
    const afterSock = await page.evaluate(() => window.__ws.filter(s => s.url.includes('forceOrder') && s.readyState === 1).length);
    check(afterSock === 1, 'reconnected sockets ' + afterSock);

    const replay = await page.evaluate(() => {
      const vp = window.__vp;
      const future = vp.LQ.events.filter(e => e.usd >= 300000);
      const view = vp.WL.bars[vp.WL.bars.length - 1].ts - 900;
      vp.RP.on = true; vp.RP.t = view;
      const hour = Math.floor(view / 3600) * 3600;
      const b = vp.LIQ.bucket(vp.LQ, hour * 1000, (hour + 3600) * 1000, view * 1000);
      vp.WL.hov = vp.WL.bars.length - 1; vp.WL.lgDirty = true; vp.WL.sig = '';
      return { future: future.length, long: b.long, hasFuture: b.long >= 300000 };
    });
    check(replay.future === 1 && replay.hasFuture === false, 'replay hides future observations ' + JSON.stringify(replay));
    await page.evaluate(() => { window.__vp.RP.on = false; window.__vp.WL.sig = ''; window.__vp.WH.sig = ''; });

    await page.evaluate(() => window.__vp.liqSave());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp(page);
    const kept = await page.evaluate(() => ({ n: window.__vp.LQ.events.length, sum: window.__vp.LQ.events.reduce((a, e) => a + e.usd, 0), cfg: JSON.parse(localStorage.getItem('vp2_cfg')).liq }));
    check(kept.n >= nBefore && kept.sum > 60000 && kept.cfg === true, 'persisted observations ' + JSON.stringify(kept));

    const banned = await page.evaluate(() => window.__banned.slice());
    check(banned.length === 0, 'banned requests ' + banned.join(','));
    check(errors.length === 0, 'page errors ' + errors.join('\n'));

    const layout = await browser.newPage();
    const layoutErrors = [];
    layout.on('pageerror', err => layoutErrors.push(String(err)));
    await layout.setViewport({ width: 1280, height: 800 });
    await layout.evaluateOnNewDocument(baseInit);
    await layout.evaluateOnNewDocument(() => {
      localStorage.setItem('vp2_cfg', JSON.stringify({ tf: '15m', vp: true, fvg: false, smc: true, pdh: true, lv: false, ms: true, liq: true, max: 'ltf', rows: 24, va: 70, vaLines: true, ma: true, maN: 20, sync: true, cd: true, vt: true, vtSpark: false, vtThr: 15, msN: 3, msLine: true, smcBos: true, smcFvg: true, smcSet: true, smcMid: false, fvgMin: 0.05, slBuf: 0.05, tp1: 1.5, tp2: 2, smcExp: 24, smcFont: 14 }));
    });
    await layout.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await waitApp(layout);
    const lay = await layout.evaluate(() => ({
      tf: document.querySelector('#w2t').textContent,
      max: document.body.classList.contains('mx-ltf'),
      fvg: document.querySelector('#fvgBtn').classList.contains('on'),
      liq: document.querySelector('#liqBtn').getAttribute('aria-pressed'),
      w1: document.querySelector('#w1').style.display || getComputedStyle(document.querySelector('#w1')).display
    }));
    check(lay.tf === '15 分钟' && lay.max && lay.fvg === false && lay.liq === 'true' && lay.w1 === 'none', 'saved layout ' + JSON.stringify(lay));
    check(layoutErrors.length === 0, 'layout page errors ' + layoutErrors.join('\n'));
    await shot(layout, 'liq-saved-layout');
    await layout.close();
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
  if (fails.length) {
    console.error(fails.map(f => 'FAIL ' + f).join('\n'));
    process.exit(1);
  }
  console.log('browser checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
