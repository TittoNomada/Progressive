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
  const SCHEMA_VERSION = 1;

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function initialState() {
    const exercises = {};
    for (const e of Seed.EXERCISES) {
      exercises[e.id] = Object.assign({ machineSetting: '', archived: false, isCustom: false }, e);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      exercises,
      templates: JSON.parse(JSON.stringify(Seed.TEMPLATES)),
      workouts: Seed.seedWorkouts(),
      activeWorkoutId: null,
      settings: { weeklyCardioGoal: 150, lastBackupAt: null },
    };
  }

  // Eski şema sürümlerinden yükseltme burada yapılacak.
  function migrate(state) {
    if (!state || typeof state !== 'object') return initialState();
    if (!state.schemaVersion) state.schemaVersion = SCHEMA_VERSION;
    state.exercises = state.exercises || {};
    state.templates = state.templates || [];
    state.workouts = state.workouts || [];
    state.settings = Object.assign({ weeklyCardioGoal: 150, lastBackupAt: null }, state.settings || {});
    if (state.activeWorkoutId && !state.workouts.some((w) => w.id === state.activeWorkoutId)) {
      state.activeWorkoutId = null;
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

  return { KEY, SCHEMA_VERSION, uid, initialState, migrate, load, save, exportJson, parseBackup, stableStringify, backupInfo };
});
