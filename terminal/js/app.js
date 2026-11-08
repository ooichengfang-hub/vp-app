'use strict';
/**
 * 阿图行情页面。只请求 market.js 里写明的 Binance 公开地址。
 * 失败时留空，不使用示例 K 线，也不换备用域名。
 */
(function () {
  const M = window.ATU_MARKET;
  const LIQ = window.LIQ;
  const LAYOUT_KEY = 'atu-terminal-layout-v1';
  const LIQ_PREFIX = 'atu-terminal-liq-v1:';
  const HIDDEN_GAP_MS = 15000;

  const state = {
    gen: 0,
    symbol: 'BTCUSDT',
    interval: '1h',
    sma: 20,
    panes: { volume: true, delta: true, liq: true },
    drawings: {},
    bars: [],
    buckets: [],
    historyOk: false,
    histText: '',
    histBad: false,
    liq: null,
    stopKline: null,
    stopLiq: null,
    hiddenAt: 0,
    tickers: {},
    tickerError: '',
    premium: null,
    premiumError: '',
    oi: null,
    oiError: '',
    focus: null
  };
  let charts = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function readSettings() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch (e) { raw = null; }
    const s = M.sanitizeSettings(raw);
    state.symbol = s.symbol;
    state.interval = s.interval;
    state.sma = s.sma;
    state.panes = s.panes;
    state.drawings = s.drawings;
  }
  function writeSettings() {
    if (charts) state.drawings[state.symbol] = charts.getDrawings();
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        v: 1,
        symbol: state.symbol,
        interval: state.interval,
        sma: state.sma,
        panes: {
          volume: !!state.panes.volume,
          delta: !!state.panes.delta,
          liq: !!state.panes.liq
        },
        drawings: state.drawings
      }));
    } catch (e) { /* 隐私模式写不进本地时，图仍然能看 */ }
  }
  function loadLiq(symbol) {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LIQ_PREFIX + symbol) || 'null'); } catch (e) { raw = null; }
    return LIQ.hydrate(raw, Date.now(), symbol);
  }
  function saveLiq() {
    if (!state.liq) return;
    try { localStorage.setItem(LIQ_PREFIX + state.symbol, JSON.stringify(LIQ.serialize(state.liq))); } catch (e) {}
  }
  async function getJson(url) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      const err = new Error('没有连上接口');
      err.network = true;
      err.url = url;
      throw err;
    }
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = null; }
    }
    if (!res.ok) {
      const err = new Error(body && body.msg ? String(body.msg) : ('HTTP ' + res.status));
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return { status: res.status, body: body, url: url };
  }
  function setBanner(text) {
    const node = $('banner');
    state.histText = text || '';
    state.histBad = !!text;
    node.hidden = !text;
    node.textContent = text || '';
  }
  function setPill(id, mode, text) {
    const node = $(id);
    node.dataset.mode = mode;
    node.textContent = text;
  }
  function fillCopy() {
    $('src-price').textContent = $('src-price').title = M.COPY.priceSub;
    $('volume-title').textContent = M.COPY.volumeTitle;
    $('src-volume').textContent = $('src-volume').title = M.COPY.volumeSub;
    $('delta-title').textContent = M.COPY.deltaTitle;
    $('src-delta').textContent = $('src-delta').title = M.COPY.deltaSub;
    $('liq-title').textContent = M.COPY.liqTitle;
    $('src-liq').textContent = $('src-liq').title = M.COPY.liqSub;
    $('watch-src').textContent = '报价来源：Binance USD-M GET /fapi/v1/ticker/24hr · 实时与强平：wss://fstream.binance.com/market';
  }
  function renderChrome() {
    $('symbol-name').textContent = state.symbol;
    $('price-title').textContent = state.symbol + ' · ' + (M.intervalById(state.interval) || {}).label;
    document.title = '阿图行情 · ' + state.symbol;
    document.querySelectorAll('.tf').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-tf') === state.interval));
    });
    ['volume', 'delta', 'liq'].forEach(function (name) {
      const btn = $('tg-' + name);
      btn.setAttribute('aria-pressed', String(!!state.panes[name]));
    });
    $('sma').value = String(state.sma);
    renderHeader();
    renderLegend();
  }
  function renderHeader() {
    const bar = state.bars.length ? state.bars[state.bars.length - 1] : null;
    const tick = state.tickers[state.symbol];
    const px = tick && tick.last ? tick.last : (bar ? bar.close : null);
    $('last').textContent = px ? M.fmtPx(px) : '—';
    let pct = null;
    let basis = '';
    if (tick && typeof tick.pct === 'number') {
      pct = tick.pct;
      basis = '24h ticker';
    } else {
      const ch = M.changeFromBars(state.bars, Date.now() / 1000, 86400);
      if (ch) { pct = ch.pct; basis = '24h K线'; }
    }
    const chg = $('chg');
    if (pct == null) {
      chg.textContent = state.tickerError ? '24h 报价不可用' : '24h 不可用';
      chg.className = 'chg';
    } else {
      chg.textContent = M.fmtPct(pct) + ' · ' + basis;
      chg.className = 'chg ' + (pct >= 0 ? 'up' : 'down');
    }
    $('last').className = 'last' + (pct == null ? '' : pct >= 0 ? ' up' : ' down');
  }
  function barIndex(bar) {
    if (!bar) return -1;
    for (let i = 0; i < state.bars.length; i++) if (state.bars[i].time === bar.time) return i;
    return -1;
  }
  function renderLegend() {
    const bar = state.focus != null && charts ? charts.barAt(state.focus) : (state.bars[state.bars.length - 1] || null);
    const when = bar ? M.fmtTime(bar.time) : '—';
    const tag = state.focus == null && bar ? '最新 · ' : (bar ? '' : '');
    if (!bar) {
      $('leg-price').textContent = '没有 K 线';
      $('leg-volume').textContent = '没有成交额';
      $('leg-delta').textContent = '没有买卖差';
    } else {
      $('leg-price').textContent = tag + when + '  开 ' + M.fmtPx(bar.open) + '  高 ' + M.fmtPx(bar.high) + '  低 ' + M.fmtPx(bar.low) + '  收 ' + M.fmtPx(bar.close);
      const ma = M.sma(state.bars.map(function (b) { return b.quote; }), state.sma);
      const i = barIndex(bar);
      const maText = i >= 0 && ma[i] != null ? M.fmtCompact(ma[i]) : '样本不足';
      $('leg-volume').textContent = tag + M.fmtCompact(bar.quote) + ' USDT · SMA(' + state.sma + ') ' + maText;
      $('leg-delta').textContent = tag + M.fmtCompact(bar.delta) + ' USDT · 主动买 ' + M.fmtCompact(bar.takerBuyQuote);
    }
    const bucket = bar && state.buckets ? state.buckets.filter(function (b) { return b.ts === bar.time; })[0] : null;
    if (!bucket) {
      $('leg-liq').textContent = state.bars.length ? '这根没有强平观察' : '尚无观察';
      return;
    }
    const side = '多 ' + M.fmtCompact(bucket.long || 0) + ' · 空 ' + M.fmtCompact(bucket.short || 0);
    const blank = bucket.status === 'missing' || bucket.status === 'gap' || bucket.status === 'future';
    $('leg-liq').textContent = (blank ? '' : side + ' · ') + M.statusText(bucket.status);
  }
  function renderWatch() {
    const root = $('watch');
    root.textContent = '';
    if (state.tickerError) {
      root.appendChild(el('p', 'side-err', '24h 报价失败：' + state.tickerError + '。未填入替代报价。'));
    }
    M.WATCH.forEach(function (sym) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wrow' + (sym === state.symbol ? ' on' : '');
      btn.dataset.symbol = sym;
      const tick = state.tickers[sym];
      btn.appendChild(el('span', 'wn', sym));
      if (tick) {
        btn.appendChild(el('span', '', M.fmtPx(tick.last)));
        const pct = el('span', tick.pct > 0 ? 'up' : tick.pct < 0 ? 'down' : '', M.fmtPct(tick.pct));
        btn.appendChild(pct);
        btn.appendChild(el('span', '', M.fmtCompact(tick.quote)));
      } else if (sym === state.symbol && state.bars.length) {
        btn.appendChild(el('span', '', M.fmtPx(state.bars[state.bars.length - 1].close)));
        btn.appendChild(el('span', '', '实时K线'));
        btn.appendChild(el('span', '', '不可用'));
      } else {
        btn.appendChild(el('span', '', '不可用'));
        btn.appendChild(el('span', '', '—'));
        btn.appendChild(el('span', '', '—'));
      }
      btn.addEventListener('click', function () {
        if (sym !== state.symbol) applyMarket(sym, state.interval);
      });
      root.appendChild(btn);
    });
  }
  function row(label, value, bad) {
    const wrap = document.createElement('div');
    wrap.appendChild(el('dt', '', label));
    wrap.appendChild(el('dd', bad ? 'down' : '', value));
    return wrap;
  }
  function renderOverview() {
    const root = $('ov');
    root.textContent = '';
    const tick = state.tickers[state.symbol];
    root.appendChild(row('合约', state.symbol + ' 永续'));
    if (tick && Number.isFinite(tick.high) && Number.isFinite(tick.low)) {
      root.appendChild(row('24h 高 / 低', M.fmtPx(tick.high) + ' / ' + M.fmtPx(tick.low)));
    } else {
      root.appendChild(row('24h 高 / 低', state.tickerError ? '不可用' : '等待报价', !!state.tickerError));
    }
    if (state.premium && state.premium.mark) root.appendChild(row('标记价格', M.fmtPx(state.premium.mark)));
    else root.appendChild(row('标记价格', state.premiumError || '等待', !!state.premiumError));
    if (state.premium && typeof state.premium.rate === 'number') {
      const next = state.premium.next > 0 ? ' · 下次 ' + M.fmtClock(state.premium.next) : '';
      root.appendChild(row('资金费率', (state.premium.rate * 100).toFixed(4) + '%' + next));
    } else root.appendChild(row('资金费率', state.premiumError || '等待', !!state.premiumError));
    if (state.oi && state.oi.oi != null) root.appendChild(row('未平仓', M.fmtCompact(state.oi.oi) + ' ' + M.baseAsset(state.symbol)));
    else root.appendChild(row('未平仓', state.oiError || '等待', !!state.oiError));
    root.appendChild(row('来源', 'premiumIndex · openInterest'));
  }
  function publishBars(reset) {
    charts.setMarket(state.bars, state.sma, reset);
    refreshLiq();
    renderHeader();
    renderLegend();
    renderWatch();
  }
  function onKlineBar(bar) {
    const prevLen = state.bars.length;
    const prevLast = prevLen ? state.bars[prevLen - 1].time : null;
    state.bars = M.upsertBar(state.bars, bar);
    const nextLast = state.bars.length ? state.bars[state.bars.length - 1].time : null;
    const appended = state.bars.length === prevLen + 1 && nextLast === bar.time && (prevLast == null || bar.time > prevLast);
    const updatedLast = state.bars.length === prevLen && nextLast === bar.time && prevLast === bar.time;
    if ((appended || updatedLast) && prevLen > 0) charts.patchLast(state.bars, state.sma);
    else charts.setMarket(state.bars, state.sma, prevLen === 0);
    if (appended || prevLen === 0) refreshLiq();
    renderHeader();
    if (state.focus == null) renderLegend();
    if (state.symbol && state.tickers[state.symbol] == null) renderWatch();
  }
  function refreshLiq() {
    const iv = M.intervalById(state.interval);
    const sec = iv ? iv.sec : 3600;
    const starts = state.bars.map(function (b) { return b.time; });
    state.buckets = state.liq ? LIQ.series(state.liq, starts, sec, Date.now()) : [];
    if (charts) charts.setLiq(state.buckets);
    renderLegend();
  }
  async function loadHistory(gen) {
    const ep = M.endpoints(state.symbol, state.interval);
    setPill('st-hist', 'wait', '历史请求中');
    setBanner('');
    try {
      const res = await getJson(ep.klines);
      if (gen !== state.gen) return;
      const parsed = M.parseKlineResponse(res.body);
      if (!parsed.bars.length) {
        state.historyOk = false;
        if (!state.bars.length) charts.setMarket([], state.sma, true);
        setBanner('历史 K 线返回空数组（GET /fapi/v1/klines）。未填入任何替代数据。');
        setPill('st-hist', 'bad', '历史为空');
      renderHeader();
      renderLegend();
      renderWatch();
      return;
    }
      state.bars = parsed.bars;
      state.historyOk = true;
      const skip = parsed.skipped ? '，另有 ' + parsed.skipped + ' 根无法解析已丢弃' : '';
      charts.setMarket(state.bars, state.sma, true);
      refreshLiq();
      setPill('st-hist', 'ok', '历史 ' + parsed.bars.length + ' 根');
      if (parsed.skipped) setBanner('有 ' + parsed.skipped + ' 根 K 线无法解析，已丢弃，没有用别的数字填上。' + skip);
      renderHeader();
      renderLegend();
      renderWatch();
    } catch (e) {
      if (gen !== state.gen) return;
      state.historyOk = false;
      if (!state.bars.length) charts.setMarket([], state.sma, true);
      const status = e.status ? ('HTTP ' + e.status + '，') : '';
      setBanner('历史 K 线失败（' + status + 'GET /fapi/v1/klines）。' + e.message + '。未填入任何替代数据。图上只会留下已经从实时 K 线流收到的柱，更早的时间留空。');
      setPill('st-hist', 'bad', e.status ? ('历史 ' + e.status) : '历史失败');
      renderHeader();
      renderLegend();
      renderWatch();
    }
  }
  function openSocket(url, gen, handlers) {
    let attempt = 0;
    let socket = null;
    let timer = 0;
    let closedByUs = false;
    function connect() {
      if (gen !== state.gen || closedByUs) return;
      handlers.wait();
      try { socket = new WebSocket(url); }
      catch (e) { schedule(); return; }
      socket.onopen = function () {
        if (gen !== state.gen || closedByUs) return;
        attempt = 0;
        handlers.open();
      };
      socket.onmessage = function (ev) {
        if (gen !== state.gen || closedByUs) return;
        handlers.message(ev);
      };
      socket.onerror = function () {};
      socket.onclose = function () {
        if (closedByUs || gen !== state.gen) return;
        handlers.down();
        schedule();
      };
    }
    function schedule() {
      attempt += 1;
      const wait = LIQ.backoffMs(attempt);
      handlers.retry(wait, attempt);
      timer = setTimeout(connect, wait);
    }
    connect();
    return function stop() {
      closedByUs = true;
      clearTimeout(timer);
      handlers.stop && handlers.stop();
      if (socket && socket.readyState < 2) {
        try { socket.close(); } catch (e) {}
      }
    };
  }
  function openKline(gen) {
    const url = M.endpoints(state.symbol, state.interval).klineWs;
    return openSocket(url, gen, {
      wait: function () { setPill('st-kline', 'wait', '实时K线连接中'); },
      open: function () { setPill('st-kline', 'ok', '实时K线已连接'); },
      retry: function () { setPill('st-kline', 'bad', '实时K线断开'); },
      down: function () {},
      message: function (ev) {
        const parsed = M.parseKlineEvent(ev.data);
        if (!parsed || parsed.symbol !== state.symbol || parsed.interval !== state.interval) return;
        onKlineBar(parsed.bar);
      }
    });
  }
  function openLiq(gen) {
    const url = LIQ.streamUrl(state.symbol);
    if (!url) {
      setPill('st-liq', 'bad', '强平地址无效');
      return function () {};
    }
    return openSocket(url, gen, {
      wait: function () { setPill('st-liq', 'wait', '强平连接中'); },
      open: function () {
        LIQ.coverOpen(state.liq, Date.now());
        setPill('st-liq', 'ok', '强平已连接');
        refreshLiq();
        saveLiq();
      },
      retry: function () { setPill('st-liq', 'bad', '强平断开'); },
      down: function () {
        if (state.liq && state.liq.open != null) LIQ.coverClose(state.liq, Date.now());
        refreshLiq();
        saveLiq();
      },
      stop: function () {
        if (state.liq && state.liq.open != null) LIQ.coverClose(state.liq, Date.now());
        saveLiq();
      },
      message: function (ev) {
        LIQ.ingest(state.liq, ev.data, Date.now());
        refreshLiq();
        saveLiq();
      }
    });
  }
  async function loadSide(gen) {
    const ep = M.endpoints(state.symbol, state.interval);
    try {
      const res = await getJson(ep.ticker);
      if (gen !== state.gen) return;
      const book = M.parseTickerBook(res.body);
      if (book.error) {
        state.tickers = {};
        state.tickerError = book.error;
      } else {
        state.tickers = book.rows;
        state.tickerError = '';
      }
    } catch (e) {
      if (gen !== state.gen) return;
      state.tickers = {};
      state.tickerError = (e.status ? 'HTTP ' + e.status + ' ' : '') + e.message;
    }
    try {
      const res = await getJson(ep.premium);
      if (gen !== state.gen) return;
      const p = M.parsePremium(res.body);
      state.premium = p.error ? null : p;
      state.premiumError = p.error || '';
    } catch (e) {
      if (gen !== state.gen) return;
      state.premium = null;
      state.premiumError = (e.status ? 'HTTP ' + e.status + ' ' : '') + e.message;
    }
    try {
      const res = await getJson(ep.openInterest);
      if (gen !== state.gen) return;
      const o = M.parseOpenInterest(res.body);
      state.oi = o.error ? null : o;
      state.oiError = o.error || '';
    } catch (e) {
      if (gen !== state.gen) return;
      state.oi = null;
      state.oiError = (e.status ? 'HTTP ' + e.status + ' ' : '') + e.message;
    }
    renderWatch();
    renderOverview();
    renderHeader();
  }
  function stopFeeds() {
    if (state.stopKline) state.stopKline();
    if (state.stopLiq) state.stopLiq();
    state.stopKline = null;
    state.stopLiq = null;
  }
  function applyMarket(symbol, interval) {
    if (charts) state.drawings[state.symbol] = charts.getDrawings();
    stopFeeds();
    state.symbol = symbol;
    state.interval = interval;
    state.gen += 1;
    const gen = state.gen;
    state.bars = [];
    state.buckets = [];
    state.historyOk = false;
    state.focus = null;
    state.premium = null;
    state.oi = null;
    state.liq = loadLiq(symbol);
    charts.setDrawings(state.drawings[symbol] || []);
    charts.setMarket([], state.sma, true);
    charts.setLiq([]);
    renderChrome();
    writeSettings();
    loadHistory(gen);
    state.stopKline = openKline(gen);
    state.stopLiq = openLiq(gen);
    loadSide(gen);
  }
  function selectTool(name) {
    const tool = charts.setTool(name);
    $('tool-cross').setAttribute('aria-pressed', String(tool === 'cross'));
    $('tool-h').setAttribute('aria-pressed', String(tool === 'h'));
    $('tool-t').setAttribute('aria-pressed', String(tool === 't'));
  }
  function setSma(n) {
    n = Math.round(Number(n));
    if (!(n >= 2 && n <= 200)) {
      $('sma').value = String(state.sma);
      return;
    }
    state.sma = n;
    $('sma').value = String(n);
    charts.setSma(n);
    renderLegend();
    writeSettings();
  }
  function bind() {
    document.querySelectorAll('.tf').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const tf = btn.getAttribute('data-tf');
        if (tf && tf !== state.interval && M.intervalById(tf)) applyMarket(state.symbol, tf);
      });
    });
    $('sma').addEventListener('change', function () { setSma($('sma').value); });
    $('sma-dec').addEventListener('click', function () { setSma(state.sma - 1); });
    $('sma-inc').addEventListener('click', function () { setSma(state.sma + 1); });
    ['volume', 'delta', 'liq'].forEach(function (name) {
      $('tg-' + name).addEventListener('click', function () {
        state.panes[name] = !state.panes[name];
        charts.setPane(name, state.panes[name]);
        renderChrome();
        if (name === 'liq') refreshLiq();
        writeSettings();
      });
    });
    $('tool-cross').addEventListener('click', function () { selectTool('cross'); });
    $('tool-h').addEventListener('click', function () { selectTool('h'); });
    $('tool-t').addEventListener('click', function () { selectTool('t'); });
    $('tool-del').addEventListener('click', function () { charts.deleteSelected(); });
    $('reload').addEventListener('click', function () { applyMarket(state.symbol, state.interval); });
    $('help-btn').addEventListener('click', function () { $('help').hidden = false; });
    $('help-close').addEventListener('click', function () { $('help').hidden = true; });
    $('help').addEventListener('click', function (ev) { if (ev.target === $('help')) $('help').hidden = true; });
    document.addEventListener('keydown', function (ev) {
      const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (ev.key === 'Escape') {
        if (!$('help').hidden) { $('help').hidden = true; return; }
        selectTool('cross');
      }
      if (!typing && (ev.key === 'Delete' || ev.key === 'Backspace')) {
        charts.deleteSelected();
        ev.preventDefault();
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        state.hiddenAt = Date.now();
        saveLiq();
        return;
      }
      const hiddenAt = state.hiddenAt;
      state.hiddenAt = 0;
      if (hiddenAt && Date.now() - hiddenAt > HIDDEN_GAP_MS && state.liq && state.liq.open != null) {
        LIQ.coverClose(state.liq, hiddenAt);
        LIQ.coverOpen(state.liq, Date.now());
        refreshLiq();
        saveLiq();
      }
    });
    window.addEventListener('pagehide', function () {
      if (state.liq && state.liq.open != null) LIQ.coverClose(state.liq, Date.now());
      saveLiq();
      writeSettings();
    });
  }

  function boot() {
    if (!window.LightweightCharts || !M || !LIQ || !window.ATU_CHARTS) {
      setBanner('页面脚本不完整，图没有启动，也没有填入示例数据。');
      return;
    }
    readSettings();
    fillCopy();
    charts = window.ATU_CHARTS.mount({
      price: $('cv-price'),
      volume: $('cv-volume'),
      delta: $('cv-delta'),
      liq: $('cv-liq'),
      draw: $('draw'),
      hatch: $('hatch')
    }, { panes: state.panes });
    charts.onFocus(function (time) {
      state.focus = time;
      renderLegend();
    });
    charts.onDrawings(function () { writeSettings(); });
    charts.setDrawings(state.drawings[state.symbol] || []);
    bind();
    state.liq = loadLiq(state.symbol);
    renderChrome();
    renderWatch();
    renderOverview();
    window.__atu = {
      ready: true,
      getBars: function () { return state.bars.map(function (b) { return Object.assign({}, b); }); },
      getSma: function () { return M.sma(state.bars.map(function (b) { return b.quote; }), state.sma); },
      getSettings: function () {
        return {
          symbol: state.symbol,
          interval: state.interval,
          sma: state.sma,
          panes: Object.assign({}, state.panes),
          drawings: charts.getDrawings()
        };
      },
      getLiqView: function () {
        return {
          conn: state.liq ? state.liq.conn : 'down',
          events: state.liq ? state.liq.events.length : 0,
          usd: state.liq ? state.liq.events.reduce(function (s, e) { return s + e.usd; }, 0) : 0,
          buckets: (state.buckets || []).map(function (b) { return Object.assign({}, b); })
        };
      },
      getStatus: function () {
        return {
          hist: state.histText,
          histBad: state.histBad,
          kline: $('st-kline').textContent,
          liq: $('st-liq').textContent,
          bannerHidden: $('banner').hidden
        };
      }
    };
    applyMarket(state.symbol, state.interval);
    setInterval(function () {
      refreshLiq();
      if (state.liq && state.liq.conn === 'open' && !document.hidden) {
        state.liq.seen = Date.now();
        saveLiq();
      }
    }, 4000);
    setInterval(function () { loadSide(state.gen); }, 20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
