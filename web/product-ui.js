import { stepSpring } from '../lib/spring.js';
export function initProductUI() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)'),
    precise = matchMedia('(hover:hover) and (pointer:fine)');
  const states = new Map(),
    pointers = new Map();
  let raf = 0,
    last = 0;
  const target = e =>
    e.target instanceof Element ? e.target.closest('button,.button,.csp-service-btn') : null;
  const allowed = b =>
    b && !b.disabled && !b.closest('.desktop-window-controls') && !reduced.matches;
  function state(b) {
    if (!states.has(b))
      states.set(b, { p: 1, v: 0, goal: 1, rx: 0, ry: 0, tx: 0, ty: 0, pressed: false });
    return states.get(b);
  }
  function start() {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }
  function tick(now) {
    raf = 0;
    const dt = (now - last) / 1000;
    last = now;
    let pending = false;
    for (const [b, s] of states) {
      if (!b.isConnected || reduced.matches) {
        b.style.removeProperty('transform');
        states.delete(b);
        continue;
      }
      const r = stepSpring(s.p, s.v, s.goal, dt);
      s.p = r.position;
      s.v = r.velocity;
      s.rx += (s.tx - s.rx) * Math.min(1, dt * 14);
      s.ry += (s.ty - s.ry) * Math.min(1, dt * 14);
      const stretch = 1 + (1 - s.p) * 0.32;
      b.style.transform = `perspective(750px) translate3d(0,${(1 - s.p) * 26}px,0) rotateX(${s.rx}deg) rotateY(${s.ry}deg) scale(${stretch},${s.p})`;
      pending ||= !r.settled || Math.abs(s.rx - s.tx) > 0.05 || Math.abs(s.ry - s.ty) > 0.05;
      if (
        !s.pressed &&
        r.settled &&
        Math.abs(s.rx) < 0.05 &&
        Math.abs(s.ry) < 0.05 &&
        s.tx === 0 &&
        s.ty === 0
      ) {
        b.style.removeProperty('transform');
        states.delete(b);
      }
    }
    if (pending) raf = requestAnimationFrame(tick);
  }
  function press(b) {
    if (!allowed(b)) return;
    const s = state(b);
    s.goal = b.classList.contains('csp-service-btn') ? 0.945 : 0.92;
    s.pressed = true;
    start();
  }
  function release(b) {
    if (!b || !states.has(b)) return;
    const s = states.get(b);
    s.goal = 1;
    s.pressed = false;
    start();
  }
  document.addEventListener('pointerdown', e => {
    const b = target(e);
    if (!allowed(b) || e.button !== 0) return;
    pointers.set(e.pointerId, b);
    press(b);
  });
  const up = e => {
    release(pointers.get(e.pointerId));
    pointers.delete(e.pointerId);
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  document.addEventListener('keydown', e => {
    if (!e.repeat && ['Enter', ' '].includes(e.key)) press(target(e));
  });
  document.addEventListener('keyup', e => {
    if (['Enter', ' '].includes(e.key)) release(target(e));
  });
  window.addEventListener('blur', () => {
    for (const b of states.keys()) {
      release(b);
      const s = states.get(b);
      s.tx = s.ty = 0;
    }
    pointers.clear();
  });
  document.addEventListener('pointermove', e => {
    if (!precise.matches || reduced.matches || e.buttons) return;
    const b = target(e);
    if (!allowed(b) || !b.matches('.csp-service-btn')) return;
    const r = b.getBoundingClientRect(),
      s = state(b);
    s.tx = (-(e.clientY - r.top - r.height / 2) / r.height) * 9;
    s.ty = ((e.clientX - r.left - r.width / 2) / r.width) * 10;
    b.style.setProperty('--shine-x', `${((e.clientX - r.left) / r.width) * 100}%`);
    start();
  });
  document.addEventListener('pointerout', e => {
    const b = target(e);
    if (!b || (e.relatedTarget instanceof Node && b.contains(e.relatedTarget))) return;
    const s = states.get(b);
    if (s) {
      s.tx = s.ty = 0;
      if (!e.buttons) release(b);
      start();
    }
  });
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      for (const b of states.keys()) b.style.removeProperty('transform');
      states.clear();
      pointers.clear();
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
  if (!window.shriPrintDesktop) return;
  document.documentElement.classList.add('desktop-shell');
  const bar = document.createElement('header');
  bar.className = 'desktop-titlebar';
  const brand = document.createElement('strong');
  brand.textContent = 'S · SHRI Print';
  bar.append(brand);
  const controls = document.createElement('div');
  controls.className = 'desktop-window-controls';
  for (const [action, label, text] of [
    ['reload', 'Reconnect / reload', '↻'],
    ['minimize', 'Minimize', '−'],
    ['maximize', 'Maximize / restore', '□'],
    ['close', 'Close to tray', '×'],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.onclick = () => window.shriPrintDesktop.windowAction(action);
    controls.append(b);
  }
  bar.append(controls);
  document.body.prepend(bar);
  bar.addEventListener('dblclick', e => {
    if (!e.target.closest('button')) window.shriPrintDesktop.windowAction('maximize');
  });
}
