(() => {
  if (window.__shriDesktopStudio || !location.pathname.startsWith('/admin')) return;
  window.__shriDesktopStudio = true;
  // Semi-implicit integration with bounded substeps keeps release motion stable after slow frames.
  function stepSpring(
    position,
    velocity,
    target,
    elapsed,
    { stiffness = 340, damping = 22, mass = 0.85 } = {}
  ) {
    let time = Math.max(0, Math.min(0.05, elapsed));
    while (time > 0) {
      const dt = Math.min(time, 1 / 180);
      velocity += (((target - position) * stiffness - damping * velocity) / mass) * dt;
      position += velocity * dt;
      time -= dt;
    }
    return {
      position,
      velocity,
      settled: Math.abs(target - position) < 0.0008 && Math.abs(velocity) < 0.008,
    };
  }

  function initDesktopMotion() {
    document.documentElement.classList.add('desktop-studio');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const precise = matchMedia('(hover:hover) and (pointer:fine)');
    const states = new Map(),
      pointers = new Map();
    let raf = 0,
      last = 0;
    const target = e =>
      e.target instanceof Element
        ? e.target.closest('button,.button,.sidebar nav a,.download-step')
        : null;
    const allowed = b =>
      b &&
      !b.disabled &&
      b.getAttribute('aria-disabled') !== 'true' &&
      !b.closest('.desktop-window-controls,[data-no-motion]') &&
      !reduced.matches;
    const physics = { stiffness: 390, damping: 18, mass: 0.85 };
    function state(b) {
      if (!states.has(b))
        states.set(b, { p: 1, v: 0, goal: 1, rx: 0, ry: 0, tx: 0, ty: 0, pressed: false });
      return states.get(b);
    }
    function paint(b, s) {
      const x = 1 + (1 - s.p) * 0.55;
      b.style.setProperty('--desk-sx', String(x));
      b.style.setProperty('--desk-sy', String(s.p));
      b.style.setProperty('--desk-y', `${(1 - s.p) * 22}px`);
    }

    function start() {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }
    function tick(now) {
      raf = 0;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      let moving = false;
      for (const [b, s] of states) {
        if (!b.isConnected || !allowed(b)) {
          b.style.removeProperty('--desk-sx');
          b.style.removeProperty('--desk-sy');
          b.style.removeProperty('--desk-y');
          states.delete(b);
          continue;
        }
        const r = stepSpring(s.p, s.v, s.goal, dt, physics);
        s.p = r.position;
        s.v = r.velocity;
        const blend = 1 - Math.exp(-18 * dt);
        s.rx += (s.tx - s.rx) * blend;
        s.ry += (s.ty - s.ry) * blend;
        paint(b, s);
        const settled = r.settled && Math.abs(s.rx - s.tx) < 0.03 && Math.abs(s.ry - s.ty) < 0.03;
        if (!s.pressed && settled && s.tx === 0 && s.ty === 0) {
          b.style.removeProperty('--desk-sx');
          b.style.removeProperty('--desk-sy');
          b.style.removeProperty('--desk-y');
          states.delete(b);
        } else moving ||= !settled;
      }
      if (moving) raf = requestAnimationFrame(tick);
    }
    function release(b) {
      const s = states.get(b);
      if (!s) return;
      s.pressed = false;
      s.goal = 1;
      s.tx = s.ty = 0;
      start();
    }
    function reset() {
      cancelAnimationFrame(raf);
      raf = 0;
      for (const b of states.keys()) {
        b.style.removeProperty('--desk-sx');
        b.style.removeProperty('--desk-sy');
        b.style.removeProperty('--desk-y');
      }
      states.clear();
      pointers.clear();
    }
    document.addEventListener('pointerdown', e => {
      const b = target(e);
      if (!allowed(b) || e.button !== 0) return;
      const s = state(b);
      s.goal = b.matches('.csp-service-btn') ? 0.91 : 0.935;
      s.p = Math.min(s.p, 0.965);
      s.v = -0.6;
      s.pressed = true;
      pointers.set(e.pointerId, b);
      paint(b, s);
      start();
    });
    const up = e => {
      const b = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (b && ![...pointers.values()].includes(b)) release(b);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.addEventListener('pointermove', e => {
      if (!precise.matches || reduced.matches || e.buttons) return;
      const b = target(e);
      if (!allowed(b)) return;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      b.style.setProperty('--shine-x', `${x * 100}%`);
      b.style.setProperty('--shine-y', `${y * 100}%`);
      if (!b.matches('.csp-service-btn')) return;
      const s = state(b);
      s.tx = (0.5 - y) * 9;
      s.ty = (x - 0.5) * 11;
      start();
    });
    document.addEventListener('pointerout', e => {
      const b = target(e);
      if (!b || (e.relatedTarget instanceof Node && b.contains(e.relatedTarget))) return;
      const s = states.get(b);
      if (s) {
        s.tx = s.ty = 0;
        if (!s.pressed) s.goal = 1;
        start();
      }
    });
    // Keyboard actions stay immediate; focus is communicated by the visible ring.
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) reset();
    });
    reduced.addEventListener('change', () => {
      if (reduced.matches) reset();
    });
  }
  initDesktopMotion();

  const paths = {
    dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    jobs: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    downloads: 'M12 3v12 m-5-5 5 5 5-5 M4 17v4h16v-4',
    printers: 'M6 8V3h12v5 M6 16H3V8h18v8h-3 M6 13h12v8H6z M17 11h1',
    reports: 'M4 20V4 M4 20h17 M8 16v-5 M13 16V7 M18 16V3',
    settings:
      'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 3h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z',
  };
  function decorate() {
    for (const a of document.querySelectorAll('.sidebar nav a:not([data-desk-icon])')) {
      a.dataset.deskIcon = '1';
      const k = a.hash.slice(1),
        icon = a.querySelector('.navicon');
      if (icon && paths[k])
        icon.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' +
          paths[k] +
          '"/></svg>';
    }
    const top = document.querySelector('.topbar');
    if (top && !top.querySelector('.desk-printer')) {
      const art = document.createElement('div');
      art.className = 'desk-printer';
      art.setAttribute('aria-hidden', 'true');
      art.innerHTML =
        '<div class="desk-paper"></div><div class="desk-case"><i></i></div><div class="desk-slot"></div><div class="desk-output"></div>';
      top.append(art);
    }
    const root = document.querySelector('#admin-content');
    document.documentElement.dataset.deskView = root?.querySelector('#counter-inbox')
      ? 'dashboard'
      : 'detail';
  }
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      decorate();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  decorate();
})();
