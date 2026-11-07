'use strict';
/**
 * 币安 U 本位 BTCUSDT 公开强平快照（forceOrder）的观察记账。
 *
 * 连接（不需要 API Key），2026-04-23 起市场流走 /market：
 *   wss://fstream.binance.com/market/ws/btcusdt@forceOrder
 * 文档：
 *   https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams
 *   https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice
 * 更新日志 2026-04-10，2026-04-14 生效：每个品种在 1000ms 内只推送「最大的一笔」强平
 * （在此之前文档写的是「最新的一笔」）。2021-04-27 起这条流就不是逐笔，而是最多每秒一条快照。
 * 快照没有订单号。这里不编造订单号，也不把观察到的金额说成全市场清算总量。
 *
 * SELL = 多头被强平（被迫卖出）。BUY = 空头被强平（被迫买入）。
 * 观察到的 USDT = 已成交数量 z × 成交均价 ap。未成交数量忽略。绝不用 q×p 当金额。
 *
 * 同一快照（静态字段相同、z 与 ap 没变、时间靠近）记 0。
 * 像是同一笔 IOC 订单的累计成交（z 变大、5 秒内、价格和委托量没变）只加 z×ap 的增量。
 * 超过 5 秒、或委托量/价格变了、或 z 变小，都按新快照把整段 z×ap 加上。
 * 这样会漏掉「碰巧同价同量」的新订单，也会在断线超过 5 秒后把同一笔的累计成交再加一次。
 * 两种偏差都比假装有订单号要诚实，图上仍然不能当成完整总量。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.LIQ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIQ_URL = 'wss://fstream.binance.com/market/ws/btcusdt@forceOrder';
  const LIQ_SYMBOL = 'BTCUSDT';
  const SOURCE_LABEL = 'Binance BTCUSDT · 官方快照 · 非完整总量';
  const CONT_MS = 5000;
  const MAX_EVENTS = 20000;
  const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const Q_EPS = 1e-12;
  const P_EPS = 1e-8;
  const COVER_EPS = 50;

  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function same(a, b, eps) {
    if (a == null && b == null) return true;
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return false;
    return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
  }
  function lower(ev, t) {
    let l = 0, h = ev.length;
    while (l < h) { const m = (l + h) >> 1; if (ev[m].t < t) l = m + 1; else h = m; }
    return l;
  }
  function emptyState(now) {
    return { v: 1, events: [], spans: [], open: null, startedAt: now || 0, seen: now || 0, last: null, conn: 'down', ver: 0 };
  }
  function unwrap(msg) {
    if (msg == null) return { error: 'empty' };
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (e) { return { error: 'json' }; }
    }
    if (typeof msg !== 'object') return { error: 'type' };
    if (msg.data && typeof msg.data === 'object' && (msg.data.e === 'forceOrder' || msg.data.o)) return msg.data;
    return msg;
  }
  function parseSnap(msg, nowMs) {
    const m = unwrap(msg);
    if (!m || m.error) return { ok: false, reason: (m && m.error) || 'empty' };
    if (m.e && m.e !== 'forceOrder') return { ok: false, reason: 'event' };
    const o = m.o;
    if (!o || typeof o !== 'object') return { ok: false, reason: 'shape' };
    const sym = String(o.s || '').toUpperCase();
    if (sym && sym !== LIQ_SYMBOL) return { ok: false, reason: 'symbol' };
    const sideRaw = String(o.S || '').toUpperCase();
    if (sideRaw !== 'SELL' && sideRaw !== 'BUY') return { ok: false, reason: 'side' };
    const z = num(o.z), ap = num(o.ap), q = num(o.q), p = num(o.p);
    if (!(z > 0)) return { ok: false, reason: 'z' };
    if (!(ap > 0)) return { ok: false, reason: 'ap' };
    const E = num(m.E), T = num(o.T);
    const t = finite(T) && T > 0 ? T : (finite(E) && E > 0 ? E : nowMs);
    return {
      ok: true,
      snap: {
        side: sideRaw === 'SELL' ? 'L' : 'S',
        z: z, ap: ap,
        q: finite(q) ? q : null,
        p: finite(p) ? p : null,
        o: o.o != null ? String(o.o) : '',
        f: o.f != null ? String(o.f) : '',
        t: t,
        e: finite(E) ? E : null,
        T: finite(T) ? T : null,
        tSrc: finite(T) && T > 0 ? 'T' : (finite(E) && E > 0 ? 'E' : 'local'),
        usd: z * ap
      }
    };
  }
  function stamp(s) { return s.e != null ? s.e : s.t; }
  function closeInTime(a, b) {
    const dt = stamp(b) - stamp(a);
    if (!(dt >= 0 && dt <= CONT_MS)) return false;
    if (a.T != null && b.T != null && b.T < a.T) return false;
    return true;
  }
  function staticSame(a, b) {
    if (!a || !b || a.side !== b.side || a.o !== b.o || a.f !== b.f) return false;
    if (a.q == null || b.q == null || a.p == null || b.p == null) return false;
    return same(a.q, b.q, Q_EPS) && same(a.p, b.p, P_EPS);
  }
  function trim(state, now) {
    const cut = (now || 0) - MAX_AGE_MS;
    if (cut > 0) state.events = state.events.filter(function (e) { return e.t >= cut; });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    state.spans = mergeSpans(state.spans.filter(function (s) { return s.b > cut; }).map(function (s) { return { a: Math.max(s.a, cut), b: s.b }; }));
  }
  function mergeSpans(spans) {
    const s = spans.slice().sort(function (a, b) { return a.a - b.a; });
    const m = [];
    for (let i = 0; i < s.length; i++) {
      const x = s[i];
      if (!(x.b > x.a)) continue;
      if (!m.length || x.a > m[m.length - 1].b + 1) m.push({ a: x.a, b: x.b });
      else m[m.length - 1].b = Math.max(m[m.length - 1].b, x.b);
    }
    return m;
  }
  function insertEvent(state, ev) {
    const evs = state.events;
    if (!evs.length || ev.t >= evs[evs.length - 1].t) evs.push(ev);
    else evs.splice(lower(evs, ev.t), 0, ev);
  }
  function ingest(state, msg, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const parsed = parseSnap(msg, now);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, changed: false, added: 0 };
    const snap = parsed.snap;
    const last = state.last;
    let action = 'new', added = snap.usd;
    // 没有订单号。只有「委托量、委托价、方向、类型都没变，而且 5 秒内 z 没有变小」才看成同一笔快照的后续。
    if (last && staticSame(last, snap) && closeInTime(last, snap) && snap.z + 1e-9 >= last.z) {
      if (same(last.z, snap.z, Q_EPS) && same(last.ap, snap.ap, P_EPS)) {
        state.last = snap;
        return { ok: true, action: 'duplicate', changed: false, added: 0, side: snap.side, t: snap.t };
      }
      const delta = snap.usd - last.usd;
      state.last = snap;
      if (!(delta > 0)) return { ok: true, action: 'revision', changed: false, added: 0, side: snap.side, t: snap.t };
      action = 'continuation';
      added = delta;
    } else state.last = snap;
    insertEvent(state, { t: snap.t, side: snap.side, usd: added });
    trim(state, now);
    state.ver++;
    state.seen = now;
    return { ok: true, action: action, changed: true, added: added, side: snap.side, t: snap.t };
  }
  function coverOpen(state, now) {
    if (state.open == null) state.open = now;
    state.conn = 'open';
    state.seen = now;
  }
  function coverClose(state, now) {
    if (state.open != null) {
      const a = state.open, b = Math.max(now, a);
      if (b > a) state.spans.push({ a: a, b: b });
      state.open = null;
      trim(state, now);
    }
    state.conn = 'down';
    state.seen = now;
  }
  function insideRecording(state, startMs, endView, view) {
    let a = null;
    for (let i = 0; i < state.spans.length; i++) if (a == null || state.spans[i].a < a) a = state.spans[i].a;
    if (state.open != null && (a == null || state.open < a)) a = state.open;
    if (a == null) return false;
    return endView > a && startMs < view && startMs >= a - COVER_EPS;
  }
  function viewSpans(state, viewNow) {
    const spans = [];
    for (let i = 0; i < state.spans.length; i++) {
      const s = state.spans[i], b = Math.min(s.b, viewNow);
      if (b > s.a) spans.push({ a: s.a, b: b });
    }
    if (state.open != null && state.open < viewNow) spans.push({ a: state.open, b: viewNow });
    return mergeSpans(spans);
  }
  function overlap(spans, a, b) {
    let n = 0;
    for (let i = 0; i < spans.length; i++) {
      const x = Math.max(spans[i].a, a), y = Math.min(spans[i].b, b);
      if (y > x) n += y - x;
    }
    return n;
  }
  function bucket(state, startMs, endMs, viewNowMs) {
    const view = viewNowMs;
    if (!(view > startMs)) return { status: 'future', long: 0, short: 0, inProgress: false, covered: 0, n: 0 };
    const endView = Math.min(endMs, view);
    const inProgress = view < endMs;
    const spans = viewSpans(state, view);
    const covered = overlap(spans, startMs, endView);
    let long = 0, short = 0, n = 0;
    const ev = state.events;
    for (let i = lower(ev, startMs); i < ev.length && ev[i].t < endView; i++) {
      if (ev[i].t > view) break;
      n++;
      if (ev[i].side === 'L') long += ev[i].usd; else short += ev[i].usd;
    }
    const span = endView - startMs;
    const full = covered >= span - COVER_EPS;
    let status;
    if (!full && covered <= 0 && n === 0) status = insideRecording(state, startMs, endView, view) ? 'gap' : 'missing';
    else if (!full && n === 0) status = 'gap';
    else if (!full) status = 'partial';
    else if (inProgress) status = 'open';
    else if (!(long > 0) && !(short > 0)) status = 'zero';
    else status = 'value';
    return { status: status, long: long, short: short, inProgress: inProgress, covered: covered, n: n };
  }
  function series(state, barStartsSec, tfSec, viewNowMs) {
    const S = tfSec * 1000;
    const out = [];
    for (let i = 0; i < barStartsSec.length; i++) {
      const ts = barStartsSec[i];
      const b = bucket(state, ts * 1000, ts * 1000 + S, viewNowMs);
      b.ts = ts;
      out.push(b);
    }
    return out;
  }
  function serialize(state) {
    return { v: 1, events: state.events, spans: state.spans, open: state.open, startedAt: state.startedAt, seen: state.seen, last: state.last };
  }
  function copyLast(last) {
    if (!last || (last.side !== 'L' && last.side !== 'S')) return null;
    if (!(last.z > 0) || !(last.ap > 0)) return null;
    return {
      side: last.side, z: +last.z, ap: +last.ap,
      q: last.q == null ? null : +last.q, p: last.p == null ? null : +last.p,
      o: last.o != null ? String(last.o) : '', f: last.f != null ? String(last.f) : '',
      t: +last.t || 0, e: last.e == null ? null : +last.e, T: last.T == null ? null : +last.T,
      usd: +last.usd || (+last.z * +last.ap)
    };
  }
  function hydrate(raw, now) {
    const s = emptyState(now || 0);
    if (!raw || typeof raw !== 'object') return s;
    if (finite(raw.startedAt) && raw.startedAt > 0) s.startedAt = raw.startedAt;
    if (Array.isArray(raw.events)) {
      s.events = raw.events.filter(function (e) { return e && (e.side === 'L' || e.side === 'S') && e.usd > 0 && e.t > 0; })
        .map(function (e) { return { t: +e.t, side: e.side, usd: +e.usd }; })
        .sort(function (a, b) { return a.t - b.t; });
    }
    if (Array.isArray(raw.spans)) {
      s.spans = raw.spans.filter(function (x) { return x && x.b > x.a; }).map(function (x) { return { a: +x.a, b: +x.b }; });
    }
    // 上次页面如果在记录中被关掉，不能把「关掉之后到这次打开」算成已覆盖。
    // 只信上次成功写下的 seen。浏览器关掉的那段留空。
    if (raw.open != null && finite(+raw.seen) && +raw.seen > +raw.open) s.spans.push({ a: +raw.open, b: +raw.seen });
    s.spans = mergeSpans(s.spans);
    s.last = copyLast(raw.last);
    s.seen = finite(+raw.seen) ? +raw.seen : (now || 0);
    s.open = null;
    s.conn = 'down';
    trim(s, now || Date.now());
    return s;
  }
  function backoffMs(attempt) {
    const n = Math.max(1, attempt | 0);
    const base = Math.min(30000, 1000 * Math.pow(2, Math.min(n - 1, 5)));
    return base + Math.floor(base * ((n * 37) % 20) / 100);
  }
  return {
    LIQ_URL: LIQ_URL, LIQ_SYMBOL: LIQ_SYMBOL, SOURCE_LABEL: SOURCE_LABEL,
    CONT_MS: CONT_MS, MAX_EVENTS: MAX_EVENTS, MAX_AGE_MS: MAX_AGE_MS,
    emptyState: emptyState, parseSnap: parseSnap, ingest: ingest,
    coverOpen: coverOpen, coverClose: coverClose, bucket: bucket, series: series,
    serialize: serialize, hydrate: hydrate, trim: trim, backoffMs: backoffMs, viewSpans: viewSpans
  };
});
