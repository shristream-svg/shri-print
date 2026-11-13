import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const code = await readFile(new URL('../desktop/desktop-ui.js', import.meta.url), 'utf8');
test('desktop skin is isolated; quick taps, cancel, reduced motion and blur settle safely', () => {
  const events = new Map(),
    winEvents = new Map(),
    frames = new Map();
  let id = 0,
    time = 100;
  const classes = [];
  const reduced = { matches: false, addEventListener: (_, f) => (reduced.change = f) };
  class Button {
    constructor() {
      this.isConnected = true;
      this.disabled = false;
      this.values = new Map();
      this.style = {
        setProperty: (k, v) => this.values.set(k, v),
        removeProperty: k => this.values.delete(k),
      };
    }
    closest(s) {
      return s.startsWith('button,') ? this : null;
    }
    matches() {
      return false;
    }
    getAttribute() {
      return null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 50 };
    }
  }
  const scope = {
    window: { addEventListener: (n, f) => winEvents.set(n, f) },
    document: {
      body: {},
      hidden: false,
      documentElement: { dataset: {}, classList: { add: x => classes.push(x) } },
      addEventListener: (n, f) => events.set(n, f),
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    location: { pathname: '/' },
    Element: Button,
    MutationObserver: class {
      observe() {}
    },
    matchMedia: q => (q.includes('reduced') ? reduced : { matches: true }),
    performance: { now: () => time },
    requestAnimationFrame: f => {
      frames.set(++id, f);
      return id;
    },
    cancelAnimationFrame: i => frames.delete(i),
  };
  vm.runInNewContext(code, scope);
  assert.equal(classes.length, 0, 'customer page is never skinned');
  scope.location.pathname = '/admin';
  vm.runInNewContext(code, scope);
  assert.deepEqual(classes, ['desktop-studio']);
  const b = new Button(),
    down = () => events.get('pointerdown')({ target: b, button: 0, pointerId: 7 }),
    run = () => {
      for (let i = 0; i < 500 && frames.size; i++) {
        const fs = [...frames.values()];
        frames.clear();
        time += 1000 / 120;
        fs.forEach(f => f(time));
      }
    };
  down();
  assert.ok(Number(b.values.get('--desk-sy')) < 1, 'fast tap paints before RAF');
  winEvents.get('pointerup')({ pointerId: 7 });
  run();
  assert.equal(b.values.has('--desk-sy'), false);
  assert.equal(frames.size, 0);
  b.disabled = true;
  down();
  assert.equal(frames.size, 0);
  b.disabled = false;
  assert.equal(events.has('keydown'), false);
  down();
  winEvents.get('pointercancel')({ pointerId: 7 });
  run();
  assert.equal(b.values.size, 0);
  down();
  reduced.matches = true;
  reduced.change();
  assert.equal(b.values.size, 0);
  assert.equal(frames.size, 0);
  reduced.matches = false;
  down();
  winEvents.get('blur')();
  assert.equal(b.values.size, 0);
  assert.equal(frames.size, 0);
});
