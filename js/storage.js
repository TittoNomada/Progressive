/*
 * Veri saklama katmanı. Şimdilik tüm veri cihazda (localStorage) tek bir JSON olarak durur.
 * İleride bulut senkronizasyonu eklenirse sadece bu dosyanın değişmesi hedeflenir;
 * bu yüzden tüm kayıtlar benzersiz id ve ISO tarih taşır.
 */
(function (root, factory) {
  const api = factory(root.Seed || (typeof require !== 'undefined' ? require('./seed.js') : null));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Store = api;
})(typeof self !== 'undefined' ? self : this, function (Seed) {
  'use strict';

  const KEY = 'progressive.data';
  const SCHEMA_VERSION = 4;

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function catalogExercise(id) {
    const e = Seed.EXERCISES.find((x) => x.id === id);
    return e ? Object.assign({ machineSetting: '', archived: false, isCustom: false }, JSON.parse(JSON.stringify(e))) : null;
  }

  // Yeni kullanıcı (v19): boş başlar, ilk kurulum ekranında program seçer (onboarded: false).
  // withSeed: eski başlangıç (Push/Pull + 1 Kasım kaydı), yalnızca testler için.
  function initialState(opts) {
    const o = opts || {};
    const state = {
      schemaVersion: SCHEMA_VERSION,
      onboarded: false,
      exercises: {},
      templates: [JSON.parse(JSON.stringify(Seed.TEMPLATES.find((t) => t.kind === 'cardio')))],
      workouts: [],
      activeWorkoutId: null,
      settings: { weeklyCardioGoal: 150, lastBackupAt: null },
    };
    if (o.withSeed) {
      for (const e of Seed.EXERCISES) state.exercises[e.id] = catalogExercise(e.id);
      state.templates = JSON.parse(JSON.stringify(Seed.TEMPLATES));
      state.workouts = Seed.seedWorkouts();
      state.onboarded = true;
    }
    return state;
  }

  // İlk kurulum: seçilen programın günlerini ve hareketlerini ekler (var olan günlere dokunmaz).
  function applyProgram(state, programId) {
    const program = Seed.PROGRAMS.find((p) => p.id === programId);
    if (!program) throw new Error('Program bulunamadı: ' + programId);
    for (const t of program.templates) {
      for (const it of t.items) {
        if (!state.exercises[it.exerciseId]) state.exercises[it.exerciseId] = catalogExercise(it.exerciseId);
      }
      let id = t.id;
      while (state.templates.some((x) => x.id === id)) id = t.id + '-' + uid('t').slice(-4);
      const copy = JSON.parse(JSON.stringify(t));
      copy.id = id;
      // Güç günleri kardiyodan önce
      const cardioAt = state.templates.findIndex((x) => x.kind === 'cardio');
      if (cardioAt === -1) state.templates.push(copy); else state.templates.splice(cardioAt, 0, copy);
    }
    state.onboarded = true;
    return state;
  }

  // Eski şema sürümlerinden yükseltme burada yapılacak.
  function migrate(state) {
    if (!state || typeof state !== 'object') return initialState();
    if (!state.schemaVersion) state.schemaVersion = 1;
    state.exercises = state.exercises || {};
    state.templates = state.templates || [];
    state.workouts = state.workouts || [];
    state.settings = Object.assign({ weeklyCardioGoal: 150, lastBackupAt: null }, state.settings || {});
    if (state.activeWorkoutId && !state.workouts.some((w) => w.id === state.activeWorkoutId)) {
      state.activeWorkoutId = null;
    }
    // v2: hareketlere tekrar aralığı (hedef önerisi için). Var olan değerlere dokunma.
    if (state.schemaVersion < 2) {
      const defaults = {};
      for (const e of Seed.EXERCISES) defaults[e.id] = e;
      for (const id of Object.keys(state.exercises)) {
        const ex = state.exercises[id];
        const d = defaults[id];
        if (!(ex.repMin > 0)) ex.repMin = d ? d.repMin : (ex.type === 'bodyweight' ? 6 : 8);
        if (!(ex.repMax > ex.repMin)) ex.repMax = d ? d.repMax : (ex.type === 'bodyweight' ? 15 : 12);
      }
      state.schemaVersion = 2;
    }
    // v3: kardiyoda 1–10 "zorluk" yerine makineye özel ayarlar (hız, eğim, seviye) ve kalori.
    // Seviye soran makinelerde eski zorluk seviyeye taşınır; eski alan silinmez (veri kaybı yok).
    if (state.schemaVersion < 3) {
      const types = {};
      for (const t of Seed.CARDIO_TYPES) types[t.id] = t;
      for (const w of state.workouts) {
        for (const c of w.cardio || []) {
          if (!c.settings) c.settings = {};
          if (c.calories === undefined) c.calories = null;
          const t = types[c.type];
          if (c.difficulty > 0 && t && t.fields.includes('level') && !(c.settings.level > 0)) c.settings.level = c.difficulty;
        }
      }
      state.schemaVersion = 3;
    }
    // v4: ilk kurulum ekranı. Var olan veri kurulmuş sayılır (kullanıcı hiçbir şey görmez).
    if (state.schemaVersion < 4) {
      if (state.onboarded === undefined) state.onboarded = true;
      state.schemaVersion = 4;
    }
    return state;
  }

  function load(storage) {
    try {
      const raw = storage.getItem(KEY);
      if (!raw) {
        const s = initialState();
        save(storage, s);
        return s;
      }
      return migrate(JSON.parse(raw));
    } catch (e) {
      console.error('Veri okunamadı', e);
      return initialState();
    }
  }

  function save(storage, state) {
    storage.setItem(KEY, JSON.stringify(state));
  }

  function exportJson(state) {
    return JSON.stringify({ app: 'progressive', exportedAt: new Date().toISOString(), data: state }, null, 2);
  }

  // Yedek dosyasını doğrular; hatalıysa hata fırlatır.
  function parseBackup(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('Dosya okunamadı (geçerli bir yedek değil).'); }
    const data = obj && obj.app === 'progressive' ? obj.data : null;
    if (!data || !Array.isArray(data.workouts) || typeof data.exercises !== 'object') {
      throw new Error('Bu dosya Progressive yedeği gibi görünmüyor.');
    }
    return migrate(data);
  }

  // Anahtar sırasından bağımsız JSON (iki verinin aynı olup olmadığını anlamak için).
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined && k !== '_plan')
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  // Ayarlar (ör. son yedek tarihi) hariç, antrenman verisinin özü.
  function contentKey(state) {
    return stableStringify({ exercises: state.exercises, templates: state.templates, workouts: state.workouts });
  }

  function finished(state) {
    return (state.workouts || []).filter((w) => w.endedAt);
  }

  function latestStart(list) {
    return list.reduce((m, w) => (!m || new Date(w.startedAt) > new Date(m) ? w.startedAt : m), null);
  }

  // Yedek dosyasını okuyup mevcut veriyle karşılaştırır.
  function backupInfo(current, text) {
    const data = parseBackup(text);
    let exportedAt = null;
    try { exportedAt = JSON.parse(text).exportedAt || null; } catch (e) { /* parseBackup zaten doğruladı */ }
    const b = finished(data);
    const c = finished(current);
    const backupLatest = latestStart(b);
    const currentLatest = latestStart(c);
    const newerInCurrent = c.filter((w) => !backupLatest || new Date(w.startedAt) > new Date(backupLatest)).length;
    return {
      data,
      exportedAt,
      identical: contentKey(data) === contentKey(current),
      backupCount: b.length,
      currentCount: c.length,
      backupLatest,
      currentLatest,
      newerInCurrent,              // yedekte olmayan, ondan sonra girilmiş antrenman sayısı
      isOlder: newerInCurrent > 0, // yüklenirse bunlar silinir
    };
  }

  return { KEY, SCHEMA_VERSION, uid, initialState, applyProgram, catalogExercise, migrate, load, save, exportJson, parseBackup, stableStringify, backupInfo };
});
