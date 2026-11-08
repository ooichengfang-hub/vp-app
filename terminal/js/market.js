'use strict';
/**
 * 阿图行情的纯计算。不发请求，也不准备示例行情。
 *
 * 历史 K 线：GET https://fapi.binance.com/fapi/v1/klines
 *   https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data
 * 实时 K 线：wss://fstream.binance.com/market/ws/<symbol>@kline_<interval>
 *   https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Kline-Candlestick-Streams
 *   https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice
 * 24h 报价：GET https://fapi.binance.com/fapi/v1/ticker/24hr
 * 标记价 / 资金费率：GET https://fapi.binance.com/fapi/v1/premiumIndex
 * 未平仓：GET https://fapi.binance.com/fapi/v1/openInterest
 *
 * K 线数组（REST 与 WS 字段对齐）：
 *   0 开盘时间  1 开  2 高  3 低  4 收  5 基础币成交量  6 收盘时间
 *   7 成交额 quote  8 成交笔数  9 主动买入基础币量  10 主动买入成交额
 * 主动卖出成交额 = quote − takerBuyQuote
 * 主动买卖差 = 2×takerBuyQuote − quote
 * 这是成交方向差，不是订单簿 Bid/Ask Delta。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.ATU_MARKET = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REST = 'https://fapi.binance.com';
  const WS_MARKET = 'wss://fstream.binance.com/market/ws';
  const KLINE_LIMIT = 500;
  const WATCH = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const INTERVALS = [
    { id: '1m', label: '1m', sec: 60 },
    { id: '5m', label: '5m', sec: 300 },
    { id: '15m', label: '15m', sec: 900 },
    { id: '30m', label: '30m', sec: 1800 },
    { id: '1h', label: '1H', sec: 3600 },
    { id: '4h', label: '4H', sec: 14400 },
    { id: '1d', label: '1D', sec: 86400 }
  ];
  const COPY = {
    brand: '阿图行情',
    deltaTitle: '主动买卖成交额差（替代指标）',
    deltaSub: '不是订单簿 Bid/Ask Delta，也不是全交易所汇总。公式：2×主动买入成交额 − 总成交额。来源：Binance USD-M 官方 K 线的 taker buy quote 与 quote volume，仅本交易所。',
    volumeTitle: '成交额',
    volumeSub: 'Binance USD-M 官方 K 线 quote asset volume（USDT）。SMA 含当根。',
    priceSub: 'Binance USD-M 永续官方 K 线。不是多交易所合成价。',
    liqTitle: '强平观察（仅本页）',
    liqSub: 'Binance USD-M forceOrder 公开快照。SELL=多头被强平（红、向下），BUY=空头被强平（绿、向上），金额=已成交 z×ap。每秒最多最大一笔，不是逐笔，不是全网清算。没观察到的区间留空，不是 0。'
  };

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }
  function intervalById(id) {
    for (let i = 0; i < INTERVALS.length; i++) if (INTERVALS[i].id === id) return INTERVALS[i];
    return null;
  }
  function isSymbol(s) {
    return typeof s === 'string' && WATCH.indexOf(s) >= 0;
  }
  function baseAsset(symbol) {
    return String(symbol || '').replace(/USDT$/, '') || symbol;
  }
  function endpoints(symbol, interval) {
    const sym = String(symbol || '').toUpperCase();
    const iv = String(interval || '');
    const low = sym.toLowerCase();
    return {
      klines: REST + '/fapi/v1/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + encodeURIComponent(iv) + '&limit=' + KLINE_LIMIT,
      ticker: REST + '/fapi/v1/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(WATCH)),
      premium: REST + '/fapi/v1/premiumIndex?symbol=' + encodeURIComponent(sym),
      openInterest: REST + '/fapi/v1/openInterest?symbol=' + encodeURIComponent(sym),
      klineWs: WS_MARKET + '/' + low + '@kline_' + iv,
      liqWs: WS_MARKET + '/' + low + '@forceOrder'
    };
  }
  function parseKline(row) {
    if (!Array.isArray(row) || row.length < 11) return null;
    const openTime = num(row[0]);
    const open = num(row[1]);
    const high = num(row[2]);
    const low = num(row[3]);
    const close = num(row[4]);
    const volume = num(row[5]);
    const closeTime = num(row[6]);
    const quote = num(row[7]);
    const trades = num(row[8]);
    const takerBuyBase = num(row[9]);
    const takerBuyQuote = num(row[10]);
    if (!(openTime > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null;
    if (!(high + 1e-8 >= low) || high + 1e-8 < Math.max(open, close) || low - 1e-8 > Math.min(open, close)) return null;
    if (!(volume >= 0) || !(quote >= 0) || !(takerBuyQuote >= 0)) return null;
    if (takerBuyQuote > quote + 0.01) return null;
    return {
      time: Math.floor(openTime / 1000),
      openTime: openTime,
      closeTime: Number.isFinite(closeTime) ? closeTime : null,
      open: open, high: high, low: low, close: close,
      volume: volume,
      quote: quote,
      trades: Number.isFinite(trades) ? trades : null,
      takerBuyBase: Number.isFinite(takerBuyBase) ? takerBuyBase : null,
      takerBuyQuote: takerBuyQuote,
      delta: 2 * takerBuyQuote - quote
    };
  }
  function parseKlineResponse(body) {
    if (!Array.isArray(body)) {
      const err = new Error(body && body.msg ? String(body.msg) : 'K线响应不是数组');
      err.code = body && body.code != null ? body.code : 'shape';
      throw err;
    }
    const bars = [];
    let skipped = 0;
    for (let i = 0; i < body.length; i++) {
      const bar = parseKline(body[i]);
      if (!bar) skipped++;
      else bars.push(bar);
    }
    bars.sort(function (a, b) { return a.time - b.time; });
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      if (out.length && out[out.length - 1].time === bars[i].time) out[out.length - 1] = bars[i];
      else out.push(bars[i]);
    }
    return { bars: out, skipped: skipped };
  }
  function parseKlineEvent(msg) {
    let m = msg;
    if (typeof m === 'string') {
      try { m = JSON.parse(m); } catch (e) { return null; }
    }
    if (!m || typeof m !== 'object') return null;
    if (m.data && m.data.e === 'kline') m = m.data;
    if (m.e !== 'kline' || !m.k) return null;
    const k = m.k;
    const bar = parseKline([k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q, '0']);
    if (!bar) return null;
    return { bar: bar, symbol: String(m.s || k.s || '').toUpperCase(), interval: String(k.i || ''), closed: k.x === true };
  }
  function upsertBar(bars, bar) {
    const next = bars.slice();
    if (!bar) return next;
    let i = -1;
    for (let n = 0; n < next.length; n++) if (next[n].time === bar.time) { i = n; break; }
    if (i >= 0) next[i] = bar;
    else if (!next.length || bar.time > next[next.length - 1].time) next.push(bar);
    else {
      next.push(bar);
      next.sort(function (a, b) { return a.time - b.time; });
    }
    return next;
  }
  function sma(values, period) {
    const p = period | 0;
    const out = new Array(values.length).fill(null);
    if (!(p >= 2)) return out;
    let sum = 0;
    let finiteRun = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!(typeof v === 'number' && Number.isFinite(v))) {
        sum = 0;
        finiteRun = 0;
        continue;
      }
      sum += v;
      finiteRun++;
      if (finiteRun > p) {
        sum -= values[i - p];
        finiteRun = p;
      }
      if (finiteRun === p) out[i] = sum / p;
    }
    return out;
  }
  function parseTickerRow(row) {
    if (!row || typeof row !== 'object') return null;
    const symbol = String(row.symbol || '').toUpperCase();
    const last = num(row.lastPrice);
    if (!symbol || !(last > 0)) return null;
    const pct = num(row.priceChangePercent);
    const quote = num(row.quoteVolume);
    return {
      symbol: symbol,
      last: last,
      pct: Number.isFinite(pct) ? pct : null,
      quote: Number.isFinite(quote) ? quote : null,
      high: num(row.highPrice),
      low: num(row.lowPrice),
      open: num(row.openPrice),
      time: num(row.closeTime)
    };
  }
  function parseTickerBook(body) {
    if (!Array.isArray(body)) {
      return { rows: {}, error: body && body.msg ? String(body.msg) : '报价响应不是数组', code: body && body.code };
    }
    const rows = {};
    for (let i = 0; i < body.length; i++) {
      const row = parseTickerRow(body[i]);
      if (row) rows[row.symbol] = row;
    }
    return { rows: rows, error: '' };
  }
  function parsePremium(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '资金费率响应为空' };
    if (body.msg && body.lastFundingRate == null && body.markPrice == null) return { error: String(body.msg), code: body.code };
    const mark = num(body.markPrice);
    const rate = num(body.lastFundingRate);
    if (!(mark > 0) && !Number.isFinite(rate)) return { error: '资金费率响应缺少字段' };
    return {
      error: '',
      symbol: body.symbol ? String(body.symbol).toUpperCase() : '',
      mark: Number.isFinite(mark) ? mark : null,
      index: num(body.indexPrice),
      rate: Number.isFinite(rate) ? rate : null,
      next: num(body.nextFundingTime)
    };
  }
  function parseOpenInterest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '持仓量响应为空' };
    if (body.msg && body.openInterest == null) return { error: String(body.msg), code: body.code };
    const oi = num(body.openInterest);
    if (!(oi >= 0)) return { error: '持仓量缺失' };
    return { error: '', oi: oi, symbol: body.symbol ? String(body.symbol).toUpperCase() : '', time: num(body.time) };
  }
  function changeFromBars(bars, nowSec, windowSec) {
    if (!bars || !bars.length) return null;
    const last = bars[bars.length - 1].close;
    const target = nowSec - windowSec;
    let ref = null;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].time <= target) ref = bars[i].close;
      else break;
    }
    if (!(ref > 0) || !(last > 0)) return null;
    return { last: last, ref: ref, pct: ((last - ref) / ref) * 100, basis: 'kline' };
  }
  function fmtNum(n, digits) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtPx(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || !(n > 0)) return '—';
    if (n >= 1000) return fmtNum(n, 1);
    if (n >= 1) return fmtNum(n, 2);
    if (n >= 0.01) return fmtNum(n, 4);
    return n.toPrecision(4);
  }
  function fmtCompact(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const s = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(2) + 'K';
    if (a >= 1) return s + a.toFixed(2);
    return s + a.toFixed(4);
  }
  function fmtPct(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const sign = n > 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }
  function fmtTime(sec) {
    if (!(sec > 0)) return '—';
    const d = new Date(sec * 1000);
    const p = function (v) { return String(v).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtClock(ms) {
    if (!(ms > 0)) return '—';
    const d = new Date(ms);
    const p = function (v) { return String(v).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function pricePrecision(last) {
    if (!(last > 0)) return 2;
    if (last >= 100) return 1;
    if (last >= 1) return 2;
    if (last >= 0.01) return 4;
    return 6;
  }
  function sanitizeDrawings(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length && out.length < 80; i++) {
      const d = list[i];
      if (!d || typeof d !== 'object') continue;
      const id = String(d.id || ('d' + i)).slice(0, 40);
      if (d.type === 'h' && typeof d.price === 'number' && Number.isFinite(d.price) && d.price > 0) {
        out.push({ id: id, type: 'h', price: d.price });
      } else if (d.type === 't' && [d.t1, d.p1, d.t2, d.p2].every(function (n) { return typeof n === 'number' && Number.isFinite(n); }) && d.p1 > 0 && d.p2 > 0 && d.t1 > 0 && d.t2 > 0) {
        out.push({ id: id, type: 't', t1: d.t1, p1: d.p1, t2: d.t2, p2: d.p2 });
      }
    }
    return out;
  }
  function defaultSettings() {
    return {
      v: 1,
      symbol: 'BTCUSDT',
      interval: '1h',
      sma: 20,
      panes: { volume: true, delta: true, liq: true },
      drawings: {}
    };
  }
  function sanitizeSettings(raw) {
    const base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    if (isSymbol(String(raw.symbol || '').toUpperCase())) base.symbol = String(raw.symbol).toUpperCase();
    if (intervalById(raw.interval)) base.interval = raw.interval;
    const smaN = num(raw.sma);
    if (smaN >= 2 && smaN <= 200) base.sma = Math.round(smaN);
    if (raw.panes && typeof raw.panes === 'object') {
      ['volume', 'delta', 'liq'].forEach(function (k) {
        if (typeof raw.panes[k] === 'boolean') base.panes[k] = raw.panes[k];
      });
    }
    if (raw.drawings && typeof raw.drawings === 'object') {
      Object.keys(raw.drawings).forEach(function (sym) {
        const s = String(sym).toUpperCase();
        if (!isSymbol(s)) return;
        base.drawings[s] = sanitizeDrawings(raw.drawings[sym]);
      });
    }
    return base;
  }
  function integrity(bars) {
    const problems = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!(b.high >= b.low && b.high >= b.open && b.high >= b.close && b.low <= b.open && b.low <= b.close)) problems.push('ohlc:' + i);
      if (Math.abs(b.delta - (2 * b.takerBuyQuote - b.quote)) > 1e-6) problems.push('delta:' + i);
      if (i && !(b.time > bars[i - 1].time)) problems.push('order:' + i);
    }
    return problems;
  }
  function liqPlot(buckets) {
    const longs = [];
    const shorts = [];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const blank = b.status === 'missing' || b.status === 'gap' || b.status === 'future';
      if (blank) {
        longs.push({ time: b.ts });
        shorts.push({ time: b.ts });
        continue;
      }
      const partial = b.status === 'partial' || b.status === 'open';
      const longColor = partial ? 'rgba(255,93,115,0.55)' : '#ff5d73';
      const shortColor = partial ? 'rgba(61,214,140,0.55)' : '#3dd68c';
      if (b.long > 0) longs.push({ time: b.ts, value: -b.long, color: longColor });
      else if (b.status === 'zero' || (b.status === 'open' && !(b.short > 0))) longs.push({ time: b.ts, value: 0, color: 'rgba(142,154,171,0.45)' });
      else longs.push({ time: b.ts });
      if (b.short > 0) shorts.push({ time: b.ts, value: b.short, color: shortColor });
      else shorts.push({ time: b.ts });
    }
    return { longs: longs, shorts: shorts };
  }
  function statusText(status) {
    if (status === 'missing') return '留空：这段没有观察记录，不是 0';
    if (status === 'gap') return '中断或未完整覆盖，不是 0';
    if (status === 'partial') return '只覆盖了一部分，金额不是该柱的完整总量';
    if (status === 'open') return '这根 K 线还没走完';
    if (status === 'zero') return '覆盖期间观察到 0';
    if (status === 'value') return '覆盖期间观察到的快照金额';
    if (status === 'future') return '还没到';
    return '';
  }

  return {
    REST: REST,
    WS_MARKET: WS_MARKET,
    KLINE_LIMIT: KLINE_LIMIT,
    WATCH: WATCH,
    INTERVALS: INTERVALS,
    COPY: COPY,
    intervalById: intervalById,
    isSymbol: isSymbol,
    baseAsset: baseAsset,
    endpoints: endpoints,
    parseKline: parseKline,
    parseKlineResponse: parseKlineResponse,
    parseKlineEvent: parseKlineEvent,
    upsertBar: upsertBar,
    sma: sma,
    parseTickerRow: parseTickerRow,
    parseTickerBook: parseTickerBook,
    parsePremium: parsePremium,
    parseOpenInterest: parseOpenInterest,
    changeFromBars: changeFromBars,
    fmtNum: fmtNum,
    fmtPx: fmtPx,
    fmtCompact: fmtCompact,
    fmtPct: fmtPct,
    fmtTime: fmtTime,
    fmtClock: fmtClock,
    pricePrecision: pricePrecision,
    sanitizeDrawings: sanitizeDrawings,
    sanitizeSettings: sanitizeSettings,
    defaultSettings: defaultSettings,
    integrity: integrity,
    liqPlot: liqPlot,
    statusText: statusText
  };
});
