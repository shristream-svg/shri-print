export function createPhotoPackageSelector(config) {
  const packages = config.photoPackages || { 5: 3000, 10: 6000, 20: 12000, 30: 18000 };
  const container = document.createElement('div');
  container.className = 'photo-package-selector';

  let selectedQty = 5;
  let copies = 1;
  let onChange = null;

  function render() {
    container.innerHTML = `
      <div class="pkg-qty-selector">
        <label>Photos per set</label>
        <div class="qty-buttons" role="radiogroup" aria-label="Photos per set">
          ${[5, 10, 20, 30]
            .map(
              q => `
            <button type="button" class="${q === selectedQty ? 'active' : ''}" data-qty="${q}" role="radio" aria-checked="${q === selectedQty}">
              <span class="qty-number">${q}</span>
              <span class="qty-unit">photos</span>
              <span class="qty-price">₹${((packages[q] ?? { 5: 3000, 10: 6000, 20: 12000, 30: 18000 }[q]) / 100).toFixed(2)}</span>
            </button>
          `
            )
            .join('')}
        </div>
      </div>
      <div class="pkg-copies-selector">
        <label>Number of sets</label>
        <div class="sets-counter" aria-valuemin="1" aria-valuemax="10" aria-valuenow="${copies}">
          <button class="sets-counter-btn" data-action="decrease" aria-label="Decrease sets" ${copies <= 1 ? 'disabled' : ''}>−</button>
          <span class="sets-counter-value" id="pkg-copies-value">${copies}</span>
          <button class="sets-counter-btn" data-action="increase" aria-label="Increase sets" ${copies >= 10 ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div class="pkg-summary">
        <div>Total photos: <strong>${selectedQty * copies}</strong></div>
        <div>Price per set: <strong>₹${(packages[selectedQty] / 100).toFixed(2)}</strong></div>
        <div class="total">Total: <strong>₹${((packages[selectedQty] * copies) / 100).toFixed(2)}</strong></div>
      </div>
    `;

    // Use event delegation on container for stable listeners
    container.querySelectorAll('[data-qty]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedQty = parseInt(btn.dataset.qty);
        render();
        if (onChange) onChange({ photoQty: selectedQty, copies });
      });
    });
    container.querySelectorAll('.sets-counter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'increase' && copies < 10) copies++;
        else if (action === 'decrease' && copies > 1) copies--;
        render();
        if (onChange) onChange({ photoQty: selectedQty, copies });
      });
    });
  }

  function getValues() {
    return { photoQty: selectedQty, copies };
  }

  function setValues(v) {
    if (v.photoQty) selectedQty = v.photoQty;
    if (v.copies) copies = v.copies;
    render();
  }

  function setOnChange(cb) {
    onChange = cb;
  }

  render();
  return { element: container, getValues, setValues, setOnChange };
}
