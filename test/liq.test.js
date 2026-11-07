'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LIQ = require('../liq.js');

const SRC = 'Binance BTCUSDT · 官方快照 · 非完整总量';

function msg(o, extra) {
  return Object.assign({ e: 'forceOrder', E: extra && extra.E != null ? extra.E : (o.T || 1_700_000_000_000) }, extra || {}, {
    o: Object.assign({ s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '1', p: '100', ap: '100', X: 'FILLED', l: '1', z: '1', T: 1_700_000_000_000 }, o || {})
  });
}
function state(now) {
  const s = LIQ.emptyState(now || 1_700_000_000_000);
  return s;
}
function cover(s, a, b) {
  LIQ.coverOpen(s, a);
  if (b != null) LIQ.coverClose(s, b);
}

test('source label and stream url stay the documented public market path', () => {
  assert.equal(LIQ.SOURCE_LABEL, SRC);
  assert.equal(LIQ.LIQ_URL, 'wss://fstream.binance.com/market/ws/btcusdt@forceOrder');
});

test('zero events while covered is observed zero, not a missing range', () => {
  const s = state();
  const t0 = 1_700_000_000_000;
  cover(s, t0, t0 + 3600_000);
  const b = LIQ.bucket(s, t0, t0 + 300_000, t0 + 3600_000);
  assert.equal(b.status, 'zero');
  assert.equal(b.long, 0);
  assert.equal(b.short, 0);
  assert.equal(b.n, 0);
});

test('no coverage and no events stays blank (missing), never a backfilled zero', () => {
  const s = state();
  const t0 = 1_700_000_000_000;
  const b = LIQ.bucket(s, t0, t0 + 300_000, t0 + 3600_000);
  assert.equal(b.status, 'missing');
  assert.equal(b.long + b.short, 0);
});

test('SELL is long liquidation and BUY is short, notional is z*ap only', () => {
  const s = state();
  const t = 1_700_000_100_000;
  const sell = LIQ.ingest(s, msg({ S: 'SELL', z: '1.5', ap: '200', q: '9', p: '10', l: '9', T: t }, { E: t }), t);
  const buy = LIQ.ingest(s, msg({ S: 'BUY', z: '0.25', ap: '400', q: '8', p: '1', l: '8', T: t + 10 }, { E: t + 10 }), t + 10);
  assert.equal(sell.action, 'new');
  assert.equal(sell.side, 'L');
  assert.equal(sell.added, 300);
  assert.equal(buy.side, 'S');
  assert.equal(buy.added, 100);
  assert.equal(s.events.length, 2);
  cover(s, t - 1000, t + 300_000);
  const b = LIQ.bucket(s, t - (t % 300_000), t - (t % 300_000) + 300_000, t + 300_000);
  assert.equal(b.long, 300);
  assert.equal(b.short, 100);
  assert.notEqual(b.long, 9 * 10);
  assert.notEqual(b.short, 8 * 1);
});

test('unexecuted or missing average fill is ignored; q*p is never a fallback', () => {
  const s = state();
  const t = 1_700_000_200_000;
  const z0 = LIQ.ingest(s, msg({ z: '0', ap: '100', q: '10', p: '100', l: '0', T: t }, { E: t }), t);
  const noAp = LIQ.ingest(s, msg({ z: '2', ap: '', q: '2', p: '50', T: t + 1 }, { E: t + 1 }), t + 1);
  const badAp = LIQ.ingest(s, msg({ z: '2', ap: '0', q: '2', p: '50', T: t + 2 }, { E: t + 2 }), t + 2);
  const noZ = LIQ.ingest(s, msg({ z: '', ap: '50', q: '3', p: '50', l: '3', T: t + 3 }, { E: t + 3 }), t + 3);
  assert.equal(z0.reason, 'z');
  assert.equal(noAp.reason, 'ap');
  assert.equal(badAp.reason, 'ap');
  assert.equal(noZ.reason, 'z');
  assert.equal(s.events.length, 0);
  const ok = LIQ.ingest(s, msg({ z: '0.5', ap: '200', q: '10', p: '100', T: t + 4 }, { E: t + 4 }), t + 4);
  assert.equal(ok.added, 100);
  assert.notEqual(ok.added, 1000);
});

test('string z/ap are accepted and a wrapped combined-stream frame is accepted', () => {
  const s = state();
  const t = 1_700_000_300_000;
  const wrapped = { stream: 'btcusdt@forceOrder', data: msg({ z: '0.01', ap: '64000.5', T: t }, { E: t }) };
  const r = LIQ.ingest(s, JSON.stringify(wrapped), t);
  assert.equal(r.ok, true);
  assert.equal(r.added, 0.01 * 64000.5);
});

test('exact duplicate snapshot adds nothing', () => {
  const s = state();
  const t = 1_700_000_400_000;
  const m = msg({ z: '0.2', ap: '100000', q: '0.2', p: '99000', T: t }, { E: t });
  assert.equal(LIQ.ingest(s, m, t).added, 20000);
  const dup = LIQ.ingest(s, m, t + 200);
  assert.equal(dup.action, 'duplicate');
  assert.equal(dup.added, 0);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].usd, 20000);
});

test('cumulative snapshot within 5s adds only the increase in z*ap', () => {
  const s = state();
  const t = 1_700_000_500_000;
  LIQ.ingest(s, msg({ z: '1', ap: '100', q: '5', p: '90', T: t }, { E: t }), t);
  const more = LIQ.ingest(s, msg({ z: '2.5', ap: '100', q: '5', p: '90', T: t + 1000 }, { E: t + 1000 }), t + 1000);
  assert.equal(more.action, 'continuation');
  assert.equal(more.added, 150);
  const same = LIQ.ingest(s, msg({ z: '2.5', ap: '100', q: '5', p: '90', T: t + 1000 }, { E: t + 1200 }), t + 1200);
  assert.equal(same.action, 'duplicate');
  const again = LIQ.ingest(s, msg({ z: '4', ap: '110', q: '5', p: '90', T: t + 2000 }, { E: t + 2000 }), t + 2000);
  assert.equal(again.action, 'continuation');
  assert.equal(again.added, 4 * 110 - 2.5 * 100);
  assert.equal(s.events.reduce((a, e) => a + e.usd, 0), 4 * 110);
});

test('average-price revision that lowers notional does not invent a negative print', () => {
  const s = state();
  const t = 1_700_000_600_000;
  LIQ.ingest(s, msg({ z: '2', ap: '100', q: '2', p: '100', T: t }, { E: t }), t);
  const rev = LIQ.ingest(s, msg({ z: '2', ap: '40', q: '2', p: '100', T: t + 500 }, { E: t + 500 }), t + 500);
  assert.equal(rev.action, 'revision');
  assert.equal(rev.added, 0);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].usd, 200);
});

test('same order after the 5s window is not glued together with an invented id', () => {
  const s = state();
  const t = 1_700_000_700_000;
  LIQ.ingest(s, msg({ z: '1', ap: '100', q: '3', p: '80', T: t }, { E: t }), t);
  const late = LIQ.ingest(s, msg({ z: '2', ap: '100', q: '3', p: '80', T: t + 6000 }, { E: t + 6000 }), t + 6000);
  assert.equal(late.action, 'new');
  assert.equal(late.added, 200);
  assert.equal(s.events.reduce((a, e) => a + e.usd, 0), 300);
});

test('a disconnect gap is not a zero, and a fast cumulative update still only adds the delta', () => {
  const s = state();
  const t0 = 1_700_000_800_000;
  LIQ.coverOpen(s, t0);
  LIQ.ingest(s, msg({ z: '1', ap: '50', q: '4', p: '40', T: t0 + 1000 }, { E: t0 + 1000 }), t0 + 1000);
  LIQ.coverClose(s, t0 + 10_000);
  LIQ.coverOpen(s, t0 + 20_000);
  const cont = LIQ.ingest(s, msg({ z: '1.5', ap: '50', q: '4', p: '40', T: t0 + 2000 }, { E: t0 + 2000 }), t0 + 21_000);
  assert.equal(cont.action, 'continuation');
  assert.equal(cont.added, 25);
  const hole = LIQ.bucket(s, t0 + 10_000, t0 + 20_000, t0 + 30_000);
  assert.equal(hole.status, 'gap');
  assert.equal(hole.n, 0);
  assert.notEqual(hole.status, 'zero');
  const partial = LIQ.bucket(s, t0, t0 + 30_000, t0 + 30_000);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.long, 75);
});

test('covered silence is zero; the open bucket is in progress', () => {
  const s = state();
  const t0 = 1_700_000_900_000;
  LIQ.coverOpen(s, t0);
  const open = LIQ.bucket(s, t0, t0 + 300_000, t0 + 10_000);
  assert.equal(open.status, 'open');
  assert.equal(open.inProgress, true);
  assert.equal(open.long, 0);
  const closed = LIQ.bucket(s, t0 - 300_000, t0, t0 + 10_000);
  assert.equal(closed.status, 'missing');
});

test('replay view hides observations after the replay clock', () => {
  const s = state();
  const base = 1_700_001_000_000;
  LIQ.coverOpen(s, base);
  LIQ.ingest(s, msg({ S: 'SELL', z: '1', ap: '10', q: '1', p: '10', T: base + 60_000 }, { E: base + 60_000 }), base + 60_000);
  LIQ.ingest(s, msg({ S: 'BUY', z: '9', ap: '10', q: '9', p: '10', T: base + 400_000 }, { E: base + 400_000 }), base + 400_000);
  const replayAt = base + 120_000;
  const cur = LIQ.bucket(s, base, base + 300_000, replayAt);
  assert.equal(cur.long, 10);
  assert.equal(cur.short, 0);
  assert.equal(cur.status, 'open');
  const later = LIQ.bucket(s, base + 300_000, base + 600_000, replayAt);
  assert.equal(later.status, 'future');
  assert.equal(later.short, 0);
  const live = LIQ.bucket(s, base, base + 600_000, base + 600_000);
  assert.equal(live.long, 10);
  assert.equal(live.short, 90);
});

test('5m buckets and the 1H bucket share one observation log', () => {
  const s = state();
  const hour = 1_700_002_000_000;
  LIQ.coverOpen(s, hour);
  LIQ.coverClose(s, hour + 3_600_000);
  const stamps = [hour + 60_000, hour + 300_000 + 1000, hour + 900_000];
  stamps.forEach((t, i) => {
    LIQ.ingest(s, msg({ S: i === 1 ? 'BUY' : 'SELL', z: '1', ap: String(100 * (i + 1)), q: String(i + 1), p: '10', T: t }, { E: t }), t);
  });
  const five = LIQ.series(s, [0, 300, 600, 900].map(sec => (hour + sec * 1000) / 1000), 300, hour + 3_600_000);
  assert.equal(five[0].long, 100);
  assert.equal(five[0].short, 0);
  assert.equal(five[1].short, 200);
  assert.equal(five[1].long, 0);
  assert.equal(five[2].status, 'zero');
  assert.equal(five[3].long, 300);
  const hourBucket = LIQ.bucket(s, hour, hour + 3_600_000, hour + 3_600_000);
  assert.equal(hourBucket.long, 400);
  assert.equal(hourBucket.short, 200);
  assert.equal(hourBucket.status, 'value');
});

test('persistence round-trip trims bounds and does not extend coverage across a closed browser', () => {
  const s = state(1_700_003_000_000);
  s.startedAt = 1_700_003_000_000;
  LIQ.coverOpen(s, 1_700_003_000_000);
  LIQ.ingest(s, msg({ z: '1', ap: '5', q: '1', p: '5', T: 1_700_003_010_000 }, { E: 1_700_003_010_000 }), 1_700_003_010_000);
  const raw = LIQ.serialize(s);
  raw.seen = 1_700_003_020_000;
  const later = 1_700_003_020_000 + 60_000;
  const back = LIQ.hydrate(raw, later);
  assert.equal(back.events.length, 1);
  assert.equal(back.events[0].usd, 5);
  assert.equal(back.open, null);
  assert.equal(back.conn, 'down');
  assert.equal(back.startedAt, s.startedAt);
  assert.ok(back.spans.some(sp => sp.a === 1_700_003_000_000 && sp.b === 1_700_003_020_000));
  const gap = LIQ.bucket(back, 1_700_003_020_000, 1_700_003_080_000, later);
  assert.equal(gap.status, 'gap');
  assert.notEqual(gap.status, 'zero');
  const kept = LIQ.bucket(back, 1_700_003_000_000, 1_700_003_020_000, later);
  assert.equal(kept.long, 5);
  assert.equal(kept.status, 'value');
  const stuffed = LIQ.emptyState(10_000_000);
  for (let i = 0; i < LIQ.MAX_EVENTS + 25; i++) stuffed.events.push({ t: 10_000_000 - i, side: i % 2 ? 'L' : 'S', usd: 1 });
  stuffed.events.reverse();
  LIQ.trim(stuffed, 10_000_000);
  assert.equal(stuffed.events.length, LIQ.MAX_EVENTS);
  const old = LIQ.emptyState(LIQ.MAX_AGE_MS + 5_000);
  old.events.push({ t: 1000, side: 'L', usd: 9 });
  old.spans.push({ a: 1000, b: 2000 });
  LIQ.trim(old, LIQ.MAX_AGE_MS + 5_000);
  assert.equal(old.events.length, 0);
  assert.equal(old.spans.length, 0);
});

test('bad payloads and the wrong symbol do not throw or change state', () => {
  const s = state();
  const before = JSON.stringify(LIQ.serialize(s));
  for (const m of ['{', '', null, 4, { e: 'kline' }, { e: 'forceOrder' }, { e: 'forceOrder', o: { s: 'ETHUSDT', S: 'SELL', z: '1', ap: '1', q: '1', p: '1', T: 10 } }, { e: 'forceOrder', o: { s: 'BTCUSDT', S: 'HOLD', z: '1', ap: '1' } }]) {
    const r = LIQ.ingest(s, m, 10);
    assert.equal(r.ok, false);
    assert.equal(r.changed, false);
  }
  assert.equal(JSON.stringify(LIQ.serialize(s)), before);
});

test('reconnect backoff grows and stays capped', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8].map(LIQ.backoffMs);
  for (let i = 1; i < 5; i++) assert.ok(a[i] > a[i - 1]);
  assert.ok(a[0] >= 1000 && a[0] < 1300);
  assert.ok(a[5] >= 30000 && a[7] >= 30000);
  assert.ok(a.every(n => n > 0 && n <= 36000));
});
