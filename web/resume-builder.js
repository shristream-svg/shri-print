import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const _esc = s =>
  s == null ? '' : String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

const FONT_CHOICES = {
  modern: {
    name: 'Modern · Helvetica',
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
  },
  classic: {
    name: 'Classic · Times',
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
  },
  mono: {
    name: 'Simple · Courier',
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
  },
};

const TEMPLATES = {
  clean: {
    name: 'Clean',
    desc: 'Minimal, spacious layout',
    accentColor: rgb(0.055, 0.463, 0.769),
    headerStyle: 'centered',
    sectionStyle: 'underline',
  },
  professional: {
    name: 'Professional',
    desc: 'Structured with sidebar accent',
    accentColor: rgb(0.071, 0.188, 0.29),
    headerStyle: 'left-accent',
    sectionStyle: 'bold',
  },
};

function createDefaultData() {
  return {
    template: 'clean',
    font: 'modern',
    name: '',
    phone: '',
    email: '',
    city: '',
    summary: '',
    education: [{ degree: '', institution: '', year: '', details: '' }],
    experience: [{ role: '', company: '', period: '', bullets: '' }],
    skills: '',
  };
}

export function validateData(data) {
  const errors = [];
  if (!data.name?.trim()) errors.push('Name is required');
  if (data.phone && !/^\d{10}$/.test(data.phone.replace(/\D/g, '')))
    errors.push('Phone must be 10 digits');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
    errors.push('Invalid email format');
  // Validate WinAnsi (Latin-1) characters for all text fields
  // eslint-disable-next-line no-control-regex
  const winAnsiRegex = /^[\u000A\u000D\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2022]*$/;
  const checkWinAnsi = (text, field) => {
    if (text && !winAnsiRegex.test(text))
      errors.push(`${field}: contains unsupported characters (only Latin-1 supported)`);
  };
  checkWinAnsi(data.name, 'Name');
  checkWinAnsi(data.city, 'City');
  checkWinAnsi(data.summary, 'Summary');
  checkWinAnsi(data.skills, 'Skills');
  for (const [i, edu] of data.education.entries()) {
    if (!edu.degree?.trim() && !edu.institution?.trim()) continue; // skip blank
    checkWinAnsi(edu.degree, `Education ${i + 1} degree`);
    checkWinAnsi(edu.institution, `Education ${i + 1} institution`);
    checkWinAnsi(edu.year, `Education ${i + 1} year`);
    checkWinAnsi(edu.details, `Education ${i + 1} details`);
  }
  for (const [i, exp] of data.experience.entries()) {
    if (!exp.role?.trim() && !exp.company?.trim()) continue; // skip blank
    checkWinAnsi(exp.role, `Experience ${i + 1} role`);
    checkWinAnsi(exp.company, `Experience ${i + 1} company`);
    checkWinAnsi(exp.period, `Experience ${i + 1} period`);
    checkWinAnsi(exp.bullets, `Experience ${i + 1} bullets`);
  }
  return errors;
}

function sanitizeText(text) {
  return (
    String(text || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .trim()
  );
}

function wrapText(text, font, size, maxWidth) {
  // Split by explicit newlines first, then wrap each paragraph
  const paragraphs = text.split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      const test = current + (current ? ' ' : '') + word;
      if (font.widthOfTextAtSize(test, size) > maxWidth) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    // Preserve paragraph breaks (empty line between paragraphs)
    if (paragraph !== paragraphs[paragraphs.length - 1]) lines.push('');
  }
  return lines;
}

export async function generatePDF(data) {
  const pdf = await PDFDocument.create();
  const choice = FONT_CHOICES[data.font] || FONT_CHOICES.modern;
  const fontRegular = await pdf.embedFont(choice.regular);
  const fontBold = await pdf.embedFont(choice.bold);
  const fontOblique = await pdf.embedFont(choice.italic);

  const template = TEMPLATES[data.template];
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 54;
  const contentWidth = pageWidth - 2 * margin;
  let y = pageHeight - margin;
  const lineHeight = 14;
  const sectionGap = 18;
  const itemGap = 10;

  const checkNewPage = needed => {
    if (y - needed < margin) {
      pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const drawText = (
    text,
    x,
    yPos,
    {
      font = fontRegular,
      size = 10,
      color = rgb(0, 0, 0),
      maxWidth = contentWidth,
      align = 'left',
    } = {}
  ) => {
    const lines = wrapText(text, font, size, maxWidth);
    let cursor = yPos;
    for (const line of lines) {
      if (cursor < margin) {
        pdf.addPage([pageWidth, pageHeight]);
        cursor = pageHeight - margin;
      }
      let lineX = x;
      if (align === 'center') lineX = x + (maxWidth - font.widthOfTextAtSize(line, size)) / 2;
      else if (align === 'right') lineX = x + maxWidth - font.widthOfTextAtSize(line, size);
      if (line) pdf.getPages().at(-1).drawText(line, { x: lineX, y: cursor, size, font, color });
      cursor -= lineHeight;
    }
    return y - cursor;
  };

  const drawLine = (x, yPos, width, color, thickness = 0.8) => {
    pdf.getPages()[pdf.getPageCount() - 1].drawLine({
      start: { x, y: yPos },
      end: { x: x + width, y: yPos },
      thickness,
      color,
    });
  };

  pdf.addPage([pageWidth, pageHeight]);

  if (template.headerStyle === 'centered') {
    y -= drawText(sanitizeText(data.name).toUpperCase(), margin, y, {
      font: fontBold,
      size: 22,
      color: template.accentColor,
      align: 'center',
      maxWidth: contentWidth,
    });
    const contact = [sanitizeText(data.phone), sanitizeText(data.email), sanitizeText(data.city)]
      .filter(Boolean)
      .join('  •  ');
    y -= drawText(contact, margin, y - 4, {
      font: fontRegular,
      size: 9,
      color: rgb(0.3, 0.3, 0.3),
      align: 'center',
      maxWidth: contentWidth,
    });
    y -= 6;
    drawLine(margin, y, contentWidth, template.accentColor, 1.5);
    y -= sectionGap;
  } else {
    const _nameWidth = fontBold.widthOfTextAtSize(sanitizeText(data.name).toUpperCase(), 22);
    pdf.getPages()[pdf.getPageCount() - 1].drawRectangle({
      x: margin,
      y: y - 26,
      width: 4,
      height: 26,
      color: template.accentColor,
    });
    y -= drawText(sanitizeText(data.name).toUpperCase(), margin + 10, y, {
      font: fontBold,
      size: 22,
      color: template.accentColor,
    });
    const contact = [sanitizeText(data.phone), sanitizeText(data.email), sanitizeText(data.city)]
      .filter(Boolean)
      .join('  |  ');
    y -= drawText(contact, margin + 10, y - 2, {
      font: fontRegular,
      size: 9,
      color: rgb(0.3, 0.3, 0.3),
    });
    y -= 6;
    drawLine(margin, y, contentWidth, template.accentColor, 1);
    y -= sectionGap;
  }

  const drawSection = (title, bodyFn) => {
    checkNewPage(30);
    if (template.sectionStyle === 'underline') {
      y -= drawText(title.toUpperCase(), margin, y, {
        font: fontBold,
        size: 10,
        color: template.accentColor,
      });
      drawLine(margin, y - 2, contentWidth, template.accentColor, 0.8);
      y -= 8;
    } else {
      y -= drawText(title.toUpperCase(), margin, y, {
        font: fontBold,
        size: 10,
        color: template.accentColor,
      });
      y -= 4;
    }
    bodyFn();
    y -= sectionGap;
  };

  if (data.summary?.trim()) {
    drawSection('Summary', () => {
      y -= drawText(sanitizeText(data.summary), margin, y, {
        font: fontRegular,
        size: 10,
        color: rgb(0.1, 0.1, 0.1),
        maxWidth: contentWidth,
      });
    });
  }

  const hasEducation = data.education.some(e => e.degree?.trim() || e.institution?.trim());
  if (hasEducation) {
    drawSection('Education', () => {
      data.education.forEach((edu, i) => {
        if (!edu.degree?.trim() && !edu.institution?.trim()) return;
        checkNewPage(28);
        y -= drawText(sanitizeText(edu.degree), margin, y, {
          font: fontBold,
          size: 10,
          color: rgb(0.1, 0.1, 0.1),
        });
        const instLine = [sanitizeText(edu.institution), sanitizeText(edu.year)]
          .filter(Boolean)
          .join('  |  ');
        if (instLine)
          y -= drawText(instLine, margin, y - 2, {
            font: fontRegular,
            size: 9,
            color: rgb(0.3, 0.3, 0.3),
          });
        if (edu.details?.trim())
          y -= drawText(sanitizeText(edu.details), margin, y - 2, {
            font: fontOblique,
            size: 9,
            color: rgb(0.35, 0.35, 0.35),
            maxWidth: contentWidth,
          });
        if (i < data.education.length - 1) y -= itemGap;
      });
    });
  }

  const hasExperience = data.experience.some(e => e.role?.trim() || e.company?.trim());
  if (hasExperience) {
    drawSection('Experience', () => {
      data.experience.forEach((exp, i) => {
        if (!exp.role?.trim() && !exp.company?.trim()) return;
        checkNewPage(36);
        const header = [sanitizeText(exp.role), sanitizeText(exp.company)]
          .filter(Boolean)
          .join('  |  ');
        y -= drawText(header, margin, y, { font: fontBold, size: 10, color: rgb(0.1, 0.1, 0.1) });
        if (exp.period?.trim())
          y -= drawText(sanitizeText(exp.period), margin, y - 2, {
            font: fontRegular,
            size: 9,
            color: rgb(0.3, 0.3, 0.3),
          });
        if (exp.bullets?.trim()) {
          const bullets = sanitizeText(exp.bullets)
            .split('\n')
            .filter(b => b.trim());
          bullets.forEach(b => {
            checkNewPage(14);
            y -= drawText('• ' + b.trim(), margin + 10, y, {
              font: fontRegular,
              size: 9,
              color: rgb(0.2, 0.2, 0.2),
              maxWidth: contentWidth - 10,
            });
          });
        }
        if (i < data.experience.length - 1) y -= itemGap;
      });
    });
  }

  if (data.skills?.trim()) {
    drawSection('Skills', () => {
      const skills = sanitizeText(data.skills)
        .split(/[,;|]/)
        .map(s => s.trim())
        .filter(Boolean);
      let line = '';
      skills.forEach((skill, i) => {
        const test = line + (line ? ', ' : '') + skill;
        if (fontRegular.widthOfTextAtSize(test, 9) > contentWidth) {
          y -= drawText(line, margin, y, { font: fontRegular, size: 9, color: rgb(0.2, 0.2, 0.2) });
          line = skill;
        } else {
          line = test;
        }
        if (i === skills.length - 1 && line)
          y -= drawText(line, margin, y, { font: fontRegular, size: 9, color: rgb(0.2, 0.2, 0.2) });
      });
    });
  }

  const bytes = await pdf.save();
  return new File([bytes], 'resume.pdf', { type: 'application/pdf' });
}

let resumeFieldSequence = 0;
function createField(label, input) {
  input.id ||= `resume-field-${++resumeFieldSequence}`;
  return el('div', { class: 'csp-resume-field' }, el('label', { for: input.id }, label), input);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k.startsWith('on') && typeof v === 'function')
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => (e.dataset[dk] = dv));
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'checked' || k === 'open') e[k] = !!v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v);
  });
  children.flat().forEach(c => {
    if (c instanceof Node) e.appendChild(c);
    else if (c != null) e.appendChild(document.createTextNode(String(c)));
  });
  return e;
}

export function createResumeBuilder({ onFile, onClear }) {
  let data = createDefaultData();
  let mounted = false;
  let previewBlobUrl = null;

  const root = el('div', { class: 'csp-resume-form' });
  // A changed form must be generated again; never send a stale resume PDF.
  root.addEventListener('input', () => onClear?.());
  root.addEventListener('change', () => onClear?.());

  function render() {
    root.innerHTML = '';
    root.appendChild(
      el(
        'p',
        { class: 'csp-hint' },
        'Resume Maker · ₹30 · one A4 copy. Choose a format and font, enter your details, then check the PDF preview.'
      )
    );
    root.appendChild(renderTemplateSelector());
    const font = el(
      'select',
      {
        class: 'csp-select',
        'aria-label': 'Resume font',
        onchange: e => {
          data.font = e.target.value;
        },
      },
      ...Object.entries(FONT_CHOICES).map(([key, value]) =>
        el('option', { value: key }, value.name)
      )
    );
    font.value = data.font || 'modern';
    root.appendChild(el('label', { class: 'csp-label' }, 'Font', font));
    root.appendChild(renderForm());
    root.appendChild(renderActions());
    if (!mounted) {
      mounted = true;
      updatePreview();
    }
  }

  function renderTemplateSelector() {
    return el(
      'div',
      { class: 'csp-resume-template-row' },
      ...Object.entries(TEMPLATES).map(([key, t]) =>
        el(
          'label',
          { class: 'csp-resume-template-card' + (data.template === key ? ' active' : '') },
          el('input', {
            type: 'radio',
            name: 'template',
            value: key,
            checked: data.template === key,
            onchange: () => {
              data.template = key;
              render();
              updatePreview();
            },
          }),
          el('div', { class: 'csp-resume-template-name' }, t.name),
          el('div', { class: 'csp-resume-template-desc' }, t.desc)
        )
      )
    );
  }

  function renderForm() {
    const container = el('div', { style: 'display:flex;flex-direction:column;gap:12px;' });

    container.appendChild(
      el(
        'details',
        { class: 'csp-resume-section', open: true },
        el('summary', { class: 'csp-resume-section-header' }, 'Personal Details'),
        el(
          'div',
          { class: 'csp-resume-section-body' },
          el(
            'div',
            { class: 'csp-resume-field-row' },
            createField(
              'Full Name *',
              el('input', {
                type: 'text',
                placeholder: 'Your name',
                value: data.name,
                oninput: e => (data.name = e.target.value),
              })
            ),
            createField(
              'Phone (optional)',
              el('input', {
                type: 'tel',
                placeholder: '10-digit number',
                maxlength: 10,
                inputmode: 'numeric',
                value: data.phone,
                oninput: e => (data.phone = e.target.value),
              })
            )
          ),
          el(
            'div',
            { class: 'csp-resume-field-row' },
            createField(
              'Email (optional)',
              el('input', {
                type: 'email',
                placeholder: 'you@example.com',
                value: data.email,
                oninput: e => (data.email = e.target.value),
              })
            ),
            createField(
              'City',
              el('input', {
                type: 'text',
                placeholder: 'City',
                value: data.city,
                oninput: e => (data.city = e.target.value),
              })
            )
          )
        )
      )
    );

    container.appendChild(
      el(
        'details',
        { class: 'csp-resume-section', open: true },
        el('summary', { class: 'csp-resume-section-header' }, 'Professional Summary'),
        el(
          'div',
          { class: 'csp-resume-section-body' },
          createField(
            'Short Summary',
            el('textarea', {
              placeholder: '2-3 lines about yourself…',
              rows: 3,
              value: data.summary,
              oninput: e => (data.summary = e.target.value),
            })
          )
        )
      )
    );

    container.appendChild(
      renderRepeatingSection(
        'education',
        'Education',
        ['degree', 'institution', 'year', 'details'],
        ['Degree', 'Institution', 'Year', 'Details'],
        [{ degree: '', institution: '', year: '', details: '' }],
        item => ({
          degree: item.degree,
          institution: item.institution,
          year: item.year,
          details: item.details,
        })
      )
    );

    container.appendChild(
      renderRepeatingSection(
        'experience',
        'Experience',
        ['role', 'company', 'period', 'bullets'],
        ['Role', 'Company', 'Period (e.g. 2021-2023)', 'Bullets (one per line)'],
        [{ role: '', company: '', period: '', bullets: '' }],
        item => ({
          role: item.role,
          company: item.company,
          period: item.period,
          bullets: item.bullets,
        })
      )
    );

    container.appendChild(
      el(
        'details',
        { class: 'csp-resume-section', open: true },
        el('summary', { class: 'csp-resume-section-header' }, 'Skills'),
        el(
          'div',
          { class: 'csp-resume-section-body' },
          createField(
            'Skills (comma or semicolon separated)',
            el('textarea', {
              placeholder: 'JavaScript, React, Node.js, SQL, Git…',
              rows: 2,
              value: data.skills,
              oninput: e => (data.skills = e.target.value),
            })
          )
        )
      )
    );

    return container;
  }

  function renderRepeatingSection(key, title, fields, labels, defaultItem, toData) {
    const section = el(
      'details',
      { class: 'csp-resume-section', open: true, 'data-key': key },
      el('summary', { class: 'csp-resume-section-header' }, title),
      el('div', { class: 'csp-resume-section-body', id: `csp-resume-${key}-list` })
    );
    const list = section.querySelector(`#csp-resume-${key}-list`);
    data[key].forEach((item, i) =>
      list.appendChild(renderRepeatingItem(key, i, fields, labels, toData))
    );
    list.appendChild(
      el(
        'button',
        {
          type: 'button',
          class: 'csp-resume-add-btn',
          onclick: () => addRepeatingItem(key, fields, labels, toData),
        },
        key === 'education' ? '+ Add education' : '+ Add experience'
      )
    );
    return section;
  }

  function renderRepeatingItem(key, index, _fields, _labels, _toData) {
    const item = data[key][index];
    const wrapper = el(
      'div',
      {
        style:
          'display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--csp-card);border:1px solid var(--csp-line-soft);border-radius:var(--csp-radius-sm);position:relative;',
      },
      el(
        'button',
        {
          type: 'button',
          class: 'csp-resume-remove-btn',
          'aria-label': `Remove ${key} entry`,
          onclick: () => removeRepeatingItem(key, index),
        },
        el(
          'svg',
          {
            width: '16',
            height: '16',
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '2',
          },
          el('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
          el('line', { x1: '6', y1: '6', x2: '18', y2: '18' })
        )
      ),
      ..._fields.map((f, fi) =>
        createField(
          _labels[fi],
          f === 'bullets' || f === 'details'
            ? el('textarea', {
                placeholder: _labels[fi],
                rows: f === 'bullets' ? 4 : 2,
                value: item[f] || '',
                oninput: e => {
                  data[key][index][f] = e.target.value;
                },
              })
            : el('input', {
                type: 'text',
                placeholder: _labels[fi],
                value: item[f] || '',
                oninput: e => {
                  data[key][index][f] = e.target.value;
                },
              })
        )
      )
    );
    return wrapper;
  }

  function addRepeatingItem(key, _fields, _labels, _toData) {
    data[key].push({});
    render();
  }

  function removeRepeatingItem(key, index) {
    data[key].splice(index, 1);
    if (data[key].length === 0) data[key].push({});
    render();
  }

  function renderActions() {
    return el(
      'div',
      { class: 'csp-resume-actions' },
      el(
        'button',
        { type: 'button', class: 'csp-btn secondary', onclick: loadExample },
        'Load Example'
      ),
      el(
        'button',
        { type: 'button', class: 'csp-btn primary', onclick: buildAndEmit },
        'Generate Resume PDF'
      )
    );
  }

  function loadExample() {
    onClear?.();
    data = {
      template: data.template,
      font: data.font,
      name: 'Alex Morgan',
      phone: '9876543210',
      email: 'alex.morgan@example.com',
      city: 'Bengaluru',
      summary:
        'Full-stack developer with 5+ years building scalable web applications. Passionate about clean code, performance, and mentoring junior engineers.',
      education: [
        {
          degree: 'B.Tech Computer Science',
          institution: 'IIT Delhi',
          year: '2018',
          details: 'CGPA: 8.7/10 · Relevant coursework: Algorithms, Distributed Systems, Databases',
        },
      ],
      experience: [
        {
          role: 'Senior Software Engineer',
          company: 'TechCorp Solutions',
          period: '2021 – Present',
          bullets:
            'Led migration to microservices architecture reducing latency by 40%\nMentored 4 engineers, established code review practices\nBuilt CI/CD pipelines cutting deploy time from 45min to 8min',
        },
        {
          role: 'Software Engineer',
          company: 'StartupXYZ',
          period: '2018 – 2021',
          bullets:
            'Developed customer-facing React dashboard serving 50k+ MAU\nOptimized PostgreSQL queries improving API p95 by 60%\nIntroduced TypeScript across frontend codebase',
        },
      ],
      skills:
        'JavaScript, TypeScript, React, Node.js, PostgreSQL, Docker, Kubernetes, AWS, Git, CI/CD, System Design',
    };
    render();
    updatePreview();
  }

  async function buildAndEmit() {
    const errors = validateData(data);
    if (errors.length) {
      // eslint-disable-next-line no-undef
      alert(errors.join('\n'));
      return;
    }
    const btn = root.querySelector('.csp-btn.primary');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const file = await generatePDF(data);
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      previewBlobUrl = URL.createObjectURL(file);
      onFile?.(file);
    } catch (e) {
      // eslint-disable-next-line no-undef
      alert('Failed to generate PDF: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function updatePreview() {}

  function _getElement() {
    return root;
  }
  function getData() {
    return { ...data };
  }
  function setData(d) {
    data = { ...createDefaultData(), ...d };
    if (mounted) render();
  }
  function destroy() {
    if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    root.remove();
  }

  render();
  return { element: root, getData, setData, destroy, onFile: () => {}, onClear: () => {} };
}
