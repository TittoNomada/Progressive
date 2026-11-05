/*
 * Progressive — arayüz.
 * Basit bir yapı: tek bir `state` (kalıcı veri) + `ui` (geçici ekran durumu).
 * Her değişiklikte render() tüm ekranı yeniden çizer; olaylar data-action ile yakalanır.
 */
(function () {
  'use strict';

  // Her güncellemede artır (index.html'deki ?v= ve sw.js'deki VERSION ile aynı tut).
  const APP_VERSION = 14;

  const L = window.Logic;
  const Store = window.Store;
  const Seed = window.Seed;
  const storage = window.localStorage;

  let state = Store.load(storage);
  const ui = {
    view: state.activeWorkoutId ? 'workout' : 'home', // home | workout | summary | settings | history | detail | overview | exercise
    detailId: null,     // geçmişte açık antrenman
    ovKind: 'week',     // özet: 'week' | 'month'
    ovOffset: 0,        // özet: 0 = bu dönem, -1 = önceki ...
    histGroup: 'all',   // geçmiş sekmesi: 'all' ya da şablon id'si
    ovGroup: 'all',     // özet sekmesi
    focus: null,        // aktif antrenmanda açık olan hareket sırası
    drafts: {},         // { [exIndex]: { weight, reps, isWarmup } } henüz kaydedilmemiş set
    sheet: null,        // açık alt panel
    summaryWorkoutId: null,
    exerciseId: null,   // hareket sayfası
    exBack: 'home',     // hareket sayfasından dönülecek ekran
    chartSel: null,     // grafikte seçili nokta
  };

  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-root');
  const $toast = document.getElementById('toast');

  // ---------- Yardımcılar ----------

  function persist() { Store.save(storage, state); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso, withWeekday) {
    const d = new Date(iso);
    const opts = { day: 'numeric', month: 'short' };
    if (withWeekday) opts.weekday = 'short';
    return d.toLocaleDateString('tr-TR', opts);
  }

  function minutesSince(iso) {
    return Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  }

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => $toast.classList.remove('show'), 2200);
  }

  function exercise(id) {
    return state.exercises[id] || { id, name: id, type: 'weighted', weightStep: 2.5, machineSetting: '' };
  }

  function activeWorkout() {
    return state.workouts.find((w) => w.id === state.activeWorkoutId) || null;
  }

  function template(id) {
    return state.templates.find((t) => t.id === id) || null;
  }

  function prevSetsFor(exerciseId, excludeId) {
    const p = L.lastPerformance(state.workouts, exerciseId, excludeId);
    return p ? p : { workout: null, sets: [] };
  }

  function lastDoneDate(templateId) {
    const done = state.workouts
      .filter((w) => w.templateId === templateId && w.endedAt)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    return done[0] ? done[0].startedAt : null;
  }

  function weightLabel(type) {
    return type === 'bodyweight' ? 'Ek ağırlık' : type === 'assisted' ? 'Destek' : 'Ağırlık';
  }

  const PR_BADGE = '<span class="pr" title="Kişisel rekor" aria-label="Kişisel rekor">🏆</span>';

  // Bir antrenmandaki her hareketin rekor bayrakları (o antrenmandan önceki tüm kayıtlara göre)
  function workoutRecords(w) {
    return w.exercises.map((ex) => {
      const type = exercise(ex.exerciseId).type;
      return L.recordFlags(type, ex.sets, L.priorBest(state.workouts, type, ex.exerciseId, w.startedAt, w.id));
    });
  }

  function trendIcon(t) {
    return { up: '<span class="trend up">↑</span>', down: '<span class="trend down">↓</span>',
      same: '<span class="trend same">=</span>', new: '<span class="trend new">yeni</span>' }[t] || '';
  }

  // ---------- Antrenman işlemleri ----------

  function lastBodyWeight() {
    return L.bodyWeightStatus(state.workouts, 'week', new Date()).current;
  }

  function startWorkout(templateId, bodyWeight) {
    const t = template(templateId);
    const w = {
      id: Store.uid('w'),
      templateId,
      name: t ? t.name : 'Antrenman',
      startedAt: new Date().toISOString(),
      endedAt: null,
      bodyWeight: bodyWeight > 0 ? bodyWeight : null,
      sessionRpe: null,
      notes: '',
      exercises: (t ? t.items : []).map((it) => ({ exerciseId: it.exerciseId, targetSets: it.targetSets || 3, sets: [] })),
      cardio: [],
    };
    snapshotPlan(w);
    state.workouts.push(w);
    state.activeWorkoutId = w.id;
    ui.view = 'workout';
    ui.focus = w.exercises.length ? 0 : null;
    ui.drafts = {};
    persist();
    if (t && t.kind === 'cardio') openSheet({ type: 'cardio' });
    render();
    window.scrollTo(0, 0);
  }

  // Setin çalışma seti sırası (ısınmalar sayılmaz): 1, 2, 3
  function workNo(sets, si) { return sets.slice(0, si + 1).filter((x) => !x.isWarmup).length; }

  // Planlanan set sayısına sadece çalışma setleri sayılır; ısınma setleri ekstradır
  function workDone(ex) { return ex.sets.filter((s) => !s.isWarmup).length; }

  function focusIndex(w) {
    if (ui.focus !== null && ui.focus < w.exercises.length) return ui.focus;
    const i = w.exercises.findIndex((e) => workDone(e) < e.targetSets);
    return i === -1 ? null : i;
  }

  function draftFor(w, exIndex) {
    if (!ui.drafts[exIndex]) {
      const ex = w.exercises[exIndex];
      const prev = prevSetsFor(ex.exerciseId, w.id).sets;
      const e = exercise(ex.exerciseId);
      const d = L.prefill(prev, ex.sets, ex.sets.length, e);
      // Hedef (üst set ya da son setler) ve düşüş setleri doğrudan önerilen değerle dolar (tutturursan tek dokunuş)
      const plan = planFor(ex, e, prev, d.isWarmup);
      if (plan.draft) { d.weight = plan.draft.weight; d.reps = plan.draft.reps; }
      ui.drafts[exIndex] = d;
    }
    return ui.drafts[exIndex];
  }

  // Hedef düzeni (Ayarlar → Hedef önerisi): 'top' üst set + düşüş setleri (varsayılan), 'last1' / 'last2' piramit
  function targetMode() {
    const m = state.settings.targetMode;
    return m === 'top' || m === 'last1' || m === 'last2' ? m : 'top';
  }

  const TARGET_MODES = [
    { id: 'top', title: 'Üst set + düşüş setleri <span class="rec">önerilen</span>',
      desc: 'En ağır set ısınmadan hemen sonra, dinçken. Hedef bu sette. Sonraki setler aynı ağırlıkla; tekrar aralığın altına düşecekse %5–10 hafif.',
      example: ['<span class="muted">Isınma</span> 17,5×10', '<b>Set 1</b> 37,5×7 🎯 <span class="muted">üst set</span>',
        '<b>Set 2</b> 37,5×6 <span class="muted">aynı ağırlık</span>', '<b>Set 3</b> 35×7 <span class="muted">6\'ya ulaşamayacaksan biraz hafif</span>'] },
    { id: 'last1', title: 'Piramit · hedef son sette',
      desc: 'Hafiften ağıra çıkarsın, en ağır set sonda. Hedef sadece son sette; önceki setler geçen seferki gibi.',
      example: ['<b>Set 1</b> 32,5×9 <span class="muted">geçen seferki gibi</span>', '<b>Set 2</b> 35×8 <span class="muted">geçen seferki gibi</span>',
        '<b>Set 3</b> 37,5×7 🎯'] },
    { id: 'last2', title: 'Piramit · hedef son 2 sette',
      desc: 'Hafiften ağıra çıkarsın. Hedef son iki sette; ilk set geçen seferki gibi.',
      example: ['<b>Set 1</b> 32,5×9 <span class="muted">geçen seferki gibi</span>', '<b>Set 2</b> 35×9 🎯', '<b>Set 3</b> 37,5×7 🎯'] },
  ];

  function planFor(ex, e, prevSets, isWarmup) {
    return L.setPlan({ mode: targetMode(), exercise: e, prevSets, currentSets: ex.sets, plannedSets: ex.targetSets, isWarmup });
  }

  function confirmSet(exIndex) {
    const w = activeWorkout();
    const ex = w.exercises[exIndex];
    const d = draftFor(w, exIndex);
    if (!(d.reps > 0)) { toast('Tekrar sayısı 0 olamaz'); return; }
    const isBw = exercise(ex.exerciseId).type === 'bodyweight';
    ex.sets.push({
      id: Store.uid('s'),
      weight: d.weight,
      reps: d.reps,
      bodyWeight: isBw ? (w.bodyWeight || null) : null, // o günkü kilo (vücut ağırlığı hareketlerinde)
      isWarmup: !!d.isWarmup,
      isFailure: null,
      rir: null,
      completedAt: new Date().toISOString(),
    });
    delete ui.drafts[exIndex];
    persist();
    const type = exercise(ex.exerciseId).type;
    const flags = L.recordFlags(type, ex.sets, L.priorBest(state.workouts, type, ex.exerciseId, w.startedAt, w.id));
    if (flags[flags.length - 1]) toast('🏆 Yeni rekor: ' + L.formatSet(type, ex.sets[ex.sets.length - 1]));
    // Hareket bitti ise sıradaki bitmemiş harekete geç
    if (workDone(ex) >= ex.targetSets) {
      const next = w.exercises.findIndex((e, i) => i > exIndex && workDone(e) < e.targetSets);
      const any = next !== -1 ? next : w.exercises.findIndex((e) => workDone(e) < e.targetSets);
      ui.focus = any === -1 ? null : any;
      render();
      if (ui.focus !== null) scrollToCard(ui.focus);
    } else {
      render();
    }
  }

  function scrollToCard(i) {
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-card="' + i + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Uygulama içi onay penceresi (tarayıcının üstten çıkan confirm/alert'i yerine).
  // ok: true/false döner. cancel: null verilirse tek butonlu bilgi penceresi olur.
  function ask(opts) {
    const o = Object.assign({ title: '', message: '', ok: 'Tamam', cancel: 'Vazgeç', danger: false }, opts);
    const root = document.getElementById('dialog-root');
    return new Promise((resolve) => {
      root.innerHTML = '<div class="dialog-backdrop" data-dialog="cancel"></div>' +
        '<div class="dialog" role="alertdialog" aria-modal="true">' +
        (o.title ? '<h3>' + esc(o.title) + '</h3>' : '') +
        (o.message ? '<p>' + esc(o.message) + '</p>' : '') +
        '<div class="dialog-actions">' +
        (o.cancel ? '<button class="dialog-cancel" data-dialog="cancel">' + esc(o.cancel) + '</button>' : '') +
        '<button class="primary' + (o.danger ? ' danger-fill' : '') + '" data-dialog="ok">' + esc(o.ok) + '</button>' +
        '</div></div>';
      const done = (v) => {
        root.innerHTML = '';
        root.onclick = null;
        resolve(v);
      };
      root.onclick = (ev) => {
        const b = ev.target.closest('[data-dialog]');
        if (!b) return;
        ev.stopPropagation();
        done(b.dataset.dialog === 'ok' || (!o.cancel && b.dataset.dialog === 'cancel'));
      };
      const okBtn = root.querySelector('[data-dialog="ok"]');
      if (okBtn) okBtn.focus({ preventScroll: true });
    });
  }

  async function finishWorkout() {
    const w = activeWorkout();
    if (!w) return;
    const hasSets = w.exercises.some((e) => e.sets.length);
    const hasCardio = w.cardio.length > 0;
    if (!hasSets && !hasCardio) {
      const del = await ask({ title: 'Antrenman boş', message: 'Hiç set veya kardiyo kaydedilmedi. Antrenman silinsin mi?',
        ok: 'Sil', danger: true });
      if (del) discardWorkout(true);
      return;
    }
    const left = w.exercises.reduce((t, e) => t + Math.max(0, e.targetSets - workDone(e)), 0);
    const ok = await ask({
      title: 'Antrenmanı bitir?',
      message: left ? left + ' planlı set yapılmadı, kayda geçmeyecek.' : 'Tüm planlı setleri tamamladın.',
      ok: 'Bitir',
    });
    if (!ok) return;
    // Hiç set girilmemiş hareketleri kayıttan çıkar
    w.exercises = w.exercises.filter((e) => e.sets.length);
    w.endedAt = new Date().toISOString();
    state.activeWorkoutId = null;
    // Antrenman içindeki ekleme/çıkarma/sıra değişiklikleri sadece bu antrenmana aittir;
    // günlerin kalıcı listesi yalnızca Ayarlar'dan değişir.
    delete w._plan;
    persist();
    ui.summaryWorkoutId = w.id;
    ui.view = 'summary';
    ui.focus = null;
    ui.drafts = {};
    render();
    window.scrollTo(0, 0);
  }

  // Antrenmandaki hareket listesi değiştiğinde güncel planı sakla (şablon önerisi için).
  function snapshotPlan(w) {
    w._plan = w.exercises.map((e) => ({ exerciseId: e.exerciseId, targetSets: e.targetSets }));
  }

  async function discardWorkout(silent) {
    const w = activeWorkout();
    if (!w) return;
    if (!silent && !(await ask({ title: 'Antrenmanı sil?', message: 'Bu antrenman ve girilen tüm setler silinecek.',
      ok: 'Sil', danger: true }))) return;
    state.workouts = state.workouts.filter((x) => x.id !== w.id);
    state.activeWorkoutId = null;
    persist();
    ui.view = 'home';
    ui.focus = null;
    ui.drafts = {};
    closeSheet();
    render();
  }

  // ---------- Ekranlar ----------

  const TAB_VIEWS = ['home', 'history', 'overview'];

  function render() {
    if (ui.view === 'workout' && !activeWorkout()) ui.view = 'home';
    if (ui.view === 'detail' && !state.workouts.some((w) => w.id === ui.detailId)) ui.view = 'history';
    let html;
    try {
      html = renderView();
    } catch (err) {
      // Bir ekran çizilemezse sessizce donmak yerine hatayı göster ve geri dönüş yolu bırak
      console.error(err);
      html = '<header class="top"><button class="icon-btn" data-action="go-home" aria-label="Ana sayfa">‹</button>' +
        '<div class="center"><h2>Bu ekran açılamadı</h2></div><span class="icon-btn"></span></header>' +
        '<section class="card"><p>Bir hata oluştu, verilerin güvende. Bu ekranın görüntüsünü Claude\'a gönder.</p>' +
        '<p class="muted small error-text">' + esc((ui.view || '') + ': ' + (err && err.message ? err.message : String(err))) + '</p></section>' +
        '<button class="primary wide" data-action="go-home">Ana sayfa</button>';
    }
    const tabs = TAB_VIEWS.includes(ui.view);
    document.body.classList.toggle('has-tabbar', tabs);
    $app.innerHTML = html + (tabs ? renderTabbar() : '');
    renderSheet();
  }

  function renderView() {
    return ui.view === 'workout' ? renderWorkout()
      : ui.view === 'summary' ? renderSummary()
      : ui.view === 'settings' ? renderSettings()
      : ui.view === 'history' ? renderHistory()
      : ui.view === 'detail' ? renderDetail()
      : ui.view === 'overview' ? renderOverview()
      : ui.view === 'exercise' ? renderExercisePage()
      : renderHome();
  }

  // ---------- Alt sekmeler ----------

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 7v10M3.5 9.5v5M17.5 7v10M20.5 9.5v5M6.5 12h11"/></svg>',
    history: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    overview: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20v-7M12 20V5M19 20v-10"/></svg>',
  };

  function renderTabbar() {
    const tab = (v, label) => '<button class="tab' + (ui.view === v ? ' on' : '') + '" data-action="tab" data-v="' + v + '"' +
      (ui.view === v ? ' aria-current="page"' : '') + '>' + ICONS[v] + '<span>' + label + '</span></button>';
    return '<nav class="tabbar">' + tab('home', 'Antrenman') + tab('history', 'Geçmiş') + tab('overview', 'Özet') + '</nav>';
  }

  // ---------- Geçmiş ----------

  // Liste başlıkları: "Bu hafta", "Geçen hafta", sonra ay ay ("Ekim 2026")
  function historyGroup(iso, now) {
    const t = new Date(iso);
    const w0 = L.periodRange('week', now, 0);
    const w1 = L.periodRange('week', now, -1);
    if (t >= w0.start) return 'Bu hafta';
    if (t >= w1.start) return 'Geçen hafta';
    return L.MONTHS_TR[t.getMonth()] + ' ' + t.getFullYear();
  }

  function workoutMeta(w) {
    const st = L.workoutStats(w);
    return [
      st.exercises ? st.exercises + ' hareket · ' + st.sets + ' set' : '',
      st.cardioMinutes ? st.cardioMinutes + ' dk kardiyo' : '',
      st.durationMin ? st.durationMin + ' dk' : '',
    ].filter(Boolean).join(' · ');
  }

  // Tümü · Push · Pull · (yeni günler) · Kardiyo sekmeleri
  function groupChips(current, action) {
    const groups = [{ id: 'all', name: 'Tümü' }].concat(L.workoutGroups(state));
    return '<div class="chips-row" role="tablist">' + groups.map((g) =>
      '<button class="chip-tab' + (current === g.id ? ' on' : '') + '" data-action="' + action + '" data-g="' + esc(g.id) + '" role="tab"' +
      (current === g.id ? ' aria-selected="true"' : '') + '>' + esc(g.kind === 'cardio' ? 'Kardiyo' : g.name) + '</button>').join('') + '</div>';
  }

  function validGroup(g) {
    return g === 'all' || L.workoutGroups(state).some((x) => x.id === g) ? g : 'all';
  }

  function renderHistory() {
    const now = new Date();
    ui.histGroup = validGroup(ui.histGroup);
    const list = L.history(state.workouts).filter((w) => L.inGroup(w, ui.histGroup));
    let html = '<header class="top"><div><h1>Geçmiş</h1><p class="muted">' + list.length + ' antrenman</p></div></header>' +
      groupChips(ui.histGroup, 'hist-group');
    if (!list.length) {
      return html + '<p class="muted empty">' + (ui.histGroup === 'all'
        ? 'Henüz bitmiş antrenman yok. İlk antrenmanını bitirince burada görünecek.'
        : 'Bu türde henüz kayıt yok.') + '</p>';
    }
    let group = null;
    for (const w of list) {
      const g = historyGroup(w.startedAt, now);
      if (g !== group) { html += '<p class="section-label">' + esc(g) + '</p>'; group = g; }
      html += '<button class="hist-card" data-action="open-workout" data-id="' + esc(w.id) + '">' +
        '<span class="hist-top"><b>' + esc(w.name) + '</b><span class="muted small">' + esc(fmtDate(w.startedAt, true)) + '</span></span>' +
        '<span class="muted small">' + esc(workoutMeta(w) || 'Boş kayıt') + '</span></button>';
    }
    return html;
  }

  function renderDetail() {
    const w = state.workouts.find((x) => x.id === ui.detailId);
    const d = new Date(w.startedAt);
    const when = L.dateTr(w.startedAt, { withTime: true }) + ', ' + d.toLocaleDateString('tr-TR', { weekday: 'long' });
    const records = workoutRecords(w);
    const cards = w.exercises.map((ex, i) => {
      const e = exercise(ex.exerciseId);
      const best = L.bestSet(e.type, ex.sets);
      const rows = ex.sets.map((s, si) =>
        '<button class="set-row done" data-action="edit-set" data-w="' + esc(w.id) + '" data-ex="' + i + '" data-si="' + si + '">' +
        '<span class="set-no">' + (s.isWarmup ? 'Is' : workNo(ex.sets, si)) + '</span>' +
        '<span class="set-val' + (s.isWarmup ? ' warm' : '') + '">' + esc(L.formatSet(e.type, s)) + '</span>' +
        (s === best ? '<span class="best-tag">en iyi</span>' : '') + (records[i][si] ? PR_BADGE : '') +
        '<span class="edit-hint">✎</span></button>').join('');
      return '<section class="card">' + exerciseTitle(e) + '<div class="sets">' +
        (rows || '<p class="muted small">Set yok</p>') + '</div></section>';
    }).join('');
    const cardio = w.cardio.map((c, i) => cardioRow(c, i, w.id)).join('');
    return '<header class="top"><button class="icon-btn" data-action="tab" data-v="history" aria-label="Geçmiş">‹</button>' +
      '<div class="center"><h2>' + esc(w.name) + '</h2><p class="muted small">' + esc(when) + '</p></div><span class="icon-btn"></span></header>' +
      '<p class="muted small detail-meta">' + esc(workoutMeta(w)) + ' · düzeltmek için bir sete dokun</p>' +
      cards +
      '<section class="cardio-section"><p class="section-label">Kardiyo</p>' + cardio +
      '<button class="ghost-btn" data-action="add-cardio" data-w="' + esc(w.id) + '">+ Kardiyo ekle</button></section>' +
      '<button class="text-btn danger" data-action="delete-workout" data-id="' + esc(w.id) + '">Bu antrenmanı sil</button>';
  }

  // Hareket adı: dokununca hareket sayfası (grafik, rekorlar) açılır
  function exerciseTitle(e) {
    return '<h3><button class="link-name" data-action="open-exercise" data-id="' + esc(e.id) + '">' + esc(e.name) +
      ' <span class="chev">›</span></button></h3>';
  }

  // ---------- Hareket sayfası: gelişim grafiği, rekorlar, son antrenmanlar ----------

  function renderExercisePage() {
    const e = exercise(ui.exerciseId);
    const h = L.exerciseHistory(state, e.id);
    const isReps = h.metric === 'reps';
    const one = (v) => L.fmtNum(Math.round(v * 10) / 10);
    const unit = isReps ? ' tekrar' : ' kg';
    const r = L.repRange(e);
    const header = '<header class="top"><button class="icon-btn" data-action="ex-back" aria-label="Geri">‹</button>' +
      '<div class="center"><h2>' + esc(e.name) + '</h2><p class="muted small">' +
      (isReps ? 'Vücut ağırlığı · tekrar' : 'Tekrar aralığı ' + r.min + '–' + r.max) + '</p></div>' +
      '<button class="icon-btn" data-action="edit-exercise" data-id="' + esc(e.id) + '" aria-label="Hareket ayarları">⚙︎</button></header>';
    if (!h.sessions.length) {
      const inProgress = (activeWorkout() || { exercises: [] }).exercises.some((x) => x.exerciseId === e.id && x.sets.length);
      return header + '<section class="card"><p class="section-label">' + (isReps ? 'En iyi setteki tekrar' : 'Güç puanı') + '</p>' +
        chartPlaceholder('Henüz kayıt yok.', inProgress
          ? 'Bu antrenmanı bitirince ilk kaydın burada görünür. Grafik ikinci antrenmandan sonra çizilir.'
          : 'Bu hareketle ilk antrenmanını bitirince kaydın burada görünür. Grafik ikinci antrenmandan sonra çizilir.') + '</section>';
    }
    const best = h.bestSession;
    const tile = (big, small, sub) => '<div class="tile"><b>' + big + '</b><span>' + small + '</span>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';
    const tiles = '<div class="tiles">' +
      tile(esc(L.formatSet(h.type, best.best)), 'en iyi setin', esc(L.dateTr(best.date, { noYear: true }))) +
      tile(h.sessions.length, 'antrenman', h.prCount ? h.prCount + ' kez rekor kırıldı' : 'henüz rekor yok') +
      '</div>';

    const recent = h.sessions.slice().reverse().slice(0, 12).map((x) =>
      '<button class="hist-card" data-action="open-workout" data-id="' + esc(x.workoutId) + '">' +
      '<span class="hist-top"><b>' + esc(L.dateTr(x.date, { noYear: true })) + ' <span class="muted small">' + esc(x.workoutName || '') + '</span></b>' +
      '<span class="small">' + (x.isPR ? PR_BADGE + ' ' : '') + 'en iyi ' + esc(L.formatSet(h.type, x.best)) + '</span></span>' +
      '<span class="muted small">' + x.sets.map((st) => (st.isWarmup ? 'Is ' : '') + L.formatSet(h.type, st)).map(esc).join(' · ') + '</span></button>').join('');

    return header +
      '<section class="card">' + renderChart(h, isReps, unit) + '</section>' +
      tiles +
      '<p class="section-label">Son antrenmanlar</p>' + recent;
  }

  // Grafik çizilemediğinde (0–1 kayıt) grafiğin yerinde duran açıklama kutusu
  function chartPlaceholder(title, text) {
    return '<div class="chart-empty"><span class="chart-empty-icon" aria-hidden="true">📈</span>' +
      '<p><b>' + esc(title) + '</b></p><p class="muted small">' + esc(text) + '</p></div>';
  }

  // Sade çizgi grafik: her antrenmanın en iyi seti tek sayıya çevrilir (kg: güç puanı = tahmini 1RM, vücut ağırlığı: tekrar).
  // Üstte tek cümlelik özet; çizgide yalnızca rekorlar işaretli; dokunulan antrenman altta yazılır.
  function renderChart(h, isReps, unit) {
    const pts = h.sessions;
    const one = (v) => L.fmtNum(Math.round(v * 10) / 10);
    const day = (iso) => L.dateTr(iso, { noYear: true });
    const name = isReps ? 'En iyi setteki tekrar' : 'Güç puanı';
    const help = isReps ? '' : '<p class="muted small chart-help">Güç puanı, en iyi setinin ağırlığını ve tekrarını tek sayıda birleştirir. ' +
      'Çizgi yukarı gidiyorsa güçleniyorsun.</p>';
    if (pts.length < 2) {
      return '<p class="section-label">' + name + '</p>' + chartPlaceholder(
        'Grafik ikinci antrenmandan sonra çizilir.',
        'Şimdilik 1 kayıt var: ' + day(pts[0].date) + ' · en iyi set ' + L.formatSet(h.type, pts[0].best) + '. ' +
        'Bu hareketi bir kez daha yapınca gelişim çizgin burada başlar.');
    }
    const first = pts[0], last = pts[pts.length - 1];
    const diff = last.score - first.score;
    const change = isReps
      ? (diff > 0 ? '+' : '') + one(diff) + ' tekrar'
      : (h.changePct > 0 ? '+' : '') + L.fmtNum(h.changePct) + '%';
    const head = '<p class="section-label">' + name + '</p>' +
      '<p class="chart-head"><span class="muted">' + one(first.score) + ' → </span><b>' + one(last.score) + unit + '</b> ' +
      '<span class="prog-pct ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'same') + '">' + change + '</span></p>' +
      '<p class="muted small">' + esc(day(first.date)) + ' – ' + esc(day(last.date)) + ' · ' + pts.length + ' antrenman</p>';

    const sel = ui.chartSel !== null && ui.chartSel < pts.length ? ui.chartSel : null;
    const W = 340, H = 150, padL = 30, padR = 10, padT = 12, padB = 22;
    const ys = pts.map((x) => x.score);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
    const t0 = new Date(first.date).getTime(), t1 = new Date(last.date).getTime();
    const X = (x) => padL + ((new Date(x.date).getTime() - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const grid = [lo, hi].map((v) => {
      const y = Y(v).toFixed(1);
      return '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '"/>' +
        '<text class="axis" x="' + (padL - 6) + '" y="' + y + '" dy="0.35em" text-anchor="end">' + Math.round(v) + '</text>';
    }).join('');
    const line = '<polyline class="series" points="' + pts.map((x) => X(x).toFixed(1) + ',' + Y(x.score).toFixed(1)).join(' ') + '"/>';
    const dots = pts.map((x, i) => (x.isPR || i === sel || i === pts.length - 1)
      ? '<circle class="dot-pt' + (x.isPR ? ' pr' : '') + (i === sel ? ' sel' : '') + '" cx="' + X(x).toFixed(1) +
        '" cy="' + Y(x.score).toFixed(1) + '" r="' + (i === sel ? 7 : 5) + '"/>' : '').join('');
    const xs = pts.map(X);
    const hits = pts.map((x, i) => {
      const a = i === 0 ? 0 : (xs[i - 1] + xs[i]) / 2;
      const b = i === pts.length - 1 ? W : (xs[i] + xs[i + 1]) / 2;
      return '<rect class="hit" data-action="chart-pt" data-i="' + i + '" x="' + a.toFixed(1) + '" y="0" width="' + Math.max(1, b - a).toFixed(1) + '" height="' + H + '"/>';
    }).join('');
    const dates = '<text class="axis" x="' + padL + '" y="' + (H - 4) + '">' + esc(day(first.date)) + '</text>' +
      '<text class="axis" x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(day(last.date)) + '</text>';
    const p = sel === null ? null : pts[sel];
    const readout = p
      ? '<p class="small chart-read">' + (p.isPR ? PR_BADGE + ' ' : '') + '<b>' + esc(day(p.date)) + ':</b> en iyi set ' + esc(L.formatSet(h.type, p.best)) +
        (isReps ? '' : ' <span class="muted">(güç puanı ' + one(p.score) + ')</span>') + '</p>'
      : '<p class="muted small chart-read"><i class="lg-dot pr"></i> rekor kırdığın antrenmanlar · bir güne dokun, o günün setini gör</p>';
    return head +
      '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(name + ': ' + one(first.score) + ' → ' + one(last.score)) + '">' +
      grid + line + dots + dates + hits + '</svg>' + readout + help;
  }

  function cardioRow(c, i, workoutId) {
    const type = (Seed.CARDIO_TYPES.find((x) => x.id === c.type) || { name: c.type }).name;
    const extra = [c.distanceKm ? L.fmtNum(c.distanceKm) + ' km' : '', c.difficulty ? 'zorluk ' + c.difficulty + '/10' : '']
      .filter(Boolean).join(' · ');
    return '<button class="row-btn" data-action="edit-cardio" data-i="' + i + '"' + (workoutId ? ' data-w="' + esc(workoutId) + '"' : '') + '><b>' +
      esc(type) + '</b> ' + c.minutes + ' dk' + (extra ? ' <span class="muted">· ' + esc(extra) + '</span>' : '') + '</button>';
  }

  // ---------- Özet ----------

  function renderOverview() {
    const now = new Date();
    const kind = ui.ovKind;
    ui.ovGroup = validGroup(ui.ovGroup);
    const range = L.periodRange(kind, now, ui.ovOffset);
    const sum = L.summarize(state, kind, range.start, ui.ovGroup);
    const label = L.periodLabel(kind, ui.ovOffset, range);
    const prevName = kind === 'week' ? 'önceki haftaya' : 'önceki aya';

    const seg = (k, n) => '<button class="seg' + (kind === k ? ' on' : '') + '" data-action="ov-kind" data-k="' + k + '">' + n + '</button>';
    const nav = '<div class="period-nav">' +
      '<button class="icon-btn" data-action="ov-shift" data-dir="-1" aria-label="Önceki">‹</button>' +
      '<span class="period-label">' + esc(label) + '</span>' +
      '<button class="icon-btn" data-action="ov-shift" data-dir="1" aria-label="Sonraki"' + (ui.ovOffset >= 0 ? ' disabled' : '') + '>›</button></div>';

    const weeklyGoal = state.settings.weeklyCardioGoal || 150;
    const daysInPeriod = Math.round((range.end - range.start) / 86400000);
    const goal = kind === 'week' ? weeklyGoal : Math.round(weeklyGoal * daysInPeriod / 7);
    const pct = Math.min(100, Math.round((sum.cardioMinutes / goal) * 100));

    const tile = (big, small, sub) => '<div class="tile"><b>' + big + '</b><span>' + small + '</span>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';
    const tiles = '<div class="tiles">' +
      tile(sum.workoutCount, 'antrenman', sum.strengthCount + ' ağırlık · ' + sum.cardioOnlyCount + ' kardiyo') +
      tile(sum.trainingDays, 'antrenman günü', kind === 'week' ? '7 günde' : daysInPeriod + ' günde') +
      tile(sum.totalSets, 'çalışma seti', 'ısınma hariç') +
      tile(sum.cardioMinutes, 'dk kardiyo', 'hedef ' + goal + ' dk') +
      '</div>' +
      '<div class="bar" aria-label="Kardiyo hedefi"><i style="width:' + pct + '%"></i></div>' +
      '<p class="muted small">' + sum.cardioMinutes + ' / ' + goal + ' dk kardiyo</p>';

    let strip = '';
    if (sum.days) {
      const names = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
      const today = L.dayKey(now);
      strip = '<div class="day-strip">' + sum.days.map((d, i) =>
        '<div class="day' + (L.dayKey(d.date) === today ? ' today' : '') + '"><span>' + names[i] + '</span>' +
        '<i class="dot' + (d.strength ? ' s' : '') + (d.cardio ? ' c' : '') + '"></i></div>').join('') + '</div>' +
        '<p class="muted small legend"><i class="dot s"></i> ağırlık <i class="dot c"></i> kardiyo</p>';
    }

    let progress = '';
    if (sum.exerciseProgress.length) {
      const one = (v) => L.fmtNum(Math.round(v * 10) / 10);
      const rows = sum.exerciseProgress.map((p) => {
        const e = exercise(p.exerciseId);
        const unit = p.metric === 'reps' ? ' tekrar' : ' kg';
        const values = (p.prevAvg !== null ? '<span class="muted">' + one(p.prevAvg) + ' → </span>' : '') +
          '<b>' + one(p.avg) + unit + '</b>';
        let change = '';
        if (p.trend !== 'new' && p.prevAvg !== null) {
          change = p.metric === 'e1rm'
            ? (p.pct > 0 ? '+' : '') + L.fmtNum(p.pct) + '%'
            : (p.avg - p.prevAvg > 0 ? '+' : '') + one(p.avg - p.prevAvg);
        }
        const sub = p.sessions + ' antrenman · en iyi set ' + L.formatSet(e.type, p.best) +
          (p.comparedTo === 'earlier' ? ' · önceki dönemde yok, son antrenmanla kıyas' : '');
        return '<button class="prog-row" data-action="open-exercise" data-id="' + esc(e.id) + '"><span class="prog-main"><span class="prog-name">' + esc(e.name) + ' <span class="chev">›</span></span>' +
          '<span class="prog-val">' + values + ' ' + trendIcon(p.trend) + (change ? '<span class="prog-pct ' + p.trend + '">' + change + '</span>' : '') + '</span></span>' +
          '<span class="muted small prog-sub">' + esc(sub) + '</span></button>';
      }).join('');
      const allNew = sum.exerciseProgress.every((p) => p.trend === 'new');
      const headline = allNew ? 'Bu hareketler ilk kez kaydedildi'
        : sum.upCount
          ? sum.upCount + ' harekette ' + prevName + ' göre ilerleme' + (sum.downCount ? ', ' + sum.downCount + ' harekette düşüş' : '')
          : sum.downCount
            ? sum.downCount + ' harekette ' + prevName + ' göre düşüş'
            : 'Önceki döneme göre aynı seviyede';
      progress = '<section class="card"><p class="section-label">Hareketlerde ilerleme</p>' +
        '<p class="small progress-head">' + esc(headline) + '</p>' +
        '<p class="muted small progress-help">Her antrenmandaki en iyi setinin ortalaması. kg: tahmini 1RM (tek tekrarda kaldırabileceğin tahmini ağırlık); vücut ağırlığında tekrar.</p>' +
        rows + '</section>';
    }

    const empty = sum.workoutCount ? '' : '<p class="muted empty">Bu dönemde kayıt yok.</p>';

    return '<header class="top"><div><h1>Özet</h1></div><div class="segmented">' + seg('week', 'Hafta') + seg('month', 'Ay') + '</div></header>' +
      groupChips(ui.ovGroup, 'ov-group') +
      nav + '<section class="card">' + tiles + strip + '</section>' + empty + progress;
  }

  function renderHome() {
    const w = activeWorkout();
    const now = new Date();
    const week = L.summarize(state, 'week', now);
    const realWorkouts = state.workouts.filter((x) => x.endedAt && !String(x.id).startsWith('seed-')).length;
    const needBackup = realWorkouts > 0 && L.daysSince(state.settings.lastBackupAt, now) >= 7;

    let main;
    if (w) {
      const sets = w.exercises.reduce((t, e) => t + e.sets.length, 0);
      main = '<button class="big-card resume" data-action="resume">' +
        '<span class="eyebrow">Devam eden antrenman</span>' +
        '<span class="big-title">' + esc(w.name) + '</span>' +
        '<span class="muted">' + minutesSince(w.startedAt) + ' dk · ' + sets + ' set</span>' +
        '<span class="cta">Devam et →</span></button>';
    } else {
      main = '<p class="section-label">Antrenmana başla</p><div class="template-list">' +
        state.templates.map((t) => {
          const last = lastDoneDate(t.id);
          const sub = t.kind === 'cardio' ? 'Sadece kardiyo kaydı'
            : t.items.length + ' hareket' + (last ? ' · son: ' + fmtDate(last) : '');
          return '<button class="big-card" data-action="start" data-id="' + esc(t.id) + '">' +
            '<span class="big-title">' + esc(t.name) + '</span>' +
            '<span class="muted">' + esc(sub) + '</span></button>';
        }).join('') + '</div>';
    }

    const backup = needBackup
      ? '<button class="banner" data-action="go-settings">💾 ' +
        (state.settings.lastBackupAt
          ? 'Son yedeğin üzerinden ' + L.daysSince(state.settings.lastBackupAt, now) + ' gün geçti.'
          : 'Henüz hiç yedek almadın.') +
        ' Yedek al →</button>'
      : '';

    const goal = state.settings.weeklyCardioGoal || 150;
    const pct = Math.min(100, Math.round((week.cardioMinutes / goal) * 100));
    const weekBox = '<div class="week-box">' +
      '<div class="week-head"><p class="section-label">Bu hafta</p>' +
      '<button class="link-btn" data-action="tab" data-v="overview">Özet →</button></div>' +
      '<div class="stats"><div><b>' + week.strengthCount + '</b><span>ağırlık</span></div>' +
      '<div><b>' + week.cardioOnlyCount + '</b><span>sadece kardiyo</span></div>' +
      '<div><b>' + week.cardioMinutes + '</b><span>dk kardiyo</span></div></div>' +
      '<div class="bar" aria-label="Haftalık kardiyo hedefi"><i style="width:' + pct + '%"></i></div>' +
      '<p class="muted small">' + week.cardioMinutes + ' / ' + goal + ' dk kardiyo hedefi</p>' +
      bodyWeightLine(now) + '</div>';

    const lb = state.settings.lastBackupAt;
    const footer = '<p class="muted small center-text">' +
      (lb ? 'Son yedek: ' + L.dateTr(lb, { noYear: true }) + ' (' + L.relativeDay(lb, now) + ')' : 'Henüz yedek alınmadı') +
      ' · sürüm ' + APP_VERSION + '</p>';

    return '<header class="top"><div><h1>Progressive</h1><p class="muted">' +
      esc(now.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })) + '</p></div>' +
      '<button class="icon-btn" data-action="go-settings" aria-label="Ayarlar">⚙︎</button></header>' +
      backup + main + weekBox + footer;
  }

  // Sadece haftalık karşılaştırma: ~1 hafta önceki ölçüm → son ölçüm
  function bodyWeightLine(now) {
    const bw = L.weeklyBodyWeight(state.workouts);
    if (!bw) return '';
    if (bw.weekAgo === null) {
      return '<p class="small bw-line muted">⚖︎ Kilon kaydediliyor; 1 hafta sonra haftalık değişim burada görünecek.</p>';
    }
    const day = (iso) => (L.relativeDay(iso, now) === 'bugün' ? 'bugün' : L.dateTr(iso, { noYear: true }));
    const sign = bw.change > 0 ? '+' : '';
    const diff = bw.change === 0 ? 'değişmedi' : sign + L.fmtNum(bw.change) + ' kg';
    return '<div class="bw-line"><p class="small muted">⚖︎ Haftalık kilo</p>' +
      '<p class="bw-compare"><span class="muted">' + esc(L.dateTr(bw.weekAgoAt, { noYear: true })) + ':</span> ' + L.fmtNum(bw.weekAgo) +
      ' → <span class="muted">' + esc(day(bw.currentAt)) + ':</span> <b>' + L.fmtNum(bw.current) + ' kg</b>' +
      ' <span class="bw-diff' + (bw.change < 0 ? ' down' : bw.change > 0 ? ' up' : '') + '">(' + diff + ')</span></p></div>';
  }

  function renderWorkout() {
    const w = activeWorkout();
    const fi = focusIndex(w);
    const totalSets = w.exercises.reduce((t, e) => t + e.sets.length, 0);

    const cards = w.exercises.map((ex, i) => renderExerciseCard(w, ex, i, i === fi)).join('');

    const cardio = w.cardio.map((c, i) => cardioRow(c, i, null)).join('');

    return '<header class="top sticky">' +
      '<button class="icon-btn" data-action="go-home" aria-label="Ana sayfa">‹</button>' +
      '<div class="center"><h2>' + esc(w.name) + '</h2><p class="muted small" id="elapsed">' +
      minutesSince(w.startedAt) + ' dk · ' + totalSets + ' set</p></div>' +
      '<button class="pill-btn" data-action="finish">Bitir</button></header>' +
      cards +
      '<button class="ghost-btn" data-action="add-exercise">+ Hareket ekle</button>' +
      '<section class="cardio-section"><p class="section-label">Kardiyo</p>' + cardio +
      '<button class="ghost-btn" data-action="add-cardio">+ Kardiyo ekle</button></section>' +
      '<button class="primary wide" data-action="finish">Antrenmanı bitir</button>' +
      '<button class="text-btn danger" data-action="discard">Antrenmanı sil</button>';
  }

  function renderExerciseCard(w, ex, i, focused) {
    const e = exercise(ex.exerciseId);
    const prev = prevSetsFor(ex.exerciseId, w.id);
    const done = workDone(ex) >= ex.targetSets;
    const prevLine = prev.sets.length
      ? '<p class="prev">Geçen sefer <span class="muted">(' + fmtDate(prev.workout.startedAt) + ')</span>: ' +
        prev.sets.map((s) => '<span class="' + (s.isWarmup ? 'warm' : '') + '">' + esc(L.formatSet(e.type, s)) + '</span>').join(' · ') + '</p>'
      : '<p class="prev muted">İlk kez yapıyorsun</p>';


    const flags = L.recordFlags(e.type, ex.sets, L.priorBest(state.workouts, e.type, ex.exerciseId, w.startedAt, w.id));
    const prevWork = prev.sets.filter((x) => !x.isWarmup);
    const doneSets = ex.sets.map((s, si) => {
      const p = s.isWarmup ? null : prevWork[workNo(ex.sets, si) - 1];
      let t = '';
      if (p && !s.isWarmup && !p.isWarmup) t = trendIcon(L.trend(e.type, p, s));
      return '<button class="set-row done" data-action="edit-set" data-ex="' + i + '" data-si="' + si + '">' +
        '<span class="set-no">' + (s.isWarmup ? 'Is' : workNo(ex.sets, si)) + '</span>' +
        '<span class="set-val">' + esc(L.formatSet(e.type, s)) + '</span>' + t + (flags[si] ? PR_BADGE : '') +
        '<span class="check">✓</span></button>';
    }).join('');

    let active = '';
    if (focused && !done) {
      const d = draftFor(w, i);
      const n = workDone(ex) + 1;
      const plan = planFor(ex, e, prev.sets, d.isWarmup);
      const tg = plan.target;
      const r = L.repRange(e);
      const onTarget = tg && d.weight === tg.weight && d.reps === tg.reps;
      const target = tg
        ? '<button class="target' + (onTarget ? ' on' : '') + '" data-action="apply-target" data-ex="' + i + '" data-tw="' + tg.weight +
          '" data-tr="' + tg.reps + '">🎯 ' + (plan.role === 'top' ? 'Üst set hedefi' : 'Hedef') + ': <b>' + esc(L.formatSet(e.type, tg)) + '</b>' +
          '<span class="muted small">' + (tg.kind === 'weight' ? ' · ağırlığı artır' : ' · +1 tekrar') +
          (onTarget ? '' : ' · uygula') + '</span></button>'
        : plan.role === 'backoff'
          ? '<p class="muted small easy-set"><b class="plain">Düşüş seti</b> · ' +
            (plan.lighter !== null && plan.lighter !== undefined
              ? 'tekrar ' + r.min + '–' + r.max + ' arasında kalsın; ' + r.min + ' tekrara ulaşamayacaksan ağırlığı azalt (üst setten %5–10 hafif ≈ ' + esc(L.fmtNum(plan.lighter)) + ' kg).'
              : 'aynı şekilde devam et, tekrarın düşmesi normal.') + '</p>'
          : plan.role === 'prep' && plan.ref
            ? '<p class="muted small easy-set">Hazırlık seti · geçen seferki gibi (' + esc(L.formatSet(e.type, plan.ref)) + '). Hedef son ' +
              (targetMode() === 'last1' ? 'sette' : '2 sette') + '.</p>'
            : '';
      active = '<div class="active-set">' +
        '<div class="active-head"><span>' + (d.isWarmup ? 'Isınma seti' : 'Set ' + n + (ex.targetSets ? ' / ' + ex.targetSets : '')) + '</span>' +
        '<button class="chip' + (d.isWarmup ? ' on' : '') + '" data-action="toggle-warmup" data-ex="' + i + '">Isınma</button></div>' +
        target +
        '<div class="steppers">' +
        stepper(weightLabel(e.type) + ' (kg)', 'weight', i, L.fmtNum(d.weight)) +
        stepper('Tekrar', 'reps', i, String(d.reps)) +
        '</div>' +
        '<button class="primary wide confirm" data-action="confirm-set" data-ex="' + i + '">✓ Seti kaydet</button></div>';
    }

    const remaining = Math.max(0, ex.targetSets - workDone(ex) - (focused && !done && !(ui.drafts[i] && ui.drafts[i].isWarmup) ? 1 : 0));
    const rest = remaining
      ? '<p class="muted small rest">' + (focused ? '+' + remaining + ' set daha' : remaining + ' set planlı · başlamak için dokun') + '</p>' : '';
    const addSet = done
      ? '<button class="text-btn" data-action="add-set" data-ex="' + i + '">+ Set ekle</button>' : '';

    // Odakta olmayan kartın tamamına dokunmak onu açar
    const cardAction = focused ? '' : ' data-action="focus" data-ex="' + i + '"';
    return '<section class="card' + (focused ? ' focused' : '') + (done ? ' complete' : '') + '" data-card="' + i + '"' + cardAction + '>' +
      '<div class="card-head" data-action="focus" data-ex="' + i + '">' +
      '<h3>' + esc(e.name) + (done ? ' <span class="done-badge">✓</span>' : '') + '</h3>' +
      '<button class="icon-btn small" data-action="exercise-menu" data-ex="' + i + '" aria-label="Hareket menüsü">⋯</button></div>' +
      prevLine + '<div class="sets">' + doneSets + '</div>' + active + rest + addSet + '</section>';
  }

  function stepper(label, field, exIndex, value) {
    return '<div class="stepper"><label>' + esc(label) + '</label><div class="stepper-row">' +
      '<button class="step" data-action="step" data-field="' + field + '" data-ex="' + exIndex + '" data-dir="-1" aria-label="azalt">−</button>' +
      '<input class="step-input" inputmode="decimal" data-field="' + field + '" data-ex="' + exIndex + '" value="' + esc(value) + '" aria-label="' + esc(label) + '">' +
      '<button class="step" data-action="step" data-field="' + field + '" data-ex="' + exIndex + '" data-dir="1" aria-label="artır">+</button>' +
      '</div></div>';
  }

  function renderSummary() {
    const w = state.workouts.find((x) => x.id === ui.summaryWorkoutId);
    if (!w) { ui.view = 'home'; return renderHome(); }
    const mins = Math.round((new Date(w.endedAt) - new Date(w.startedAt)) / 60000);
    const rows = w.exercises.map((ex) => {
      const e = exercise(ex.exerciseId);
      const best = L.bestSet(e.type, ex.sets);
      const prev = L.lastPerformance(state.workouts, ex.exerciseId, w.id);
      const prevBest = prev ? L.bestSet(e.type, prev.sets) : null;
      const t = L.trend(e.type, prevBest, best);
      return '<div class="sum-row"><button class="link-name" data-action="open-exercise" data-id="' + esc(e.id) + '">' + esc(e.name) + '</button><span>' +
        (prevBest ? '<span class="muted">' + esc(L.formatSet(e.type, prevBest)) + ' → </span>' : '') +
        '<b>' + esc(L.formatSet(e.type, best)) + '</b> ' + trendIcon(t) + '</span></div>';
    }).join('');
    const ups = w.exercises.filter((ex) => {
      const e = exercise(ex.exerciseId);
      const prev = L.lastPerformance(state.workouts, ex.exerciseId, w.id);
      return L.trend(e.type, prev ? L.bestSet(e.type, prev.sets) : null, L.bestSet(e.type, ex.sets)) === 'up';
    }).length;
    const cardioMin = L.cardioMinutes(w);
    const recs = workoutRecords(w);
    const prList = w.exercises.map((ex, i) => {
      const e = exercise(ex.exerciseId);
      const sets = ex.sets.filter((s, si) => recs[i][si]);
      return sets.length ? '<li><b>' + esc(e.name) + '</b> <span class="muted">' + sets.map((s) => esc(L.formatSet(e.type, s))).join(', ') + '</span></li>' : '';
    }).filter(Boolean);
    const prCount = recs.reduce((t, f) => t + f.filter(Boolean).length, 0);
    const upNames = w.exercises.filter((ex) => {
      const e = exercise(ex.exerciseId);
      const prev = L.lastPerformance(state.workouts, ex.exerciseId, w.id);
      return L.trend(e.type, prev ? L.bestSet(e.type, prev.sets) : null, L.bestSet(e.type, ex.sets)) === 'up';
    }).map((ex) => exercise(ex.exerciseId).name);
    return '<header class="top"><div><h1>Tebrikler 💪</h1><p class="muted">' + esc(w.name) + ' · ' + mins + ' dk' +
      (cardioMin ? ' · ' + cardioMin + ' dk kardiyo' : '') + '</p></div></header>' +
      (prCount ? '<div class="highlight"><p class="pr-line">🏆 Bugün ' + prCount + ' kişisel rekor kırdın</p><ul class="pr-list">' + prList.join('') + '</ul></div>' : '') +
      (ups ? '<p class="highlight">Geçen seferden daha iyi: <b>' + upNames.map(esc).join(', ') + '</b></p>' : '') +
      (rows ? '<section class="card"><p class="section-label">En iyi setler</p>' + rows + '</section>' : '') +
      '<button class="primary wide" data-action="go-home">Ana sayfa</button>';
  }

  function renderSettings() {
    const last = state.settings.lastBackupAt;
    // Günlerin kalıcı hareket listeleri (Push, Pull): sıra değiştir, çıkar, ekle
    const days = state.templates.filter((t) => t.kind === 'strength');
    const inDay = new Set(days.flatMap((t) => t.items.map((i) => i.exerciseId)));
    const daySections = days.map((t) => {
      const rows = t.items.map((it, idx) => {
        const e = exercise(it.exerciseId);
        const btn = (dir, label, off) => '<button class="mini" data-action="tpl-move" data-t="' + esc(t.id) + '" data-i="' + idx +
          '" data-dir="' + dir + '" aria-label="' + label + '"' + (off ? ' disabled' : '') + '>' + (dir < 0 ? '↑' : '↓') + '</button>';
        return '<div class="tpl-row">' +
          '<button class="tpl-name" data-action="edit-exercise" data-id="' + esc(e.id) + '"><b>' + esc(e.name) + '</b>' +
          '<span class="muted small"> · ' + it.targetSets + ' set</span></button>' +
          btn(-1, 'Yukarı taşı', idx === 0) + btn(1, 'Aşağı taşı', idx === t.items.length - 1) +
          '<button class="mini remove" data-action="tpl-remove" data-t="' + esc(t.id) + '" data-i="' + idx + '" aria-label="Günden çıkar">✕</button>' +
          '</div>';
      }).join('');
      return '<section class="card"><div class="week-head"><p class="section-label">' + esc(t.name) + ' günü</p>' +
        '<button class="link-btn" data-action="day-edit" data-t="' + esc(t.id) + '">Düzenle</button></div>' +
        (rows || '<p class="muted small">Bu günde hareket yok.</p>') +
        '<button class="ghost-btn" data-action="tpl-add" data-t="' + esc(t.id) + '">+ ' + esc(t.name) + ' gününe hareket ekle</button></section>';
    }).join('');
    const others = Object.values(state.exercises).filter((e) => !e.archived && !inDay.has(e.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map((e) => '<button class="row-btn" data-action="edit-exercise" data-id="' + esc(e.id) + '"><b>' + esc(e.name) + '</b></button>')
      .join('');
    const otherSection = others
      ? '<section class="card"><p class="section-label">Diğer hareketler</p>' +
        '<p class="muted small">Hiçbir güne kayıtlı değil (ör. antrenman içinde eklediklerin).</p>' + others + '</section>'
      : '';
    return '<header class="top"><button class="icon-btn" data-action="go-home" aria-label="Geri">‹</button>' +
      '<div class="center"><h2>Ayarlar</h2></div><span class="icon-btn"></span></header>' +
      '<section class="card"><p class="section-label">Yedekleme</p>' +
      '<p class="small">Verilerin sadece bu cihazda saklanıyor. Haftada bir yedek al: bilgisayarda dosya İndirilenler klasörüne iner; ' +
      'iPhone\'da açılan pencerede "Dosyalar\'a Kaydet" ile iCloud Drive\'a kaydedebilirsin.</p>' +
      '<p class="last-backup">Son yedek: <b>' + (last ? esc(L.dateTr(last, { withTime: true })) + '</b> <span class="muted">(' + L.relativeDay(last, new Date()) + ')</span>' : 'hiç alınmadı</b>') + '</p>' +
      '<button class="primary wide" data-action="export">Yedeği dışa aktar</button>' +
      '<label class="ghost-btn file-btn">Yedekten geri yükle<input type="file" accept="application/json,.json" data-action="import" hidden></label>' +
      '</section>' +
      '<section class="card"><p class="section-label">Set düzeni ve hedef</p>' +
      '<p class="small">Setlerini nasıl yapıyorsun? 🎯 hedef buna göre doğru sette çıkar. Isınma setleri her düzende ayrı sayılır.</p>' +
      '<div class="mode-list" role="radiogroup">' + TARGET_MODES.map((m) =>
        '<button class="mode-opt' + (targetMode() === m.id ? ' on' : '') + '" data-action="target-mode" data-m="' + m.id + '" role="radio"' +
        ' aria-checked="' + (targetMode() === m.id) + '"><span class="mode-radio" aria-hidden="true"></span><span class="mode-text"><b>' + m.title +
        '</b><span class="muted small">' + m.desc + '</span></span></button>').join('') + '</div>' +
      '<div class="mode-example"><p class="muted small">Örnek · 3 set, tekrar aralığı 6–10</p><ol>' +
      TARGET_MODES.find((m) => m.id === targetMode()).example.map((x) => '<li>' + x + '</li>').join('') + '</ol></div>' +
      '</section>' +
      '<section class="card"><p class="section-label">Haftalık kardiyo hedefi</p>' +
      stepperPlain('goal', state.settings.weeklyCardioGoal, 'dk') + '</section>' +
      daySections +
      '<button class="ghost-btn new-day" data-action="day-new">+ Yeni gün ekle <span class="muted small">(ör. Legs)</span></button>' +
      otherSection +
      '<p class="muted small center-text">Progressive · sürüm ' + APP_VERSION + '</p>';
  }

  function stepperPlain(field, value, unit) {
    return '<div class="stepper-row inline">' +
      '<button class="step" data-action="plain-step" data-field="' + field + '" data-dir="-1">−</button>' +
      '<span class="plain-val">' + esc(value) + ' ' + unit + '</span>' +
      '<button class="step" data-action="plain-step" data-field="' + field + '" data-dir="1">+</button></div>';
  }

  // ---------- Alt paneller ----------

  function openSheet(s) { ui.sheet = s; renderSheet(); }
  function closeSheet() { ui.sheet = null; renderSheet(); }

  function renderSheet() {
    const s = ui.sheet;
    if (!s) { $sheet.innerHTML = ''; document.body.classList.remove('locked'); return; }
    document.body.classList.add('locked');
    let body = '';
    if (s.type === 'exercise') body = sheetExercise(s);
    else if (s.type === 'set') body = sheetSet(s);
    else if (s.type === 'cardio') body = sheetCardio(s);
    else if (s.type === 'add-exercise') body = sheetAddExercise();
    else if (s.type === 'add-to-template') body = sheetAddToTemplate(s);
    else if (s.type === 'day') body = sheetDay(s);
    else if (s.type === 'exercise-menu') body = sheetExerciseMenu(s);
    else if (s.type === 'bodyweight') body = sheetBodyWeight(s);
    $sheet.innerHTML = '<div class="backdrop" data-action="close-sheet"></div><div class="sheet" role="dialog">' + body + '</div>';
  }

  function sheetExercise(s) {
    const e = s.id ? exercise(s.id) : { name: '', type: 'weighted', weightStep: 2.5, machineSetting: '', repMin: 8, repMax: 12 };
    const rr = L.repRange(e);
    const types = [['weighted', 'Ağırlık × tekrar'], ['bodyweight', 'Vücut ağırlığı']];
    // Yeni harekette hangi güne (Push / Pull) ekleneceği seçilir
    const days = state.templates.filter((t) => t.kind === 'strength');
    const dayField = s.id ? '' : s.addToWorkout
      ? '<p class="muted small sheet-hint">Sadece bu antrenmana eklenir. Bir güne kalıcı eklemek için Ayarlar\'ı kullan.</p>' :
      '<div class="field">Hangi gün?<div class="chips">' + days.map((t) =>
        '<label class="chip-radio"><input type="radio" name="templateId" value="' + esc(t.id) + '"' +
        (s.templateId === t.id ? ' checked' : '') + '><span>' + esc(t.name) + '</span></label>').join('') +
      '</div><p class="muted small">Hareket bu günün listesinin sonuna eklenir.</p></div>';
    return '<form data-form="exercise" data-id="' + esc(s.id || '') + '">' +
      '<h3>' + (s.id ? esc(e.name) : 'Yeni hareket') + '</h3>' +
      '<label class="field">Ad<input name="name" value="' + esc(e.name) + '" autocomplete="off"></label>' +
      dayField +
      '<label class="field">Ağırlık adımı (kg)<input name="weightStep" inputmode="decimal" value="' + esc(L.fmtNum(e.weightStep)) + '"></label>' +
      '<div class="field">Tekrar aralığı<div class="range-row">' +
      '<input name="repMin" inputmode="numeric" value="' + rr.min + '" aria-label="En az tekrar"><span>–</span>' +
      '<input name="repMax" inputmode="numeric" value="' + rr.max + '" aria-label="En çok tekrar"></div>' +
      '<p class="muted small">Hedef önerisi için: üst sınıra ulaşınca ağırlık artırılır, alt sınırdan devam edilir.</p></div>' +
      '<div class="field">Tip<div class="chips">' + types.map(([v, n]) =>
        '<label class="chip-radio"><input type="radio" name="type" value="' + v + '"' + (e.type === v ? ' checked' : '') + '><span>' + n + '</span></label>').join('') +
      '</div><p class="muted small">Vücut ağırlığında girilen ağırlık ek yüktür (ör. bele takılan plaka).</p></div>' +
      '<div class="sheet-actions"><button type="button" class="ghost-btn" data-action="close-sheet">Vazgeç</button>' +
      '<button type="submit" class="primary">Kaydet</button></div></form>';
  }

  // Alt panelin üzerinde çalıştığı antrenman: geçmişten açıldıysa o, yoksa devam eden antrenman
  function sheetWorkout() {
    const s = ui.sheet;
    return (s && s.workoutId && state.workouts.find((x) => x.id === s.workoutId)) || activeWorkout();
  }

  function sheetSet(s) {
    const w = sheetWorkout();
    const ex = w.exercises[s.ex];
    const set = ex.sets[s.si];
    const e = exercise(ex.exerciseId);
    return '<form data-form="set">' +
      '<h3>' + esc(e.name) + ' · ' + (set.isWarmup ? 'ısınma' : 'set ' + (s.si + 1)) + '</h3>' +
      '<label class="field">' + weightLabel(e.type) + ' (kg)<input name="weight" inputmode="decimal" value="' + esc(L.fmtNum(set.weight)) + '"></label>' +
      '<label class="field">Tekrar<input name="reps" inputmode="numeric" value="' + esc(set.reps) + '"></label>' +
      '<label class="check-field"><input type="checkbox" name="isWarmup"' + (set.isWarmup ? ' checked' : '') + '> Isınma seti</label>' +
      '<div class="sheet-actions"><button type="button" class="ghost-btn danger" data-action="delete-set">Seti sil</button>' +
      '<button type="submit" class="primary">Kaydet</button></div></form>';
  }

  function sheetCardio(s) {
    const w = sheetWorkout();
    const existing = s.i !== undefined ? w.cardio[s.i] : null;
    const lastType = existing ? existing.type : (state.settings.lastCardioType || 'treadmill');
    const minutes = existing ? existing.minutes : (state.settings.lastCardioMinutes || 20);
    const diff = existing ? existing.difficulty : null;
    return '<form data-form="cardio">' +
      '<h3>' + (existing ? 'Kardiyoyu düzenle' : 'Kardiyo ekle') + '</h3>' +
      '<div class="field">Tür<div class="chips">' + Seed.CARDIO_TYPES.map((c) =>
        '<label class="chip-radio"><input type="radio" name="type" value="' + c.id + '"' + (c.id === lastType ? ' checked' : '') + '><span>' + esc(c.name) + '</span></label>').join('') +
      '</div></div>' +
      '<div class="field">Süre (dk)<div class="stepper-row">' +
      '<button type="button" class="step" data-action="minutes-step" data-dir="-5">−</button>' +
      '<input class="step-input" name="minutes" inputmode="numeric" value="' + esc(minutes) + '">' +
      '<button type="button" class="step" data-action="minutes-step" data-dir="5">+</button></div></div>' +
      '<label class="field">Mesafe (km, isteğe bağlı)<input name="distanceKm" inputmode="decimal" value="' + (existing && existing.distanceKm ? esc(L.fmtNum(existing.distanceKm)) : '') + '"></label>' +
      '<div class="field">Zorluk (isteğe bağlı)<div class="chips tight">' +
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
        '<label class="chip-radio num"><input type="radio" name="difficulty" value="' + n + '"' + (diff === n ? ' checked' : '') + '><span>' + n + '</span></label>').join('') +
      '</div><p class="muted small">1 = çok kolay · 10 = maksimum</p></div>' +
      '<div class="sheet-actions">' + (existing ? '<button type="button" class="ghost-btn danger" data-action="delete-cardio">Sil</button>'
        : '<button type="button" class="ghost-btn" data-action="close-sheet">Vazgeç</button>') +
      '<button type="submit" class="primary">Kaydet</button></div></form>';
  }

  // Antrenman başında (edit: false) veya antrenman sırasında (edit: true) kilo girişi.
  function sheetBodyWeight(s) {
    const w = s.edit ? activeWorkout() : null;
    const last = lastBodyWeight();
    const val = (w && w.bodyWeight) || last;
    const t = s.templateId ? template(s.templateId) : null;
    return '<form data-form="bodyweight">' +
      '<h3>' + (t ? esc(t.name) + ' · ' : '') + 'Bugünkü kilon</h3>' +
      '<p class="muted small">Tartıldıysan gir; kayda geçer, ana ekranda haftalık değişimini görürsün.' +
      (last ? ' Son girdiğin: ' + L.fmtNum(last) + ' kg.' : '') + '</p>' +
      '<div class="field"><div class="stepper-row">' +
      '<button type="button" class="step" data-action="bw-step" data-dir="-0.1" aria-label="azalt">−</button>' +
      '<input class="step-input" name="bodyWeight" inputmode="decimal" value="' + (val ? esc(L.fmtNum(val)) : '') + '" placeholder="kg" aria-label="Kilo (kg)">' +
      '<button type="button" class="step" data-action="bw-step" data-dir="0.1" aria-label="artır">+</button></div></div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="ghost-btn" data-action="bw-skip">' + (s.edit ? 'Vazgeç' : 'Atla') + '</button>' +
      '<button type="submit" class="primary">' + (s.edit ? 'Kaydet' : 'Başla') + '</button></div></form>';
  }

  function setWorkoutBodyWeight(w, bw) {
    w.bodyWeight = bw > 0 ? bw : null;
    // Bu antrenmandaki vücut ağırlığı setlerini de güncelle
    for (const ex of w.exercises) {
      if (exercise(ex.exerciseId).type !== 'bodyweight') continue;
      for (const set of ex.sets) set.bodyWeight = w.bodyWeight;
    }
  }

  function sheetAddExercise() {
    const w = activeWorkout();
    const inWorkout = new Set(w.exercises.map((e) => e.exerciseId));
    const list = Object.values(state.exercises).filter((e) => !e.archived && !inWorkout.has(e.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map((e) => '<button class="row-btn" data-action="pick-exercise" data-id="' + esc(e.id) + '">' + esc(e.name) + '</button>').join('');
    return '<h3>Hareket ekle</h3>' +
      '<p class="muted small sheet-hint">Sadece bu antrenmana eklenir. Bir güne kalıcı eklemek için Ayarlar\'ı kullan.</p>' +
      (list || '<p class="muted">Tüm hareketler zaten bu antrenmanda.</p>') +
      '<button class="ghost-btn" data-action="new-exercise">+ Yeni hareket oluştur</button>' +
      '<div class="sheet-actions"><button class="ghost-btn" data-action="close-sheet">Kapat</button></div>';
  }

  // Ayarlar: yeni gün (ör. Legs) oluşturma veya mevcut günü düzenleme
  function sheetDay(s) {
    const t = s.id ? template(s.id) : null;
    return '<form data-form="day">' +
      '<h3>' + (t ? esc(t.name) + ' gününü düzenle' : 'Yeni gün') + '</h3>' +
      '<label class="field">Gün adı<input name="name" value="' + esc(t ? t.name : '') + '" placeholder="ör. Legs, Upper, Full body" autocomplete="off"></label>' +
      (t ? '' : '<p class="muted small sheet-hint">Gün ana ekranda, Geçmiş ve Özet sekmelerinde görünür. Hareketlerini oluşturduktan sonra ekleyebilirsin.</p>') +
      '<div class="sheet-actions">' +
      (t ? '<button type="button" class="ghost-btn danger" data-action="day-delete">Günü sil</button>'
        : '<button type="button" class="ghost-btn" data-action="close-sheet">Vazgeç</button>') +
      '<button type="submit" class="primary">' + (t ? 'Kaydet' : 'Oluştur') + '</button></div></form>';
  }

  // Ayarlar: bir güne (Push/Pull) kalıcı hareket ekleme
  function sheetAddToTemplate(s) {
    const t = template(s.templateId);
    const inT = new Set(t.items.map((i) => i.exerciseId));
    const list = Object.values(state.exercises).filter((e) => !e.archived && !inT.has(e.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map((e) => '<button class="row-btn" data-action="tpl-pick" data-id="' + esc(e.id) + '">' + esc(e.name) + '</button>').join('');
    return '<h3>' + esc(t.name) + ' gününe ekle</h3>' +
      '<p class="muted small sheet-hint">Kalıcı olarak eklenir; bundan sonraki her ' + esc(t.name) + ' antrenmanında gelir.</p>' +
      (list ? '<p class="section-label">Mevcut hareketler</p>' + list : '') +
      '<button class="ghost-btn" data-action="new-exercise">+ Yeni hareket oluştur</button>' +
      '<div class="sheet-actions"><button class="ghost-btn" data-action="close-sheet">Kapat</button></div>';
  }

  function sheetExerciseMenu(s) {
    const w = activeWorkout();
    const ex = w.exercises[s.ex];
    const e = exercise(ex.exerciseId);
    return '<h3>' + esc(e.name) + '</h3>' +
      '<button class="row-btn" data-action="open-exercise" data-id="' + esc(e.id) + '">📈 Gelişim grafiği ve rekorlar</button>' +
      '<button class="row-btn" data-action="edit-exercise" data-id="' + esc(e.id) + '">Ayarlar (ad, ağırlık adımı, tekrar aralığı)</button>' +
      (s.ex > 0 ? '<button class="row-btn" data-action="move" data-ex="' + s.ex + '" data-dir="-1">↑ Yukarı taşı</button>' : '') +
      (s.ex < w.exercises.length - 1 ? '<button class="row-btn" data-action="move" data-ex="' + s.ex + '" data-dir="1">↓ Aşağı taşı</button>' : '') +
      (ex.targetSets > workDone(ex) && ex.targetSets > 1 ? '<button class="row-btn" data-action="remove-planned" data-ex="' + s.ex + '">Planlanan seti azalt (−1)</button>' : '') +
      '<button class="row-btn danger" data-action="remove-exercise" data-ex="' + s.ex + '">Bu antrenmandan çıkar</button>' +
      '<div class="sheet-actions"><button class="ghost-btn" data-action="close-sheet">Kapat</button></div>';
  }

  // ---------- Olaylar ----------

  const actions = {
    'start': (el) => openSheet({ type: 'bodyweight', templateId: el.dataset.id }),
    'edit-bw': () => openSheet({ type: 'bodyweight', edit: true }),
    'bw-step': (el) => {
      const input = $sheet.querySelector('input[name="bodyWeight"]');
      const cur = L.parseNum(input.value) || lastBodyWeight() || 80;
      input.value = L.fmtNum(Math.max(0, Math.round((cur + Number(el.dataset.dir)) * 10) / 10));
    },
    'bw-skip': () => {
      const s = ui.sheet;
      closeSheet();
      if (!s.edit) startWorkout(s.templateId, null);
    },
    'resume': () => { ui.view = 'workout'; render(); },
    'go-home': () => { ui.view = 'home'; render(); window.scrollTo(0, 0); },
    'go-settings': () => { ui.view = 'settings'; render(); window.scrollTo(0, 0); },
    'finish': finishWorkout,
    'discard': () => discardWorkout(false),

    'focus': (el, ev) => {
      if (ev.target.closest('[data-action="exercise-menu"]')) return;
      ui.focus = Number(el.dataset.ex);
      render();
    },
    'step': (el) => {
      const w = activeWorkout();
      const i = Number(el.dataset.ex);
      const d = draftFor(w, i);
      const dir = Number(el.dataset.dir);
      if (el.dataset.field === 'weight') d.weight = L.stepValue(d.weight, exercise(w.exercises[i].exerciseId).weightStep, dir);
      else d.reps = Math.max(0, (d.reps || 0) + dir);
      render();
    },
    'toggle-warmup': (el) => {
      const w = activeWorkout();
      const i = Number(el.dataset.ex);
      const ex = w.exercises[i];
      const e = exercise(ex.exerciseId);
      const d = draftFor(w, i);
      if (!d.isWarmup) {
        // Isınma: hedefin yaklaşık yarısı, 10 tekrar (vücut ağırlığında ek yük yok)
        const step = e.weightStep || 2.5;
        d.isWarmup = true;
        if (e.type === 'weighted') { d.weight = Math.floor((d.weight * 0.5) / step) * step; d.reps = 10; }
      } else {
        // Çalışma setine dön: hedef / öneri yeniden hesaplansın
        const prev = prevSetsFor(ex.exerciseId, w.id).sets;
        const plan = planFor(ex, e, prev, false);
        d.isWarmup = false;
        const base = plan.draft || L.prefill(prev, ex.sets, ex.sets.length, e);
        d.weight = base.weight; d.reps = base.reps;
      }
      render();
    },
    'confirm-set': (el) => confirmSet(Number(el.dataset.ex)),
    'target-mode': (el) => {
      state.settings.targetMode = el.dataset.m;
      ui.drafts = {};
      persist();
      render();
    },
    'apply-target': (el) => {
      const d = draftFor(activeWorkout(), Number(el.dataset.ex));
      d.weight = Number(el.dataset.tw);
      d.reps = Number(el.dataset.tr);
      render();
    },
    'open-exercise': (el) => {
      if (ui.view !== 'exercise') ui.exBack = ui.view;
      ui.exerciseId = el.dataset.id;
      ui.chartSel = null;
      ui.sheet = null;
      ui.view = 'exercise';
      render();
      window.scrollTo(0, 0);
    },
    'ex-back': () => {
      ui.view = ui.exBack || 'home';
      render();
      window.scrollTo(0, 0);
    },
    'chart-pt': (el) => { ui.chartSel = Number(el.dataset.i); render(); },
    'add-set': (el) => {
      const w = activeWorkout();
      const i = Number(el.dataset.ex);
      const ex = w.exercises[i];
      ex.targetSets = Math.max(ex.targetSets, workDone(ex)) + 1;
      snapshotPlan(w);
      ui.focus = i;
      persist();
      render();
    },
    'edit-set': (el) => openSheet({ type: 'set', ex: Number(el.dataset.ex), si: Number(el.dataset.si), workoutId: el.dataset.w || null }),
    'delete-set': () => {
      const w = sheetWorkout();
      const ex = w.exercises[ui.sheet.ex];
      ex.sets.splice(ui.sheet.si, 1);
      // Geçmiş bir antrenmanda hareketin son seti silindiyse hareketi de kayıttan çıkar
      if (w.endedAt && !ex.sets.length) w.exercises.splice(ui.sheet.ex, 1);
      if (!w.endedAt) delete ui.drafts[ui.sheet.ex];
      persist();
      closeSheet();
      render();
      toast('Set silindi');
    },

    'tab': (el) => {
      ui.view = el.dataset.v;
      render();
      window.scrollTo(0, 0);
    },
    'open-workout': (el) => {
      ui.detailId = el.dataset.id;
      ui.view = 'detail';
      render();
      window.scrollTo(0, 0);
    },
    'delete-workout': async (el) => {
      const w = state.workouts.find((x) => x.id === el.dataset.id);
      const ok = await ask({ title: 'Antrenmanı sil?',
        message: w.name + ' · ' + L.dateTr(w.startedAt) + ' kaydı ve tüm setleri kalıcı olarak silinecek.',
        ok: 'Sil', danger: true });
      if (!ok) return;
      state.workouts = state.workouts.filter((x) => x.id !== w.id);
      persist();
      ui.view = 'history';
      render();
      toast('Antrenman silindi');
    },
    'day-new': () => openSheet({ type: 'day', id: null }),
    'day-edit': (el) => openSheet({ type: 'day', id: el.dataset.t }),
    'day-delete': async () => {
      const t = template(ui.sheet.id);
      const used = state.workouts.filter((w) => w.templateId === t.id && w.endedAt).length;
      const ok = await ask({
        title: t.name + ' günü silinsin mi?',
        message: 'Gün ana ekrandan ve ayarlardan kalkar.' +
          (used ? ' ' + used + ' geçmiş antrenmanın silinmez; Geçmiş ve Özet\'te "' + t.name + '" sekmesinde görünmeye devam eder.' : ''),
        ok: 'Sil', danger: true,
      });
      if (!ok) return;
      state.templates = state.templates.filter((x) => x.id !== t.id);
      persist();
      closeSheet();
      render();
      toast(t.name + ' günü silindi');
    },
    'hist-group': (el) => { ui.histGroup = el.dataset.g; render(); },
    'ov-group': (el) => { ui.ovGroup = el.dataset.g; render(); },
    'ov-kind': (el) => {
      ui.ovKind = el.dataset.k;
      ui.ovOffset = 0;
      render();
    },
    'ov-shift': (el) => {
      ui.ovOffset = Math.min(0, ui.ovOffset + Number(el.dataset.dir));
      render();
    },

    'exercise-menu': (el) => openSheet({ type: 'exercise-menu', ex: Number(el.dataset.ex) }),
    'edit-exercise': (el) => openSheet({ type: 'exercise', id: el.dataset.id }),
    'new-exercise': () => {
      const from = ui.sheet;
      if (ui.view === 'workout' && activeWorkout()) {
        openSheet({ type: 'exercise', id: null, addToWorkout: true });
      } else {
        openSheet({ type: 'exercise', id: null, templateId: from && from.type === 'add-to-template' ? from.templateId : null });
      }
    },
    'tpl-add': (el) => openSheet({ type: 'add-to-template', templateId: el.dataset.t }),
    'tpl-pick': (el) => {
      const t = template(ui.sheet.templateId);
      t.items.push({ exerciseId: el.dataset.id, targetSets: 3 });
      persist();
      closeSheet();
      render();
      toast(exercise(el.dataset.id).name + ', ' + t.name + ' gününe eklendi');
    },
    'tpl-move': (el) => {
      const t = template(el.dataset.t);
      const i = Number(el.dataset.i);
      const j = i + Number(el.dataset.dir);
      if (j < 0 || j >= t.items.length) return;
      [t.items[i], t.items[j]] = [t.items[j], t.items[i]];
      persist();
      render();
    },
    'tpl-remove': async (el) => {
      const t = template(el.dataset.t);
      const i = Number(el.dataset.i);
      const e = exercise(t.items[i].exerciseId);
      const ok = await ask({ title: e.name + ' çıkarılsın mı?',
        message: t.name + ' gününün listesinden çıkar. Geçmiş kayıtların silinmez; istersen sonra tekrar ekleyebilirsin.',
        ok: 'Çıkar', danger: true });
      if (!ok) return;
      t.items.splice(i, 1);
      persist();
      render();
      toast(e.name + ', ' + t.name + ' gününden çıkarıldı');
    },
    'move': (el) => {
      const w = activeWorkout();
      const i = Number(el.dataset.ex);
      const j = i + Number(el.dataset.dir);
      [w.exercises[i], w.exercises[j]] = [w.exercises[j], w.exercises[i]];
      ui.drafts = {};
      ui.focus = j;
      snapshotPlan(w);
      persist();
      closeSheet();
      render();
    },
    'remove-planned': (el) => {
      const w = activeWorkout();
      const ex = w.exercises[Number(el.dataset.ex)];
      ex.targetSets = Math.max(workDone(ex), ex.targetSets - 1, 1);
      snapshotPlan(w);
      persist();
      closeSheet();
      render();
    },
    'remove-exercise': async (el) => {
      const w = activeWorkout();
      const i = Number(el.dataset.ex);
      const ex = w.exercises[i];
      if (ex.sets.length && !(await ask({ title: 'Hareketi çıkar?', message: 'Bu hareketin girilen setleri de silinecek.',
        ok: 'Çıkar', danger: true }))) return;
      w.exercises.splice(i, 1);
      ui.drafts = {};
      ui.focus = null;
      snapshotPlan(w);
      persist();
      closeSheet();
      render();
    },
    'add-exercise': () => openSheet({ type: 'add-exercise' }),
    'pick-exercise': (el) => addExerciseToWorkout(el.dataset.id),

    'add-cardio': (el) => openSheet({ type: 'cardio', workoutId: el.dataset.w || null }),
    'edit-cardio': (el) => openSheet({ type: 'cardio', i: Number(el.dataset.i), workoutId: el.dataset.w || null }),
    'delete-cardio': () => {
      sheetWorkout().cardio.splice(ui.sheet.i, 1);
      persist();
      closeSheet();
      render();
    },
    'minutes-step': (el) => {
      const input = $sheet.querySelector('input[name="minutes"]');
      const v = Math.max(0, (parseInt(input.value, 10) || 0) + Number(el.dataset.dir));
      input.value = v;
    },

    'close-sheet': () => closeSheet(),
    'export': exportBackup,
    'plain-step': (el) => {
      if (el.dataset.field === 'goal') {
        state.settings.weeklyCardioGoal = Math.max(10, (state.settings.weeklyCardioGoal || 150) + 10 * Number(el.dataset.dir));
        persist();
        render();
      }
    },
  };

  function addExerciseToWorkout(id) {
    const w = activeWorkout();
    w.exercises.push({ exerciseId: id, targetSets: 3, sets: [] });
    ui.focus = w.exercises.length - 1;
    snapshotPlan(w);
    persist();
    closeSheet();
    render();
    scrollToCard(ui.focus);
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const fn = actions[el.dataset.action];
    if (fn) { ev.preventDefault(); fn(el, ev); }
  });

  // Ağırlık / tekrar kutusuna elle yazma.
  // Burada bilerek render() çağrılmıyor: klavye kapanırken ekranı yeniden çizmek,
  // aynı anda dokunulan "Seti kaydet" butonunu değiştirip ilk dokunuşu kaybettiriyordu.
  function isDraftInput(el) {
    return el && el.classList && el.classList.contains('step-input') && el.dataset.ex !== undefined && !!activeWorkout();
  }

  function readDraftInput(el) {
    const d = draftFor(activeWorkout(), Number(el.dataset.ex));
    const v = L.parseNum(el.value);
    if (v !== null && v >= 0) {
      if (el.dataset.field === 'weight') d.weight = Math.round(v * 1000) / 1000;
      else d.reps = Math.round(v);
    }
    return d;
  }

  document.addEventListener('input', (ev) => {
    if (isDraftInput(ev.target)) readDraftInput(ev.target);
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (isDraftInput(el)) {
      const d = readDraftInput(el);
      el.value = el.dataset.field === 'weight' ? L.fmtNum(d.weight) : String(d.reps);
    }
    if (el.dataset.action === 'import' && el.files && el.files[0]) {
      importBackup(el.files[0]);
      el.value = ''; // aynı dosya tekrar seçilebilsin
    }
  });

  // Kutuya dokununca içeriği seç (hızlı yazmak için)
  document.addEventListener('focusin', (ev) => {
    if (ev.target.classList && ev.target.classList.contains('step-input')) {
      setTimeout(() => { try { ev.target.select(); } catch (e) { /* yok say */ } }, 0);
    }
  });

  document.addEventListener('submit', (ev) => {
    const form = ev.target;
    ev.preventDefault();
    const f = new FormData(form);
    const kind = form.dataset.form;

    if (kind === 'exercise') {
      const name = String(f.get('name') || '').trim();
      if (!name) { toast('Ad boş olamaz'); return; }
      const step = L.parseNum(f.get('weightStep'));
      const rMin = parseInt(f.get('repMin'), 10);
      const rMax = parseInt(f.get('repMax'), 10);
      if (!(rMin > 0 && rMax > rMin && rMax <= 50)) { toast('Tekrar aralığı geçersiz (ör. 6–10)'); return; }
      let id = form.dataset.id;
      let addedTo = null;
      const toWorkout = !id && !!(ui.sheet && ui.sheet.addToWorkout && activeWorkout());
      if (!id) {
        // Ayarlar'dan: gün seçimi zorunlu, kalıcı eklenir. Antrenman içinden: sadece o antrenmana.
        const t = toWorkout ? null : template(f.get('templateId'));
        if (!toWorkout && !t) { toast('Push ya da Pull seç'); return; }
        id = Store.uid('ex');
        state.exercises[id] = { id, name, type: 'weighted', weightStep: 2.5, machineSetting: '',
          repMin: 8, repMax: 12, primaryMuscles: [], secondaryMuscles: [], archived: false, isCustom: true };
        if (t) {
          t.items.push({ exerciseId: id, targetSets: 3 });
          addedTo = t;
        }
      }
      const e = state.exercises[id];
      e.name = name;
      if (step && step > 0) e.weightStep = step;
      e.type = f.get('type') || e.type;
      e.repMin = rMin;
      e.repMax = rMax;
      persist();
      closeSheet();
      if (toWorkout) {
        addExerciseToWorkout(id);
        toast('Sadece bu antrenmana eklendi');
      } else {
        render();
        toast(addedTo ? addedTo.name + ' gününe eklendi' : 'Kaydedildi');
      }
      return;
    }

    if (kind === 'set') {
      const w = sheetWorkout();
      const set = w.exercises[ui.sheet.ex].sets[ui.sheet.si];
      const weight = L.parseNum(f.get('weight'));
      const reps = parseInt(f.get('reps'), 10);
      if (weight !== null && weight >= 0) set.weight = weight;
      if (reps > 0) set.reps = reps;
      set.isWarmup = f.get('isWarmup') === 'on';
      if (!w.endedAt) delete ui.drafts[ui.sheet.ex];
      persist();
      closeSheet();
      render();
      return;
    }

    if (kind === 'day') {
      const name = String(f.get('name') || '').trim();
      if (!name) { toast('Gün adı boş olamaz'); return; }
      const id = ui.sheet.id;
      const clash = state.templates.some((t) => t.id !== id && t.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'));
      if (clash) { toast('Bu isimde bir gün zaten var'); return; }
      if (id) {
        template(id).name = name;
        // Bu günün geçmiş antrenmanları da yeni adı alsın (Geçmiş/Özet'te tek isim görünsün)
        for (const w of state.workouts) if (w.templateId === id) w.name = name;
        toast('Kaydedildi');
      } else {
        // Yeni güç günü, "Sadece kardiyo"nun önüne eklenir
        const t = { id: Store.uid('t'), name, kind: 'strength', items: [] };
        const ci = state.templates.findIndex((x) => x.kind === 'cardio');
        if (ci === -1) state.templates.push(t); else state.templates.splice(ci, 0, t);
        toast(name + ' günü eklendi, şimdi hareket ekleyebilirsin');
      }
      persist();
      closeSheet();
      render();
      return;
    }

    if (kind === 'bodyweight') {
      const raw = String(f.get('bodyWeight') || '').trim();
      const bw = raw ? L.parseNum(raw) : null;
      if (raw && !(bw >= 25 && bw <= 350)) { toast('Geçerli bir kilo gir (ör. 88,5)'); return; }
      const s = ui.sheet;
      closeSheet();
      if (s.edit) {
        setWorkoutBodyWeight(activeWorkout(), bw);
        persist();
        render();
        toast('Kilo kaydedildi');
      } else {
        startWorkout(s.templateId, bw);
      }
      return;
    }

    if (kind === 'cardio') {
      const minutes = parseInt(f.get('minutes'), 10);
      if (!(minutes > 0)) { toast('Süre girmelisin'); return; }
      const w = sheetWorkout();
      const entry = {
        id: Store.uid('c'),
        type: f.get('type') || 'other',
        minutes,
        distanceKm: L.parseNum(f.get('distanceKm') || '') || null,
        difficulty: f.get('difficulty') ? Number(f.get('difficulty')) : null,
        avgHr: null,
      };
      if (ui.sheet.i !== undefined) {
        entry.id = w.cardio[ui.sheet.i].id;
        w.cardio[ui.sheet.i] = entry;
      } else {
        w.cardio.push(entry);
      }
      state.settings.lastCardioType = entry.type;
      state.settings.lastCardioMinutes = entry.minutes;
      persist();
      closeSheet();
      render();
      toast('Kardiyo kaydedildi');
    }
  });

  // ---------- Yedekleme ----------

  // iPhone/iPad'de paylaşım penceresi ("Dosyalar'a Kaydet" orada). Bilgisayarda doğrudan indirme;
  // Mac'teki Chrome'un paylaşım penceresinde kaydetme seçeneği yok ve dosya paylaşımı başarısız olabiliyor.
  function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function downloadFile(file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function markBackedUp(msg) {
    state.settings.lastBackupAt = new Date().toISOString();
    persist();
    render();
    toast(msg);
  }

  async function exportBackup() {
    const text = Store.exportJson(state);
    const name = L.backupFileName(new Date()); // "Progressive 2 Kasım 2026.json"
    const file = new File([text], name, { type: 'application/json' });
    if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        markBackedUp('Yedek kaydedildi');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // kullanıcı paylaşımı kapattı
        console.warn('Paylaşım başarısız, indirmeye geçiliyor', e);
      }
    }
    try {
      downloadFile(file);
      markBackedUp(isIOS() ? 'Yedek indirildi' : 'Yedek İndirilenler klasörüne kaydedildi');
    } catch (e) {
      console.error(e);
      ask({ title: 'Yedek alınamadı', message: 'Dosya oluşturulurken bir sorun çıktı. Tekrar dener misin?', cancel: null });
    }
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let info;
      try {
        info = Store.backupInfo(state, String(reader.result));
      } catch (e) {
        ask({ title: 'Yedek yüklenemedi', message: e.message, cancel: null });
        return;
      }
      const when = info.exportedAt ? L.dateTr(info.exportedAt, { withTime: true }) : 'bilinmiyor';
      const day = (iso) => (iso ? L.dateTr(iso, { noYear: true }) : 'yok');
      const dayTime = (iso) => (iso ? L.dateTr(iso, { noYear: true, withTime: true }) : 'yok');

      if (info.identical) {
        ask({
          title: 'Bu yedek zaten güncel',
          message: 'Yedekteki veriler uygulamadakiyle birebir aynı (' + info.backupCount + ' antrenman, son: ' +
            day(info.backupLatest) + '). Hiçbir şey değiştirilmedi.',
          cancel: null,
        });
        return;
      }

      const opts = info.isOlder
        ? {
          title: 'Bu yedek daha eski',
          message: 'Yedek tarihi: ' + when + '. Yedekteki son antrenman ' + dayTime(info.backupLatest) +
            ', uygulamadaki son antrenman ' + dayTime(info.currentLatest) + '. Yüklersen sonradan girdiğin ' +
            info.newerInCurrent + ' antrenman silinir.',
          ok: 'Yine de yükle', danger: true,
        }
        : {
          title: 'Yedeği geri yükle?',
          message: 'Yedek tarihi: ' + when + ' · ' + info.backupCount + ' antrenman (son: ' + day(info.backupLatest) +
            '). Bu cihazdaki mevcut verinin yerini alacak.',
          ok: 'Geri yükle',
        };
      if (!(await ask(opts))) return;
      // "Son yedek" bilgisi kaybolmasın: bu cihazdaki son yedek ile yüklenen dosyanın tarihinden yenisi
      const prevBackup = state.settings.lastBackupAt;
      state = info.data;
      const latest = [prevBackup, state.settings.lastBackupAt, info.exportedAt].filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a))[0] || null;
      state.settings.lastBackupAt = latest;
      persist();
      ui.view = state.activeWorkoutId ? 'workout' : 'home';
      ui.drafts = {};
      render();
      toast('Yedek geri yüklendi');
    };
    reader.readAsText(file);
  }

  // ---------- Başlat ----------

  // Mevcut antrenman için plan anlık görüntüsü yoksa oluştur (şablon önerisi için)
  const aw = activeWorkout();
  if (aw && !aw._plan) {
    const t = template(aw.templateId);
    aw._plan = t ? t.items.map((i) => ({ exerciseId: i.exerciseId, targetSets: i.targetSets })) : null;
  }

  render();

  // Geçen süreyi dakikada bir güncelle
  setInterval(() => {
    const el = document.getElementById('elapsed');
    const w = activeWorkout();
    if (el && w) el.textContent = minutesSince(w.startedAt) + ' dk · ' + w.exercises.reduce((t, e) => t + e.sets.length, 0) + ' set';
  }, 30000);

  // Çevrimdışı çalışma (sadece http/https üzerinden açıldığında)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    // Yeni sürüm devreye girince sayfayı bir kez yenile (eski sürümde takılı kalmamak için).
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('SW kaydı başarısız', e));
  }

  // Testler için
  window.__progressive = { get state() { return state; }, ui, actions, render };
})();
