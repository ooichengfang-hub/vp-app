/**
 * 阿图行情的浏览器检查。只监听 127.0.0.1:8792。
 * 自动化用例拦截公开接口并返回夹具；夹具不在页面源码里。
 * 另有一次不拦截的实网检查：失败就记录，不改道。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const PORT = 8792;
if (PORT !== 8792) throw new Error('refusing to listen on a port other than 8792');
const ROOT = normalize(fileURLToPath(new URL('..', import.meta.url))).replace(/[\\/]$/, '');
const ART = '/opt/cursor/artifacts';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png'
};
const BANNED = /api\.telegram\.org|api\.day\.app|gist\.github\.com|\/fapi\/v1\/order|\/fapi\/v1\/batchOrders|allForceOrders|coinglass\.com/i;

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const full = normalize(join(ROOT, path));
      if (full !== ROOT && !full.startsWith(ROOT + sep)) {
        res.writeHead(403); res.end('no'); return;
      }
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
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

function installFixture() {
  const banned = /api\.telegram\.org|api\.day\.app|gist\.github\.com|\/fapi\/v1\/order|\/fapi\/v1\/batchOrders|allForceOrders|coinglass\.com/i;
  window.__banned = [];
  window.__urls = [];
  window.__unexpected = [];
  window.__sockets = [];
  const secOf = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  function klines(interval) {
    const sec = secOf[interval] || 3600;
    const end = Math.floor(Date.now() / 1000 / sec) * sec;
    const n = 120;
    const rows = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = n - 1 - i;
      const openMs = (end - i * sec) * 1000;
      const base = 75000 + Math.sin(k / 6) * 800;
      const o = base;
      const c = base + ((k % 3) - 1) * 40;
      const h = Math.max(o, c) + 25;
      const l = Math.min(o, c) - 30;
      const quote = 1000000 + (k % 10) * 50000;
      const taker = quote * (0.35 + (k % 5) * 0.08);
      rows.push([
        openMs, o.toFixed(2), h.toFixed(2), l.toFixed(2), c.toFixed(2),
        (quote / o).toFixed(6), openMs + sec * 1000 - 1, quote.toFixed(2),
        100 + k, (taker / o).toFixed(6), taker.toFixed(2), '0'
      ]);
    }
    return rows;
  }
  function json(data, status) {
    return new Response(JSON.stringify(data), { status: status || 200, headers: { 'content-type': 'application/json' } });
  }
  window.fetch = async (input) => {
    const url = String(input && input.url || input);
    window.__urls.push(url);
    if (banned.test(url)) {
      window.__banned.push(url);
      throw new Error('blocked ' + url);
    }
    const u = new URL(url, location.href);
    const failHist = location.search.includes('history=fail');
    const failTick = location.search.includes('ticker=fail');
    if (u.pathname.endsWith('/fapi/v1/klines')) {
      if (location.search.includes('history=throw')) throw new TypeError('Failed to fetch');
      if (failHist) {
        return json({ code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility'" }, 451);
      }
      return json(klines(u.searchParams.get('interval') || '1h'));
    }
    if (u.pathname.endsWith('/fapi/v1/ticker/24hr')) {
      if (failTick) return json({ code: 0, msg: 'ticker unavailable in this test' }, 451);
      const rows = [
        ['BTCUSDT', 75860.8, -0.03],
        ['ETHUSDT', 2540.2, 1.2],
        ['SOLUSDT', 148.3, -1.57],
        ['BNBUSDT', 612.4, 0.4],
        ['XRPUSDT', 0.5421, 0.76],
        ['DOGEUSDT', 0.1622, -0.4]
      ].map(([symbol, last, pct]) => ({
        symbol, lastPrice: String(last), priceChangePercent: String(pct),
        quoteVolume: '1000000', highPrice: String(last * 1.01), lowPrice: String(last * 0.99),
        openPrice: String(last), closeTime: Date.now()
      }));
      return json(rows);
    }
    if (u.pathname.endsWith('/fapi/v1/premiumIndex')) {
      const symbol = u.searchParams.get('symbol') || 'BTCUSDT';
      return json({ symbol, markPrice: '75850', indexPrice: '75840', lastFundingRate: '0.00012', nextFundingTime: Date.now() + 3600e3 });
    }
    if (u.pathname.endsWith('/fapi/v1/openInterest')) {
      const symbol = u.searchParams.get('symbol') || 'BTCUSDT';
      return json({ symbol, openInterest: '84521.5', time: Date.now() });
    }
    if (/binance\.com/i.test(url)) {
      window.__unexpected.push(url);
      throw new Error('unexpected ' + url);
    }
    throw new Error('unmocked ' + url);
  };
  class MockSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      window.__sockets.push(this);
      setTimeout(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        if (this.onopen) this.onopen({ type: 'open' });
      }, 20);
    }
    send() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({ type: 'close', code: 1000 });
    }
  }
  window.WebSocket = MockSocket;
}

function track(page, bag) {
  page.on('pageerror', err => bag.page.push(String(err)));
  page.on('console', msg => {
    if (msg.type() === 'error') bag.console.push(msg.text());
  });
}
function scriptErrors(bag) {
  const noise = /Failed to load resource|net::ERR_|status of 451|favicon|CORS policy|Access to fetch/i;
  return bag.page.concat(bag.console.filter(t => !noise.test(t)));
}

async function probeLive() {
  const restUrl = 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=1';
  let rest;
  try {
    const res = await fetch(restUrl);
    const text = await res.text();
    rest = { status: res.status, body: text.slice(0, 240) };
  } catch (e) {
    rest = { error: String(e) };
  }
  const ws = await new Promise(resolve => {
    let done = false;
    const finish = row => { if (!done) { done = true; resolve(row); } };
    let socket;
    try { socket = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@kline_1h'); }
    catch (e) { finish({ ok: false, error: String(e) }); return; }
    const timer = setTimeout(() => { try { socket.close(); } catch (e) {} finish({ ok: false, error: 'timeout' }); }, 8000);
    socket.addEventListener('message', ev => {
      clearTimeout(timer);
      try {
        const m = JSON.parse(ev.data);
        finish({ ok: true, close: m.k && m.k.c, interval: m.k && m.k.i });
      } catch (e) { finish({ ok: false, error: 'json' }); }
      try { socket.close(); } catch (err) {}
    });
    socket.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, error: 'error-event' }); });
  });
  const report = { rest, ws, note: 'primary fapi host and /market websocket only; no alternate host' };
  console.log('REACHABILITY ' + JSON.stringify(report));
  return report;
}

async function shot(page, name, fullPage) {
  await mkdir(ART, { recursive: true });
  await page.screenshot({ path: `${ART}/${name}.png`, fullPage: !!fullPage });
}

const fails = [];
function check(cond, msg) { if (!cond) fails.push(msg); }

async function main() {
  const server = await startServer();
  const reach = await probeLive();
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
  });
  try {
    const live = await browser.newPage();
    const liveBag = { page: [], console: [] };
    track(live, liveBag);
    await live.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await live.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await live.waitForFunction(() => window.__atu && window.__atu.ready, { timeout: 15000 });
    await live.waitForFunction(() => {
      const st = window.__atu.getStatus();
      return st.histBad || window.__atu.getBars().length >= 20;
    }, { timeout: 20000 });
    if ((await live.evaluate(() => window.__atu.getStatus().histBad))) {
      await live.waitForFunction(() => window.__atu.getBars().length >= 1 || document.getElementById('st-kline').dataset.mode === 'bad', { timeout: 12000 }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 400));
    const liveState = await live.evaluate(() => ({
      bars: window.__atu.getBars(),
      status: window.__atu.getStatus(),
      title: document.title,
      deltaTitle: document.getElementById('delta-title').textContent,
      deltaSub: document.getElementById('src-delta').textContent,
      liqSub: document.getElementById('src-liq').textContent,
      brand: document.querySelector('.brand b').textContent,
      iframes: document.querySelectorAll('iframe').length,
      tradeButtons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => /^(Long|Short|做多|做空|Buy|Sell)$/i.test(t))
    }));
    check(liveState.brand === '阿图行情', 'live brand');
    check(liveState.iframes === 0, 'live iframe');
    check(liveState.tradeButtons.length === 0, 'live trade buttons ' + liveState.tradeButtons.join(','));
    check(liveState.deltaSub.includes('不是订单簿 Bid/Ask Delta'), 'live delta subtitle');
    check(liveState.liqSub.includes('z×ap'), 'live liq subtitle');
    check(!/全交易所汇总/.test(liveState.deltaTitle), 'delta title must not say aggregated');
    if (liveState.status.histBad) {
      check(liveState.bars.length <= 3, 'history failure must not invent a candle history, got ' + liveState.bars.length);
      check(/未填入任何替代数据/.test(liveState.status.hist), 'missing honesty banner: ' + liveState.status.hist);
      check(liveState.bars.every(b => Math.abs(b.delta - (2 * b.takerBuyQuote - b.quote)) < 1e-4), 'live bar delta');
      if (liveState.bars.length) check(liveState.bars[0].close > 1000, 'live close looks unreal');
    } else {
      check(liveState.bars.length >= 20, 'expected history when REST succeeds');
      check(liveState.bars.every((b, i) => i === 0 || b.time > liveState.bars[i - 1].time), 'live order');
    }
    check(scriptErrors(liveBag).length === 0, 'live console ' + scriptErrors(liveBag).join(' | '));
    await shot(live, 'terminal-live-desktop');
    await live.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await live.waitForFunction(() => window.__atu && window.__atu.ready && window.__atu.getBars().length >= 1, { timeout: 15000 });
    console.log('LIVE_MOBILE ' + await live.evaluate(() => document.getElementById('last').textContent + ' | ' + document.getElementById('st-kline').textContent + ' | bars ' + window.__atu.getBars().length));
    await shot(live, 'terminal-live-mobile', true);
    await live.close();

    const page = await browser.newPage();
    const bag = { page: [], console: [] };
    track(page, bag);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(installFixture);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__atu && window.__atu.getBars().length >= 100, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('st-kline').dataset.mode === 'ok' && document.getElementById('st-liq').dataset.mode === 'ok', { timeout: 10000 });

    const math = await page.evaluate(() => {
      const bars = window.__atu.getBars();
      const sma = window.__atu.getSma();
      let sum = 0;
      const expect = bars.map((b, i) => {
        sum += b.quote;
        if (i >= 20) sum -= bars[i - 20].quote;
        return i >= 19 ? sum / 20 : null;
      });
      return {
        n: bars.length,
        step: bars[1].time - bars[0].time,
        ordered: bars.every((b, i) => i === 0 || b.time > bars[i - 1].time),
        ohlc: bars.every(b => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.high >= b.low),
        delta: bars.every(b => Math.abs(b.delta - (2 * b.takerBuyQuote - b.quote)) < 1e-4),
        sma: sma.every((v, i) => v === expect[i] || (v == null && expect[i] == null) || Math.abs(v - expect[i]) < 1e-6),
        smaHead: sma[18] == null && typeof sma[19] === 'number',
        interval: window.__atu.getSettings().interval,
        urls: window.__urls.slice(),
        banned: window.__banned.slice(),
        unexpected: window.__unexpected.slice(),
        sockets: window.__sockets.map(s => s.url)
      };
    });
    check(math.n === 120, 'fixture bar count ' + math.n);
    check(math.step === 3600, 'default 1h step ' + math.step);
    check(math.ordered && math.ohlc && math.delta && math.sma && math.smaHead, 'fixture integrity ' + JSON.stringify({ ordered: math.ordered, ohlc: math.ohlc, delta: math.delta, sma: math.sma, smaHead: math.smaHead }));
    check(math.interval === '1h', 'default interval');
    check(math.banned.length === 0, 'banned calls ' + math.banned.join(','));
    check(math.unexpected.length === 0, 'unexpected urls ' + math.unexpected.join(','));
    check(math.urls.some(u => u.includes('/fapi/v1/klines') && u.includes('interval=1h')), 'klines url');
    check(math.sockets.some(u => u === 'wss://fstream.binance.com/market/ws/btcusdt@kline_1h'), 'kline socket ' + math.sockets.join(','));
    check(math.sockets.some(u => u === 'wss://fstream.binance.com/market/ws/btcusdt@forceOrder'), 'liq socket');

    const liq = await page.evaluate(() => {
      const bars = window.__atu.getBars();
      const sock = window.__sockets.find(s => s.url.includes('@forceOrder'));
      const picked = bars.slice(-6);
      picked.forEach((b, i) => {
        const T = b.time * 1000 + 2000;
        const side = i % 2 ? 'BUY' : 'SELL';
        sock.onmessage({ data: JSON.stringify({
          e: 'forceOrder', E: T,
          o: { s: 'BTCUSDT', S: side, o: 'LIMIT', f: 'IOC', q: String(i + 1), p: String(100 + i), ap: '1000', z: '1', T }
        }) });
      });
      const afterNew = window.__atu.getLiqView();
      const last = picked[picked.length - 1];
      const T2 = last.time * 1000 + 2000;
      sock.onmessage({ data: JSON.stringify({
        e: 'forceOrder', E: T2 + 100,
        o: { s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', f: 'IOC', q: '6', p: '105', ap: '1000', z: '1', T: T2 }
      }) });
      const afterDup = window.__atu.getLiqView();
      sock.onmessage({ data: JSON.stringify({
        e: 'forceOrder', E: T2 + 800,
        o: { s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', f: 'IOC', q: '6', p: '105', ap: '1000', z: '2.5', T: T2 + 800 }
      }) });
      const afterMore = window.__atu.getLiqView();
      sock.close();
      return {
        events: afterMore.events,
        usd: afterMore.usd,
        dupEvents: afterDup.events,
        newEvents: afterNew.events,
        buckets: afterMore.buckets,
        conn: window.__atu.getLiqView().conn,
        pill: document.getElementById('st-liq').textContent
      };
    });
    check(liq.newEvents === 6, 'six liquidation snapshots, got ' + liq.newEvents);
    check(liq.dupEvents === 6, 'duplicate snapshot added an event');
    check(liq.events === 7, 'continuation should add one delta event, got ' + liq.events);
    check(Math.abs(liq.usd - (5 * 1000 + 2500)) < 1e-6, 'continuation notional ' + liq.usd);
    const valued = liq.buckets.filter(b => b.long > 0 || b.short > 0);
    check(valued.some(b => b.long > 0) && valued.some(b => b.short > 0), 'both liquidation sides');
    check(valued.every(b => b.status === 'partial' || b.status === 'open' || b.status === 'value'), 'observed bars are not silent zeros ' + valued.map(b => b.status).join(','));
    const missing = liq.buckets.filter(b => b.status === 'missing');
    check(missing.length > 0, 'bars before observation stay missing');
    check(missing.every(b => b.long === 0 && b.short === 0 && b.status !== 'zero'), 'missing is not zero');
    check(/断开/.test(liq.pill), 'disconnect is visible: ' + liq.pill);
    check(liq.conn === 'down', 'conn after close');

    await page.click('#tool-h');
    const box = await page.$eval('#cv-price', el => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width * 0.45, y: r.y + r.height * 0.45 };
    });
    await page.mouse.click(box.x, box.y);
    await new Promise(r => setTimeout(r, 300));
    await shot(page, 'terminal-fixture-desktop');
    await page.click('[data-tf="5m"]');
    await page.waitForFunction(() => {
      const s = window.__atu.getSettings();
      const bars = window.__atu.getBars();
      return s.interval === '5m' && bars.length >= 100 && bars[1].time - bars[0].time === 300;
    }, { timeout: 15000 });
    await page.$eval('#sma', el => {
      el.value = '8';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#tg-delta');
    const mid = await page.evaluate(() => {
      const s = window.__atu.getSettings();
      const bars = window.__atu.getBars();
      return {
        interval: s.interval,
        step: bars[1].time - bars[0].time,
        sma: s.sma,
        deltaHidden: document.getElementById('pane-delta').hidden,
        drawings: s.drawings,
        klineUrl: window.__urls.filter(u => u.includes('/klines')).pop()
      };
    });
    check(mid.interval === '5m' && mid.step === 300, '5m switch ' + mid.step);
    check(mid.sma === 8, 'sma control');
    check(mid.deltaHidden === true, 'delta pane hides');
    check(mid.drawings.length === 1 && mid.drawings[0].type === 'h' && mid.drawings[0].price > 0, 'horizontal line ' + JSON.stringify(mid.drawings));
    check(mid.klineUrl.includes('interval=5m'), '5m request ' + mid.klineUrl);
    const smaOk = await page.evaluate(() => {
      const bars = window.__atu.getBars();
      const got = window.__atu.getSma();
      let sum = 0;
      return bars.every((b, i) => {
        sum += b.quote;
        if (i >= 8) sum -= bars[i - 8].quote;
        const expect = i >= 7 ? sum / 8 : null;
        return got[i] === expect || (got[i] == null && expect == null) || Math.abs(got[i] - expect) < 1e-4;
      });
    });
    check(smaOk, 'sma(8) math');

    await page.click('[data-symbol="ETHUSDT"]');
    await page.waitForFunction(() => window.__atu.getSettings().symbol === 'ETHUSDT' && window.__atu.getBars().length >= 100, { timeout: 15000 });
    const eth = await page.evaluate(() => ({
      symbol: window.__atu.getSettings().symbol,
      sockets: window.__sockets.map(s => s.url),
      title: document.getElementById('price-title').textContent
    }));
    check(eth.symbol === 'ETHUSDT', 'watchlist switches symbol');
    check(eth.sockets.some(u => u.includes('/ethusdt@kline_5m')), 'eth kline socket ' + eth.sockets.join(','));
    check(eth.sockets.some(u => u.includes('/ethusdt@forceOrder')), 'eth liq socket');
    check(eth.title.includes('ETHUSDT'), 'title follows symbol');

    await page.click('[data-symbol="BTCUSDT"]');
    await page.waitForFunction(() => window.__atu.getSettings().symbol === 'BTCUSDT' && window.__atu.getSettings().interval === '5m', { timeout: 15000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__atu && window.__atu.getBars().length >= 100, { timeout: 15000 });
    const kept = await page.evaluate(() => {
      const s = window.__atu.getSettings();
      return { interval: s.interval, sma: s.sma, delta: s.panes.delta, drawings: s.drawings.length, symbol: s.symbol };
    });
    check(kept.symbol === 'BTCUSDT' && kept.interval === '5m' && kept.sma === 8 && kept.delta === false && kept.drawings === 1, 'persistence ' + JSON.stringify(kept));

    await page.click('#tg-delta');
    await page.click('#help-btn');
    await page.waitForFunction(() => !document.getElementById('help').hidden, { timeout: 5000 });
    const help = await page.$eval('#help', el => el.innerText);
    check(help.includes('不是订单簿') && help.includes('2×主动买入成交额') && help.includes('z×ap') && help.includes('没有隶属关系'), 'help text');
    check(scriptErrors(bag).length === 0, 'fixture console ' + scriptErrors(bag).join(' | '));
    await shot(page, 'terminal-data-notes');
    await page.click('#help-close');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.waitForFunction(() => window.__atu && window.__atu.getBars().length >= 20, { timeout: 15000 });
    const mobile = await page.evaluate(() => {
      const tools = document.querySelector('.tools').getBoundingClientRect();
      const watch = document.getElementById('watch').getBoundingClientRect();
      return { toolWide: tools.width > tools.height, watchVisible: watch.height > 20, scroll: document.documentElement.scrollWidth <= window.innerWidth + 2 };
    });
    check(mobile.toolWide, 'mobile toolbar is a row');
    check(mobile.watchVisible, 'mobile watchlist renders');
    await shot(page, 'terminal-fixture-mobile', true);

    const bad = await browser.newPage();
    const badBag = { page: [], console: [] };
    track(bad, badBag);
    await bad.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await bad.evaluateOnNewDocument(installFixture);
    await bad.goto(`http://127.0.0.1:${PORT}/?history=fail&ticker=fail`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await bad.evaluate(() => localStorage.clear());
    await bad.goto(`http://127.0.0.1:${PORT}/?history=fail&ticker=fail`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await bad.waitForFunction(() => {
      const t = document.getElementById('banner').textContent || '';
      return t.includes('未填入任何替代数据') && t.includes('Eligibility');
    }, { timeout: 15000 });
    const empty = await bad.evaluate(() => ({
      bars: window.__atu.getBars().length,
      banner: document.getElementById('banner').textContent,
      watch: document.getElementById('watch').innerText,
      last: document.getElementById('last').textContent
    }));
    check(empty.bars === 0, 'failed history leaves the chart empty, got ' + empty.bars);
    check(empty.last === '—', 'no invented last price');
    check(/报价失败/.test(empty.watch) && /不可用/.test(empty.watch), 'ticker failure is visible: ' + empty.watch);
    check(!/75860\.8/.test(empty.watch), 'failed ticker must not show fixture prices');
    check(scriptErrors(badBag).length === 0, 'error-state console ' + scriptErrors(badBag).join(' | '));
    await shot(bad, 'terminal-history-error');
    await bad.goto(`http://127.0.0.1:${PORT}/?history=throw&ticker=fail`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await bad.waitForFunction(() => {
      const t = document.getElementById('banner-text').textContent || '';
      return t.includes('没有读到 HTTP 状态') && t.includes('未填入任何替代数据') && !t.includes('HTTP 451');
    }, { timeout: 15000 });
    const beforeKlines = await bad.evaluate(() => window.__urls.filter(u => u.includes('/fapi/v1/klines')).length);
    await bad.click('#banner-retry');
    await bad.waitForFunction(n => window.__urls.filter(u => u.includes('/fapi/v1/klines')).length > n, { timeout: 10000 }, beforeKlines);
    const opaque = await bad.evaluate(() => {
      const urls = window.__urls.filter(u => u.includes('/fapi/v1/klines'));
      return {
        bars: window.__atu.getBars().length,
        last: document.getElementById('last').textContent,
        banner: document.getElementById('banner-text').textContent,
        urls: urls,
        liq: document.getElementById('pane-liq').hidden
      };
    });
    check(opaque.bars === 0, 'unreadable history leaves no candles, got ' + opaque.bars);
    check(opaque.last === '—', 'unreadable history invents a last price: ' + opaque.last);
    check(!/HTTP 451/.test(opaque.banner), 'unreadable failure must not invent status 451');
    check(opaque.urls.length >= 2, 'retry did not request klines again');
    check(opaque.urls.every(u => u.startsWith('https://fapi.binance.com/fapi/v1/klines')), 'retry left the documented host ' + opaque.urls.join(','));
    check(opaque.liq === false, 'liquidation pane removed');
    check(scriptErrors(badBag).length === 0, 'opaque-refusal console ' + scriptErrors(badBag).join(' | '));
    await shot(bad, 'terminal-unreadable-refusal');
    await bad.close();
    await page.close();
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  console.log('REACHABILITY_SUMMARY rest=' + (reach.rest && reach.rest.status) + ' ws=' + (reach.ws && reach.ws.ok));
  if (fails.length) {
    console.error(fails.map(f => 'FAIL ' + f).join('\n'));
    process.exit(1);
  }
  console.log('browser checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
