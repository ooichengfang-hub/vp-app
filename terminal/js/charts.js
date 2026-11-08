'use strict';
/**
 * 四块图共用一根时间轴。K 线组件是 TradingView Lightweight Charts 4.2.3（Apache-2.0）。
 * 画线和强平留白是本页自己的，不从别的网站抠图。
 */
(function (root) {
  const LW = function () { return root.LightweightCharts; };
  const M = function () { return root.ATU_MARKET; };

  function mount(els, opts) {
    const lib = LW();
    if (!lib) throw new Error('缺少 Lightweight Charts');
    const market = M();
    const host = {
      price: els.price,
      volume: els.volume,
      delta: els.delta,
      liq: els.liq
    };
    const overlays = { draw: els.draw, hatch: els.hatch };
    const charts = {};
    const series = {};
    let bars = [];
    let smaPeriod = 20;
    let buckets = [];
    let drawings = [];
    let selected = null;
    let tool = 'cross';
    let pending = null;
    let preview = null;
    let focusCb = function () {};
    let drawCb = function () {};
    let lockRange = false;
    let lockCross = false;
    let painted = 0;
    const panesOn = Object.assign({ volume: true, delta: true, liq: true }, opts && opts.panes);
    const UP = '#3dd68c';
    const DOWN = '#ff5d73';
    const MA = '#e6c35c';
    const BG = '#0a0d12';
    const GRID = 'rgba(255,255,255,0.045)';
    const AXIS = '#8e9aab';
    const BORDER = '#243041';

    function baseOpts(logo) {
      return {
        autoSize: true,
        layout: {
          background: { type: lib.ColorType.Solid, color: BG },
          textColor: AXIS,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          fontSize: 11,
          attributionLogo: !!logo
        },
        grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
        crosshair: {
          mode: lib.CrosshairMode.Normal,
          vertLine: { color: 'rgba(255,255,255,0.28)', width: 1, labelBackgroundColor: '#243041' },
          horzLine: { color: 'rgba(255,255,255,0.28)', width: 1, labelBackgroundColor: '#243041' }
        },
        rightPriceScale: { borderColor: BORDER, minimumWidth: 78, scaleMargins: { top: 0.12, bottom: 0.12 } },
        localization: {
          timeFormatter: function (t) { return market.fmtTime(typeof t === 'number' ? t : 0); }
        },
        timeScale: {
          borderColor: BORDER,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
          barSpacing: 8,
          minBarSpacing: 2,
          shiftVisibleRangeOnNewBar: true
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
      };
    }
    function includeZero(original) {
      const info = original();
      if (!info || !info.priceRange) return info;
      return {
        priceRange: {
          minValue: Math.min(0, info.priceRange.minValue),
          maxValue: Math.max(0, info.priceRange.maxValue)
        }
      };
    }
    function compactFormat() {
      return { type: 'custom', minMove: 0.01, formatter: function (n) { return market.fmtCompact(n); } };
    }
    function destroyChart(name) {
      if (charts[name]) {
        charts[name].remove();
        delete charts[name];
      }
      Object.keys(series).forEach(function (k) { if (k.indexOf(name) === 0) delete series[k]; });
    }
    function wireRange(chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
        if (lockRange || !range) return;
        lockRange = true;
        try {
          Object.keys(charts).forEach(function (name) {
            if (charts[name] !== chart) charts[name].timeScale().setVisibleLogicalRange(range);
          });
        } finally { lockRange = false; }
        paintOverlays();
      });
    }
    function wireCross(name, chart, ser) {
      chart.subscribeCrosshairMove(function (param) {
        if (lockCross) return;
        const time = param && param.time != null ? param.time : null;
        lockCross = true;
        try {
          Object.keys(charts).forEach(function (other) {
            if (other === name || !charts[other] || !series[other + 'Main']) return;
            try {
              if (time == null) charts[other].clearCrosshairPosition();
              else charts[other].setCrosshairPosition(valueAt(other, time), time, series[other + 'Main']);
            } catch (e) { /* 该窗没有这根柱时十字线留在有数据的窗上 */ }
          });
        } finally { lockCross = false; }
        if (tool === 't' && pending && param && param.point) {
          preview = pointFrom(param);
        }
        focusCb(time);
        paintOverlays();
      });
    }
    function valueAt(name, time) {
      if (name === 'price') {
        const b = barAt(time);
        return b ? b.close : 0;
      }
      if (name === 'volume') {
        const b = barAt(time);
        return b ? b.quote : 0;
      }
      if (name === 'delta') {
        const b = barAt(time);
        return b ? b.delta : 0;
      }
      const bucket = bucketAt(time);
      if (!bucket) return 0;
      return (bucket.short || 0) - (bucket.long || 0);
    }
    function barAt(time) {
      let lo = 0, hi = bars.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid].time === time) return bars[mid];
        if (bars[mid].time < time) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    }
    function bucketAt(time) {
      for (let i = 0; i < buckets.length; i++) if (buckets[i].ts === time) return buckets[i];
      return null;
    }
    function indexOfTime(time) {
      let lo = 0, hi = bars.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid].time === time) return mid;
        if (bars[mid].time < time) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    }
    function ensurePrice() {
      if (charts.price) return;
      const chart = lib.createChart(host.price, baseOpts(true));
      charts.price = chart;
      series.priceMain = chart.addCandlestickSeries({
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: UP, wickDownColor: DOWN, priceLineVisible: true, lastValueVisible: true
      });
      wireRange(chart);
      wireCross('price', chart, series.priceMain);
      chart.subscribeClick(onPriceClick);
      host.price.addEventListener('pointermove', schedulePaint);
      host.price.addEventListener('wheel', schedulePaint, { passive: true });
    }
    function ensureVolume() {
      if (charts.volume || host.volume.hidden) return;
      const chart = lib.createChart(host.volume, baseOpts(false));
      charts.volume = chart;
      series.volumeMain = chart.addHistogramSeries({
        priceFormat: compactFormat(), priceLineVisible: false, lastValueVisible: false
      });
      series.volumeMa = chart.addLineSeries({
        color: MA, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, priceFormat: compactFormat()
      });
      wireRange(chart);
      wireCross('volume', chart, series.volumeMain);
    }
    function ensureDelta() {
      if (charts.delta || host.delta.hidden) return;
      const chart = lib.createChart(host.delta, baseOpts(false));
      charts.delta = chart;
      series.deltaMain = chart.addHistogramSeries({
        priceFormat: compactFormat(), priceLineVisible: false, lastValueVisible: false,
        autoscaleInfoProvider: includeZero
      });
      wireRange(chart);
      wireCross('delta', chart, series.deltaMain);
    }
    function ensureLiq() {
      if (charts.liq || host.liq.hidden) return;
      const chart = lib.createChart(host.liq, baseOpts(false));
      charts.liq = chart;
      series.liqMain = chart.addHistogramSeries({
        priceFormat: compactFormat(), priceLineVisible: false, lastValueVisible: false,
        autoscaleInfoProvider: includeZero
      });
      series.liqLong = chart.addHistogramSeries({
        priceFormat: compactFormat(), priceLineVisible: false, lastValueVisible: false,
        autoscaleInfoProvider: includeZero
      });
      wireRange(chart);
      wireCross('liq', chart, series.liqMain);
    }
    function timeScaleHost() {
      if (charts.liq && !host.liq.hidden) return 'liq';
      if (charts.delta && !host.delta.hidden) return 'delta';
      if (charts.volume && !host.volume.hidden) return 'volume';
      return 'price';
    }
    function updateTimeAxes() {
      const bottom = timeScaleHost();
      Object.keys(charts).forEach(function (name) {
        charts[name].timeScale().applyOptions({ visible: name === bottom });
      });
    }
    function applyPrecision() {
      if (!series.priceMain || !bars.length) return;
      const p = market.pricePrecision(bars[bars.length - 1].close);
      series.priceMain.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: Math.pow(10, -p) } });
    }
    function candleData() {
      return bars.map(function (b) { return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }; });
    }
    function volumeData() {
      return bars.map(function (b) {
        return { time: b.time, value: b.quote, color: b.close >= b.open ? 'rgba(61,214,140,0.75)' : 'rgba(255,93,115,0.75)' };
      });
    }
    function maData() {
      const values = market.sma(bars.map(function (b) { return b.quote; }), smaPeriod);
      const out = [];
      for (let i = 0; i < bars.length; i++) if (values[i] != null) out.push({ time: bars[i].time, value: values[i] });
      return out;
    }
    function deltaData() {
      return bars.map(function (b) {
        return { time: b.time, value: b.delta, color: b.delta >= 0 ? UP : DOWN };
      });
    }
    function pushMarket(resetRange) {
      ensurePrice();
      if (!host.volume.hidden) ensureVolume();
      if (!host.delta.hidden) ensureDelta();
      const range = charts.price ? charts.price.timeScale().getVisibleLogicalRange() : null;
      if (series.priceMain) series.priceMain.setData(candleData());
      if (series.volumeMain) {
        series.volumeMain.setData(volumeData());
        series.volumeMa.setData(maData());
      }
      if (series.deltaMain) series.deltaMain.setData(deltaData());
      applyPrecision();
      painted = bars.length;
      if (resetRange) initialRange();
      else if (range && charts.price) charts.price.timeScale().setVisibleLogicalRange(range);
      updateTimeAxes();
      paintOverlays();
    }
    function patchLast() {
      if (!bars.length || !series.priceMain || painted === 0) {
        pushMarket(painted === 0);
        return;
      }
      const b = bars[bars.length - 1];
      try {
        series.priceMain.update({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
        if (series.volumeMain) {
          series.volumeMain.update({ time: b.time, value: b.quote, color: b.close >= b.open ? 'rgba(61,214,140,0.75)' : 'rgba(255,93,115,0.75)' });
          const ma = market.sma(bars.map(function (x) { return x.quote; }), smaPeriod);
          const last = ma[ma.length - 1];
          if (last != null && series.volumeMa) series.volumeMa.update({ time: b.time, value: last });
        }
        if (series.deltaMain) series.deltaMain.update({ time: b.time, value: b.delta, color: b.delta >= 0 ? UP : DOWN });
        painted = bars.length;
        applyPrecision();
      } catch (e) {
        pushMarket(false);
      }
    }
    function pushLiq() {
      if (host.liq.hidden) return;
      ensureLiq();
      const plot = market.liqPlot(buckets);
      if (series.liqLong) series.liqLong.setData(plot.longs);
      if (series.liqMain) series.liqMain.setData(plot.shorts);
      const range = charts.price && charts.price.timeScale().getVisibleLogicalRange();
      if (range && charts.liq) charts.liq.timeScale().setVisibleLogicalRange(range);
      updateTimeAxes();
      paintOverlays();
    }
    function initialRange() {
      if (!charts.price || !bars.length) return;
      const n = bars.length;
      const visible = Math.min(n, n < 8 ? n + 8 : 90);
      const spacing = n < 8 ? 26 : 8;
      Object.keys(charts).forEach(function (name) {
        charts[name].timeScale().applyOptions({ barSpacing: spacing });
      });
      charts.price.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - visible), to: n + 3 });
    }
    function hidePane(name, on) {
      const pane = host[name] && host[name].closest('.pane');
      if (pane) pane.hidden = !on;
      host[name].hidden = !on;
    }
    function setPane(name, on) {
      if (name === 'price') return;
      hidePane(name, on);
      if (!on) destroyChart(name);
      else {
        if (name === 'volume') ensureVolume();
        if (name === 'delta') ensureDelta();
        if (name === 'liq') ensureLiq();
        pushMarket(false);
        if (name === 'liq') pushLiq();
      }
      updateTimeAxes();
    }
    function pointFrom(param) {
      if (!param || !param.point || !series.priceMain || !charts.price) return null;
      const price = series.priceMain.coordinateToPrice(param.point.y);
      let time = param.time != null ? param.time : charts.price.timeScale().coordinateToTime(param.point.x);
      if (typeof time === 'object' && time) return null;
      if (!(price > 0) || !(time > 0)) return null;
      return { time: time, price: price };
    }
    function onPriceClick(param) {
      const pt = pointFrom(param);
      if (!pt) return;
      if (tool === 'h') {
        drawings.push({ id: nid(), type: 'h', price: pt.price });
        selected = drawings[drawings.length - 1].id;
        drawCb(drawings.slice());
        paintOverlays();
        return;
      }
      if (tool === 't') {
        if (!pending) {
          pending = pt;
          preview = pt;
        } else {
          if (pending.time !== pt.time || pending.price !== pt.price) {
            drawings.push({ id: nid(), type: 't', t1: pending.time, p1: pending.price, t2: pt.time, p2: pt.price });
            selected = drawings[drawings.length - 1].id;
            drawCb(drawings.slice());
          }
          pending = null;
          preview = null;
        }
        paintOverlays();
        return;
      }
      selected = hitTest(param.point.x, param.point.y);
      paintOverlays();
    }
    function nid() {
      return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    function xOfTime(time) {
      if (!charts.price || !bars.length) return null;
      const direct = charts.price.timeScale().timeToCoordinate(time);
      if (direct != null) return direct;
      const step = bars.length > 1 ? (bars[bars.length - 1].time - bars[0].time) / (bars.length - 1) : 3600;
      if (!(step > 0)) return null;
      let logical;
      if (time <= bars[0].time) logical = (time - bars[0].time) / (bars.length > 1 ? bars[1].time - bars[0].time : step);
      else if (time >= bars[bars.length - 1].time) {
        const lastStep = bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : step;
        logical = (bars.length - 1) + (time - bars[bars.length - 1].time) / lastStep;
      } else {
        const i = indexNear(time);
        const a = bars[i], b = bars[i + 1] || a;
        const span = b.time - a.time || 1;
        logical = i + (time - a.time) / span;
      }
      return charts.price.timeScale().logicalToCoordinate(logical);
    }
    function indexNear(time) {
      let lo = 0, hi = bars.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid].time <= time) lo = mid; else hi = mid;
      }
      return lo;
    }
    function yOfPrice(price) {
      if (!series.priceMain) return null;
      return series.priceMain.priceToCoordinate(price);
    }
    function paintOverlays() {
      paintDraw();
      paintHatch();
    }
    let paintQueued = false;
    function schedulePaint() {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(function () { paintQueued = false; paintOverlays(); });
    }
    function sizeCanvas(canvas) {
      if (!canvas) return null;
      const dpr = root.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!(w > 0) || !(h > 0)) return null;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      return { ctx: ctx, w: w, h: h };
    }
    function paintDraw() {
      const box = sizeCanvas(overlays.draw);
      if (!box) return;
      const ctx = box.ctx;
      drawings.forEach(function (d) { strokeDrawing(ctx, d, d.id === selected, box.w); });
      if (pending && preview) {
        strokeDrawing(ctx, { type: 't', t1: pending.time, p1: pending.price, t2: preview.time, p2: preview.price }, false, box.w, true);
      }
    }
    function strokeDrawing(ctx, d, on, width, draft) {
      ctx.save();
      ctx.strokeStyle = on ? '#ffffff' : '#8eb6ff';
      ctx.fillStyle = on ? '#ffffff' : '#8eb6ff';
      ctx.lineWidth = on ? 2.5 : 2;
      ctx.setLineDash(draft ? [4, 4] : []);
      if (d.type === 'h') {
        const y = yOfPrice(d.price);
        if (y == null) { ctx.restore(); return; }
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.font = '11px sans-serif';
        ctx.fillText(market.fmtPx(d.price), 8, Math.max(12, y - 4));
      } else if (d.type === 't') {
        const x1 = xOfTime(d.t1), y1 = yOfPrice(d.p1), x2 = xOfTime(d.t2), y2 = yOfPrice(d.p2);
        if (x1 == null || y1 == null || x2 == null || y2 == null) { ctx.restore(); return; }
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x1, y1, 3, 0, Math.PI * 2);
        ctx.arc(x2, y2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    function paintHatch() {
      const box = sizeCanvas(overlays.hatch);
      if (!box || !charts.liq) return;
      const ctx = box.ctx;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.status !== 'gap' && b.status !== 'partial' && b.status !== 'open') continue;
        const x1 = charts.liq.timeScale().logicalToCoordinate(i - 0.45);
        const x2 = charts.liq.timeScale().logicalToCoordinate(i + 0.45);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2);
        const width = Math.max(1, Math.abs(x2 - x1));
        if (b.status === 'gap') {
          ctx.fillStyle = 'rgba(230,195,92,0.07)';
          ctx.fillRect(left, 0, width, box.h);
          ctx.strokeStyle = 'rgba(230,195,92,0.4)';
          ctx.beginPath();
          const step = 7;
          for (let y = -width; y < box.h; y += step) {
            ctx.moveTo(left, y);
            ctx.lineTo(left + width, y + width);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(230,195,92,0.9)';
          ctx.fillRect(left, 0, width, 2);
        }
      }
    }
    function distToSeg(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const len = dx * dx + dy * dy;
      if (!(len > 0)) return Math.hypot(px - x1, py - y1);
      let t = ((px - x1) * dx + (py - y1) * dy) / len;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    function hitTest(x, y) {
      for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i];
        if (d.type === 'h') {
          const yy = yOfPrice(d.price);
          if (yy != null && Math.abs(yy - y) <= 8) return d.id;
        } else if (d.type === 't') {
          const x1 = xOfTime(d.t1), y1 = yOfPrice(d.p1), x2 = xOfTime(d.t2), y2 = yOfPrice(d.p2);
          if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
          if (distToSeg(x, y, x1, y1, x2, y2) <= 8) return d.id;
        }
      }
      return null;
    }
    function setTool(next) {
      tool = next === 'h' || next === 't' ? next : 'cross';
      if (tool !== 't') { pending = null; preview = null; }
      if (charts.price) {
        const drawing = tool !== 'cross';
        charts.price.applyOptions({
          handleScroll: { mouseWheel: true, pressedMouseMove: !drawing, horzTouchDrag: !drawing, vertTouchDrag: false }
        });
      }
      paintOverlays();
      return tool;
    }

    ensurePrice();
    hidePane('volume', !!panesOn.volume);
    hidePane('delta', !!panesOn.delta);
    hidePane('liq', !!panesOn.liq);
    if (panesOn.volume) ensureVolume();
    if (panesOn.delta) ensureDelta();
    if (panesOn.liq) ensureLiq();
    updateTimeAxes();
    root.addEventListener('resize', schedulePaint);

    return {
      setMarket: function (next, period, resetRange) {
        bars = next || [];
        if (period >= 2) smaPeriod = period | 0;
        pushMarket(!!resetRange);
      },
      patchLast: function (next, period) {
        bars = next || [];
        if (period >= 2) smaPeriod = period | 0;
        patchLast();
      },
      setSma: function (period) {
        smaPeriod = period | 0;
        if (series.volumeMa) series.volumeMa.setData(maData());
      },
      setLiq: function (next) {
        buckets = next || [];
        pushLiq();
      },
      setPane: setPane,
      setTool: setTool,
      getTool: function () { return tool; },
      setDrawings: function (list) {
        drawings = market.sanitizeDrawings(list);
        selected = null;
        pending = null;
        paintOverlays();
      },
      getDrawings: function () { return drawings.map(function (d) { return Object.assign({}, d); }); },
      deleteSelected: function () {
        if (selected) {
          drawings = drawings.filter(function (d) { return d.id !== selected; });
          selected = null;
        } else if (drawings.length) drawings.pop();
        drawCb(drawings.slice());
        paintOverlays();
      },
      clearDrawings: function () {
        drawings = [];
        selected = null;
        pending = null;
        drawCb(drawings.slice());
        paintOverlays();
      },
      onFocus: function (fn) { focusCb = fn || focusCb; },
      onDrawings: function (fn) { drawCb = fn || drawCb; },
      barAt: barAt,
      bucketAt: bucketAt
    };
  }

  root.ATU_CHARTS = { mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
