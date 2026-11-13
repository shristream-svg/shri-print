export function studioArt(kind = 'print') {
  const wrap = document.createElement('span');
  wrap.className = 'studio-art';
  wrap.setAttribute('aria-hidden', 'true');
  const body =
    kind === 'id'
      ? '<rect x="18" y="25" width="88" height="58" rx="12" fill="url(#mint)"/><rect x="28" y="38" width="23" height="28" rx="6" fill="#fff9e9"/><circle cx="39" cy="47" r="5" fill="#d66540"/><path d="M31 62q8-17 16 0" fill="#54867d"/><path d="M61 43h29M61 53h21M30 74h60" stroke="#32665e" stroke-width="4" stroke-linecap="round"/>'
      : kind === 'resume'
        ? '<g class="art-paper"><rect x="31" y="14" width="65" height="84" rx="8" fill="url(#paper)"/><circle cx="63" cy="35" r="9" fill="#e7a27e"/><path d="M45 54h36M44 67h40M44 76h31M44 85h36" stroke="#638b7f" stroke-width="4" stroke-linecap="round"/></g>'
        : '<g class="art-paper"><rect x="34" y="8" width="57" height="65" rx="6" fill="url(#paper)"/><path d="M46 23h31M46 33h22" stroke="#aac2b2" stroke-width="4" stroke-linecap="round"/></g><path d="M21 48h82v38q0 9-10 9H29q-9 0-9-9Z" fill="url(#mint)"/><rect x="15" y="43" width="94" height="37" rx="13" fill="url(#shell)"/><circle cx="94" cy="58" r="4" fill="#e67148"/><path d="M31 75h61" stroke="#315d55" stroke-width="7" stroke-linecap="round"/><rect x="36" y="73" width="51" height="29" rx="4" fill="url(#paper)"/><path d="M46 85h30M46 93h23" stroke="#b8cbbd" stroke-width="3" stroke-linecap="round"/>';
  wrap.innerHTML = `<svg viewBox="0 0 124 112" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="mint"><stop stop-color="#82bc9f"/><stop offset="1" stop-color="#396e61"/></linearGradient><linearGradient id="shell" x2="0" y2="1"><stop stop-color="#fff7dd"/><stop offset="1" stop-color="#d9d6ad"/></linearGradient><linearGradient id="paper" x2="0" y2="1"><stop stop-color="#fffefa"/><stop offset="1" stop-color="#eee8d5"/></linearGradient></defs><ellipse cx="62" cy="103" rx="45" ry="6" fill="#31584c" opacity=".12"/>${body}</svg>`;
  // Each icon owns unique gradient IDs; references never collide across the page.
  const suffix = kind + '-' + Math.random().toString(36).slice(2, 8);
  wrap.innerHTML = wrap.innerHTML
    .replace(/id="(mint|shell|paper)"/g, (_, id) => `id="${id}-${suffix}"`)
    .replace(/url\(#(mint|shell|paper)\)/g, (_, id) => `url(#${id}-${suffix})`);
  return wrap;
}
export function welcomeScene() {
  const scene = document.createElement('div');
  scene.className = 'studio-welcome';
  const copy = document.createElement('div');
  copy.innerHTML =
    '<span class="studio-kicker">YOUR NEIGHBOURHOOD PRINT STUDIO</span><h1>Good files.<br><em>Beautiful prints.</em></h1><p>Upload, make it yours, collect at the counter.</p>';
  scene.append(copy, studioArt('print'));
  return scene;
}
