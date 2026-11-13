import assert from 'node:assert/strict';
import test from 'node:test';
import { stepSpring } from '../lib/spring.js';
test('spring compresses, rebounds past rest, then settles without changing layout', () => {
  let p = 1,
    v = 0;
  for (let i = 0; i < 12; i++) {
    const r = stepSpring(p, v, 0.93, 1 / 120);
    p = r.position;
    v = r.velocity;
  }
  assert.ok(p < 0.96);
  let peak = 0,
    last;
  for (let i = 0; i < 240; i++) {
    last = stepSpring(p, v, 1, 1 / 120);
    p = last.position;
    v = last.velocity;
    peak = Math.max(peak, p);
  }
  assert.ok(peak > 1.001);
  assert.ok(last.settled);
  assert.ok(Math.abs(p - 1) < 0.001);
});
test('large resumed-frame elapsed cannot explode spring state', () => {
  const r = stepSpring(0.93, 0, 1, 300);
  assert.ok(Number.isFinite(r.position) && r.position > 0.9 && r.position < 1.1);
});
