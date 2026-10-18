// Pop-ups do chattrack no lugar de prompt()/alert() do navegador.
//
//   ctForm({ title, description, icon, fields, submitLabel, validate, onSubmit })
//     → Promise com os valores ({ nome_do_campo: valor }) ou null se cancelou.
//     fields: [{ name, label, type, value, placeholder, required, help, options, rows, suggestions }]
//       type: text | email | tel | textarea | money | select | choice
//       choice = lista de opções em cartões (options: [{ value, label, description }])
//     validate(values) → texto do erro (mostrado no pop-up) ou nada.
//     onSubmit(values) → async; se lançar erro, a mensagem aparece no pop-up e
//       ele continua aberto (o que foi digitado não se perde).
//
//   ctAlert(mensagem | { title, message, tone }) → Promise quando fechar.
//     tone: info | success | error (texto "Não foi possível…" vira error sozinho).
//
// Autocontido (injeta o próprio CSS) pra funcionar também nas páginas que não
// usam o index.html (/users/, /tasks/).
(function () {
  if (window.ctForm) return;

  var CSS = [
    '.cd-dialog{border:none;border-radius:20px;padding:0;width:min(480px,calc(100vw - 32px));max-height:calc(100vh - 48px);background:#FFFFFF;color:#111214;box-shadow:0 24px 64px rgba(17,18,20,.24);font-family:var(--font-body,"Geist",system-ui,sans-serif);}',
    '.cd-dialog::backdrop{background:rgba(17,18,20,.45);}',
    '.cd-dialog form{display:flex;flex-direction:column;max-height:calc(100vh - 48px);margin:0;}',
    '.cd-head{display:flex;gap:14px;align-items:flex-start;padding:22px 24px 4px;}',
    '.cd-tile{width:40px;height:40px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:#111214;color:#C8F542;}',
    '.cd-tile.success{background:#E3F6E8;color:#157A3A;}',
    '.cd-tile.error{background:#FDE8E3;color:#B4381A;}',
    '.cd-tile.info{background:#111214;color:#C8F542;}',
    '.cd-title{font-family:var(--font-display,"Bricolage Grotesque",system-ui,sans-serif);font-size:20px;font-weight:600;letter-spacing:-.01em;line-height:1.25;margin:0;color:#111214;}',
    '.cd-desc{font-size:14px;color:#5B5D63;line-height:1.5;margin:6px 0 0;white-space:pre-line;}',
    '.cd-close{margin-left:auto;width:32px;height:32px;border:none;background:transparent;border-radius:9px;color:#5B5D63;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.cd-close:hover{background:#F0F0EA;color:#111214;}',
    '.cd-body{padding:18px 24px 6px;overflow-y:auto;display:flex;flex-direction:column;gap:16px;}',
    '.cd-field{display:flex;flex-direction:column;gap:7px;}',
    '.cd-label{font-size:13px;font-weight:600;color:#111214;}',
    '.cd-label .cd-opt{font-weight:400;color:#6E7076;}',
    '.cd-input{width:100%;box-sizing:border-box;height:44px;border:1px solid #E3E3DC;border-radius:11px;background:#FAFAF7;padding:0 13px;font-size:15px;color:#111214;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;}',
    'textarea.cd-input{height:auto;min-height:96px;padding:11px 13px;line-height:1.5;resize:vertical;}',
    'select.cd-input{cursor:pointer;}',
    '.cd-input:focus{border-color:#111214;background:#FFFFFF;box-shadow:0 0 0 3px rgba(200,245,66,.55);}',
    '.cd-input[aria-invalid="true"]{border-color:#B4381A;}',
    '.cd-money{position:relative;}',
    '.cd-money span{position:absolute;left:13px;top:50%;transform:translateY(-50%);font-size:15px;color:#6E7076;pointer-events:none;}',
    '.cd-money .cd-input{padding-left:40px;font-variant-numeric:tabular-nums;}',
    '.cd-help{font-size:12.5px;color:#6E7076;line-height:1.45;}',
    '.cd-choices{display:flex;flex-direction:column;gap:8px;}',
    '.cd-choice{display:flex;gap:11px;align-items:flex-start;border:1px solid #E3E3DC;border-radius:12px;padding:12px 14px;cursor:pointer;background:#FFFFFF;transition:border-color .15s,background .15s;}',
    '.cd-choice:hover{border-color:#B9BAB2;}',
    '.cd-choice:has(input:checked){border-color:#111214;background:#F7FBEA;box-shadow:inset 0 0 0 1px #111214;}',
    '.cd-choice input{margin:3px 0 0;accent-color:#111214;flex-shrink:0;}',
    '.cd-choice-t{font-size:14.5px;font-weight:500;color:#111214;}',
    '.cd-choice-d{font-size:12.5px;color:#6E7076;margin-top:2px;white-space:pre-line;}',
    '.cd-error{display:none;gap:8px;align-items:flex-start;background:#FDE8E3;color:#8A2E12;border-radius:11px;padding:10px 12px;font-size:13.5px;line-height:1.45;}',
    '.cd-error.show{display:flex;}',
    '.cd-foot{display:flex;justify-content:flex-end;gap:8px;padding:18px 24px 22px;}',
    '.cd-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border-radius:11px;font-size:15px;font-weight:500;font-family:inherit;cursor:pointer;border:1px solid transparent;}',
    '.cd-btn:disabled{opacity:.55;cursor:default;}',
    '.cd-btn-primary{background:#111214;color:#FFFFFF;}',
    '.cd-btn-primary:hover:not(:disabled){background:#2B2D33;}',
    '.cd-btn-secondary{background:#FFFFFF;border-color:#E3E3DC;color:#111214;}',
    '.cd-btn-secondary:hover{background:#F4F4F0;}',
  ].join('\n');

  var ICONS = {
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  };
  function svg(name, size) {
    if (window.ICON && !ICONS[name]) return window.ICON(name, size);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || ICONS.pencil) + '</svg>';
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById('cd-style')) return;
    var style = document.createElement('style');
    style.id = 'cd-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // "4.500,00" / "4500,5" / "4500.50" / "R$ 1.200" → número (ou null).
  function parseMoney(raw) {
    var s = String(raw || '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
    else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function formatMoneyInput(v) {
    if (v == null || v === '') return '';
    var n = Number(v);
    return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var seq = 0;
  function fieldHtml(f) {
    var id = 'cd-f-' + (++seq);
    f._id = id;
    var label = f.label ? '<label class="cd-label" for="' + id + '">' + esc(f.label) + (f.required ? '' : f.optionalHint === false ? '' : ' <span class="cd-opt">(opcional)</span>') + '</label>' : '';
    var help = f.help ? '<div class="cd-help" id="' + id + '-help">' + esc(f.help) + '</div>' : '';
    var describedby = f.help ? ' aria-describedby="' + id + '-help"' : '';
    var ph = f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '';
    var req = f.required ? ' required aria-required="true"' : '';
    var control;
    if (f.type === 'textarea') {
      control = '<textarea class="cd-input" id="' + id + '" name="' + esc(f.name) + '" rows="' + (f.rows || 4) + '"' + ph + req + describedby + '>' + esc(f.value) + '</textarea>';
    } else if (f.type === 'select') {
      control = '<select class="cd-input" id="' + id + '" name="' + esc(f.name) + '"' + req + describedby + '>' +
        (f.options || []).map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(f.value == null ? '' : f.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>';
    } else if (f.type === 'choice') {
      label = f.label ? '<div class="cd-label" id="' + id + '-label">' + esc(f.label) + '</div>' : '';
      control = '<div class="cd-choices" role="radiogroup"' + (f.label ? ' aria-labelledby="' + id + '-label"' : '') + describedby + '>' +
        (f.options || []).map(function (o, i) {
          var checked = f.value != null ? String(o.value) === String(f.value) : false;
          return '<label class="cd-choice"><input type="radio" name="' + esc(f.name) + '" value="' + esc(o.value) + '"' + (checked ? ' checked' : '') + (i === 0 && f.required ? ' required' : '') + '/>' +
            '<span><span class="cd-choice-t">' + esc(o.label) + '</span>' + (o.description ? '<span class="cd-choice-d" style="display:block;">' + esc(o.description) + '</span>' : '') + '</span></label>';
        }).join('') + '</div>';
      return '<div class="cd-field">' + label + control + help + '</div>';
    } else if (f.type === 'money') {
      control = '<div class="cd-money"><span aria-hidden="true">R$</span><input class="cd-input" id="' + id + '" name="' + esc(f.name) + '" inputmode="decimal" autocomplete="off" value="' + esc(formatMoneyInput(f.value)) + '"' + (ph || ' placeholder="0,00"') + req + describedby + '/></div>';
    } else {
      var type = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
      // suggestions: lista de valores já usados (vira <datalist>, o navegador sugere ao digitar).
      var list = f.suggestions && f.suggestions.length ? id + '-list' : '';
      control = '<input class="cd-input" type="' + type + '" id="' + id + '" name="' + esc(f.name) + '" value="' + esc(f.value) + '" autocomplete="off"' + (list ? ' list="' + list + '"' : '') + (type === 'tel' ? ' inputmode="tel"' : '') + ph + req + describedby + (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') + '/>' +
        (list ? '<datalist id="' + list + '">' + f.suggestions.map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join('') + '</datalist>' : '');
    }
    return '<div class="cd-field">' + label + control + help + '</div>';
  }

  function readValues(form, fields) {
    var values = {};
    fields.forEach(function (f) {
      if (f.type === 'choice') {
        var checked = form.querySelector('input[name="' + CSS_escape(f.name) + '"]:checked');
        values[f.name] = checked ? checked.value : '';
      } else {
        var el = form.querySelector('#' + f._id);
        var v = el ? el.value : '';
        values[f.name] = f.type === 'money' ? parseMoney(v) : (f.type === 'textarea' ? v : v.trim());
      }
    });
    return values;
  }
  function CSS_escape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

  function openDialog(innerHtml, setup) {
    ensureStyle();
    var dlg = document.createElement('dialog');
    dlg.className = 'cd-dialog';
    dlg.innerHTML = innerHtml;
    document.body.appendChild(dlg);
    var cleanup = function () { if (dlg.open) dlg.close(); dlg.remove(); };
    setup(dlg, cleanup);
    dlg.showModal();
    return dlg;
  }

  window.ctForm = function (opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    var titleId = 'cd-t-' + (++seq);
    return new Promise(function (resolve) {
      openDialog(
        '<form method="dialog" novalidate aria-labelledby="' + titleId + '">' +
          '<div class="cd-head">' +
            '<span class="cd-tile" aria-hidden="true">' + svg(opts.icon || 'pencil', 19) + '</span>' +
            '<div style="flex:1;min-width:0;"><h2 class="cd-title" id="' + titleId + '">' + esc(opts.title || '') + '</h2>' +
              (opts.description ? '<p class="cd-desc">' + esc(opts.description) + '</p>' : '') + '</div>' +
            '<button type="button" class="cd-close" data-cd-cancel aria-label="Fechar">' + svg('x', 18) + '</button>' +
          '</div>' +
          '<div class="cd-body">' + fields.map(fieldHtml).join('') +
            '<div class="cd-error" role="alert"><span style="flex-shrink:0;margin-top:1px;">' + svg('alert', 16) + '</span><span data-cd-error-text></span></div>' +
          '</div>' +
          '<div class="cd-foot">' +
            '<button type="button" class="cd-btn cd-btn-secondary" data-cd-cancel>' + esc(opts.cancelLabel || 'Cancelar') + '</button>' +
            '<button type="submit" class="cd-btn cd-btn-primary" data-cd-submit>' + svg('check', 16) + esc(opts.submitLabel || 'Salvar') + '</button>' +
          '</div>' +
        '</form>',
        function (dlg, cleanup) {
          var form = dlg.querySelector('form');
          var errBox = dlg.querySelector('.cd-error');
          var submitBtn = dlg.querySelector('[data-cd-submit]');
          var settled = false;
          function finish(value) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          }
          function showError(msg) {
            dlg.querySelector('[data-cd-error-text]').textContent = msg;
            errBox.classList.add('show');
          }
          dlg.querySelectorAll('[data-cd-cancel]').forEach(function (b) { b.addEventListener('click', function () { finish(null); }); });
          dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(null); });
          dlg.addEventListener('click', function (e) { if (e.target === dlg) finish(null); });
          form.addEventListener('submit', async function (e) {
            e.preventDefault();
            errBox.classList.remove('show');
            form.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
            var values = readValues(form, fields);
            var missing = fields.find(function (f) { return f.required && (values[f.name] === '' || values[f.name] == null); });
            if (missing) {
              var el = missing.type === 'choice' ? null : form.querySelector('#' + missing._id);
              if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
              showError(missing.type === 'choice' ? 'Escolha uma das opções.' : 'Preencha “' + (missing.label || missing.name) + '”.');
              return;
            }
            var problem = opts.validate ? opts.validate(values) : null;
            if (problem) { showError(problem); return; }
            if (opts.onSubmit) {
              submitBtn.disabled = true;
              try {
                var result = await opts.onSubmit(values);
                finish(result == null ? values : result); // 204 sem corpo também conta como salvo
              } catch (err) {
                submitBtn.disabled = false;
                showError((err && err.message) || 'Não foi possível salvar.');
              }
              return;
            }
            finish(values);
          });
          setTimeout(function () {
            var first = form.querySelector('.cd-body input:not([type=radio]), .cd-body textarea, .cd-body select, .cd-body input[type=radio]:checked, .cd-body input[type=radio]');
            if (first) { first.focus(); if (first.select && first.type !== 'radio' && first.tagName !== 'SELECT') first.select(); }
          }, 30);
        }
      );
    });
  };

  window.ctAlert = function (opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};
    var message = opts.message || '';
    var tone = opts.tone || (/^(Não foi possível|Não consegui|Erro|Falha)/i.test(message) ? 'error' : 'info');
    var title = opts.title || (tone === 'error' ? 'Não deu certo' : tone === 'success' ? 'Pronto!' : 'Aviso');
    var icon = tone === 'error' ? 'alert' : tone === 'success' ? 'check' : 'info';
    var titleId = 'cd-t-' + (++seq);
    return new Promise(function (resolve) {
      openDialog(
        '<form method="dialog" aria-labelledby="' + titleId + '">' +
          '<div class="cd-head" style="padding-bottom:0;">' +
            '<span class="cd-tile ' + tone + '" aria-hidden="true">' + svg(icon, 19) + '</span>' +
            '<div style="flex:1;min-width:0;"><h2 class="cd-title" id="' + titleId + '">' + esc(title) + '</h2>' +
              (message ? '<p class="cd-desc">' + esc(message) + '</p>' : '') + '</div>' +
          '</div>' +
          '<div class="cd-foot"><button type="submit" class="cd-btn cd-btn-primary" data-cd-ok>' + esc(opts.okLabel || 'Entendi') + '</button></div>' +
        '</form>',
        function (dlg, cleanup) {
          var done = false;
          function finish() { if (done) return; done = true; cleanup(); resolve(); }
          dlg.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); finish(); });
          dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(); });
          dlg.addEventListener('click', function (e) { if (e.target === dlg) finish(); });
          setTimeout(function () { dlg.querySelector('[data-cd-ok]').focus(); }, 30);
        }
      );
    });
  };

  window.ctParseMoney = parseMoney;
})();
