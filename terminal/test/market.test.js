'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const M = require('../js/market.js');

const ROOT = path.resolve(__dirname, '../..');

test('delta uses the documented taker-buy quote field, not a book imbalance', () => {
  const quote = 21688069.67050;
  const taker = 11590832.15480;
  const row = [1794114000000, '75830.20', '75877.30', '75810.90', '75810.90', '285.933', 1794117599999, String(quote), 10668, '152.810', String(taker), '0'];
  const bar = M.parseKline(row);
  assert.equal(bar.time, 1794114000);
  assert.equal(bar.quote, quote);
  assert.equal(bar.takerBuyQuote, taker);
  assert.ok(Math.abs(bar.delta - (2 * taker - quote)) < 1e-6);
  assert.ok(bar.delta > 0);
});

test('malformed klines are rejected instead of being repaired with sample prices', () => {
  assert.equal(M.parseKline(null), null);
  assert.equal(M.parseKline([1, 2, 3]), null);
  assert.equal(M.parseKline([1000, '0', '1', '1', '1', '1', 2000, '1', 1, '1', '1', '0']), null);
  assert.equal(M.parseKline([1000, '10', '9', '8', '9', '1', 2000, '10', 1, '1', '4', '0']), null);
  assert.equal(M.parseKline([1000, '10', '12', '9', '11', '1', 2000, '10', 1, '1', '40', '0']), null);
  assert.throws(() => M.parseKlineResponse({ code: 0, msg: 'restricted location' }), /restricted location/);
  const empty = M.parseKlineResponse([]);
  assert.deepEqual(empty.bars, []);
  assert.equal(empty.skipped, 0);
});

test('sma is a simple mean of the current window and stays blank until it fills', () => {
  assert.deepEqual(M.sma([1, 2, 3, 4, 5], 1), [null, null, null, null, null]);
  assert.deepEqual(M.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.equal(M.sma([10, 20, 30], 20)[2], null);
});

test('endpoints stay on the documented public USD-M routes', () => {
  const e = M.endpoints('BTCUSDT', '1h');
  assert.equal(e.klines, 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=500');
  assert.equal(e.klineWs, 'wss://fstream.binance.com/market/ws/btcusdt@kline_1h');
  assert.equal(e.liqWs, 'wss://fstream.binance.com/market/ws/btcusdt@forceOrder');
  assert.match(e.ticker, /^https:\/\/fapi\.binance\.com\/fapi\/v1\/ticker\/24hr\?symbols=/);
  assert.match(e.premium, /\/fapi\/v1\/premiumIndex\?symbol=BTCUSDT$/);
  assert.match(e.openInterest, /\/fapi\/v1\/openInterest\?symbol=BTCUSDT$/);
  const joined = Object.values(e).join('\n');
  assert.doesNotMatch(joined, /fapi1\.binance|fapi2\.binance|data\.binance\.vision|coinglass|telegram|\/fapi\/v1\/order|allForceOrders/i);
  assert.equal(M.intervalById('1h').sec, 3600);
  assert.equal(M.intervalById('5m').sec, 300);
  assert.equal(M.intervalById('2h'), null);
});

test('kline events use the same taker fields and ignore the wrong symbol', () => {
  const ev = {
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1794114000000, T: 1794117599999, s: 'BTCUSDT', i: '1h', o: '10', c: '11', h: '12', l: '9', v: '3', n: 4, x: false, q: '100', V: '1', Q: '40' }
  };
  const parsed = M.parseKlineEvent(JSON.stringify({ stream: 'btcusdt@kline_1h', data: ev }));
  assert.equal(parsed.symbol, 'BTCUSDT');
  assert.equal(parsed.interval, '1h');
  assert.equal(parsed.closed, false);
  assert.equal(parsed.bar.delta, 2 * 40 - 100);
  const bars = M.upsertBar([{ time: parsed.bar.time, close: 1 }], parsed.bar);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 11);
  assert.equal(M.parseKlineEvent({ e: 'forceOrder' }), null);
});

test('ticker, premium and open interest errors stay errors', () => {
  const book = M.parseTickerBook([{ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '-1.5', quoteVolume: '2000', highPrice: '110', lowPrice: '90', closeTime: 10 }]);
  assert.equal(book.error, '');
  assert.equal(book.rows.BTCUSDT.pct, -1.5);
  const bad = M.parseTickerBook({ code: 0, msg: 'restricted location' });
  assert.match(bad.error, /restricted/);
  assert.deepEqual(bad.rows, {});
  assert.match(M.parsePremium({ code: 0, msg: 'no' }).error, /no/);
  const prem = M.parsePremium({ symbol: 'BTCUSDT', markPrice: '101', indexPrice: '100', lastFundingRate: '0.0001', nextFundingTime: 50 });
  assert.equal(prem.error, '');
  assert.equal(prem.rate, 0.0001);
  assert.match(M.parseOpenInterest({ msg: 'down' }).error, /down/);
  assert.equal(M.parseOpenInterest({ symbol: 'BTCUSDT', openInterest: '12.5', time: 9 }).oi, 12.5);
});

test('24h change from candles needs a real bar at least a day earlier', () => {
  const now = 1_700_000_000;
  const bars = [
    { time: now - 90000, close: 100 },
    { time: now - 3600, close: 110 }
  ];
  const ch = M.changeFromBars(bars, now, 86400);
  assert.equal(ch.ref, 100);
  assert.equal(ch.pct, 10);
  assert.equal(M.changeFromBars([{ time: now - 1000, close: 110 }], now, 86400), null);
});

test('settings drop unknown symbols and broken drawings', () => {
  const raw = M.sanitizeSettings({
    symbol: 'FAKEUSDT',
    interval: '5m',
    sma: 8,
    panes: { volume: false, delta: true, liq: 'yes' },
    drawings: {
      BTCUSDT: [{ id: 'a', type: 'h', price: 10 }, { type: 't', t1: 1, p1: 2, t2: 3, p2: 4 }, { type: 'h', price: -1 }, { type: 'box' }],
      ETHUSDT: [{ id: 'b', type: 'h', price: 20 }],
      NOPE: [{ id: 'c', type: 'h', price: 5 }]
    }
  });
  assert.equal(raw.symbol, 'BTCUSDT');
  assert.equal(raw.interval, '5m');
  assert.equal(raw.sma, 8);
  assert.equal(raw.panes.volume, false);
  assert.equal(raw.panes.delta, true);
  assert.equal(raw.panes.liq, true);
  assert.equal(raw.drawings.BTCUSDT.length, 2);
  assert.equal(raw.drawings.ETHUSDT.length, 1);
  assert.equal(raw.drawings.NOPE, undefined);
  assert.equal(M.sanitizeSettings(null).interval, '1h');
});

test('liquidation gaps are not plotted as zero bars', () => {
  const plot = M.liqPlot([
    { ts: 1, status: 'missing', long: 0, short: 0 },
    { ts: 2, status: 'gap', long: 0, short: 0 },
    { ts: 3, status: 'future', long: 0, short: 0 },
    { ts: 4, status: 'value', long: 10, short: 4 },
    { ts: 5, status: 'zero', long: 0, short: 0 },
    { ts: 6, status: 'partial', long: 2, short: 0 },
    { ts: 7, status: 'open', long: 0, short: 0 }
  ]);
  for (const i of [0, 1, 2]) assert.equal(plot.longs[i].value, undefined);
  assert.equal(plot.longs[3].value, -10);
  assert.equal(plot.shorts[3].value, 4);
  assert.equal(plot.longs[4].value, 0);
  assert.equal(plot.longs[5].value, -2);
  assert.match(plot.longs[5].color, /0\.55/);
  assert.equal(plot.longs[6].value, 0);
  assert.match(M.statusText('gap'), /不是 0/);
  assert.match(M.statusText('missing'), /不是 0/);
  assert.match(M.COPY.deltaSub, /不是订单簿 Bid\/Ask Delta/);
  assert.match(M.COPY.deltaSub, /2×主动买入成交额 − 总成交额/);
  assert.match(M.COPY.liqSub, /z×ap/);
  assert.doesNotMatch(M.COPY.deltaTitle, /全交易所/);
});

test('terminal sources do not carry fallback hosts, fixtures, or the root apple chart', () => {
  const files = ['index.html', 'js/app.js', 'js/market.js', 'js/charts.js', 'js/liq.js', 'css/terminal.css'];
  const text = files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.match(text, /阿图行情/);
  assert.match(text, /不是订单簿 Bid\/Ask Delta，也不是全交易所汇总/);
  assert.doesNotMatch(text, /fapi1\.binance|fapi2\.binance|data\.binance\.vision|coinglass\.com|api\.telegram|api\.day\.app|gist\.github|allForceOrders|\/fapi\/v1\/order|sampleBars|DEMO_BARS|iframe/i);
  assert.doesNotMatch(text, /做多|做空/);
  const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
  status.split('\n').filter(Boolean).forEach(line => {
    const file = line.slice(3).trim();
    assert.ok(file.startsWith('terminal/'), 'root apple chart must stay untouched: ' + line);
  });
});
