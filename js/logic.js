/*
 * Saf hesaplama fonksiyonları (arayüzden bağımsız, birim testli).
 * Tarayıcıda window.Logic, Node'da require('./logic.js').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;
  // Tahmini 1RM (Epley) yalnızca 10 tekrar ve altında güvenilir kabul edilir.
  const E1RM_MAX_REPS = 10;

  // ---------- Biçimlendirme ----------

  // 32.5 -> "32,5", 47 -> "47", 6.25 -> "6,25"
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    const r = Math.round(n * 100) / 100;
    return String(r).replace('.', ',');
  }

  // Türkçe ondalık virgülü de kabul eden sayı okuma
  function parseNum(text) {
    if (typeof text === 'number') return text;
    const v = parseFloat(String(text).trim().replace(',', '.'));
    return isNaN(v) ? null : v;
  }

  // 45 -> "45 sn", 90 -> "1:30 dk"
  function fmtDuration(sec) {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    if (n < 60) return n + ' sn';
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0') + ' dk';
  }

  function formatSet(type, set) {
    if (!set) return '–';
    if (type === 'timed') {
      return (set.weight > 0 ? '+' + fmtNum(set.weight) + ' kg · ' : '') + fmtDuration(set.seconds);
    }
    const reps = set.reps;
    if (type === 'bodyweight') {
      return (set.weight > 0 ? 'VA+' + fmtNum(set.weight) : 'VA') + '×' + reps;
    }
    if (type === 'assisted') {
      return 'destek ' + fmtNum(set.weight) + '×' + reps;
    }
    return fmtNum(set.weight) + '×' + reps;
  }

  // ---------- Ağırlık adımı ----------

  function stepValue(value, step, direction) {
    const v = (Number(value) || 0) + direction * (Number(step) || 0);
    return Math.max(0, Math.round(v * 1000) / 1000);
  }

  // ---------- En iyi set ----------

  // Epley. 10 tekrarın üstünde formül şişirdiği için 10 tekrar sayılır;
  // böylece aynı ağırlıkta daha çok tekrar asla daha kötü görünmez.
  function e1rm(weight, reps) {
    if (!(reps > 0) || !(weight >= 0)) return 0;
    const r = Math.min(reps, E1RM_MAX_REPS);
    return weight * (1 + r / 30);
  }

  function isWorkingSet(set) {
    return !!set && !set.isWarmup && (set.reps > 0 || set.seconds > 0);
  }

  // Karşılaştırma için skor dizisi (sözlük sırasıyla büyük olan daha iyi).
  function setScore(type, set) {
    // Vücut ağırlığı: asıl ölçüt tekrar; tekrar eşitse ek ağırlık. O günkü kilo karşılaştırmaya girmez.
    if (type === 'bodyweight') return [set.reps, set.weight || 0];
    // Süreli (plank vb.): asıl ölçüt süre; eşitse ek ağırlık
    if (type === 'timed') return [set.seconds || 0, set.weight || 0];
    if (type === 'assisted') return [-(set.weight || 0), set.reps];
    return [e1rm(set.weight, set.reps), set.reps];
  }

  function compareScores(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (Math.abs(d) > EPS) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  // Vücut ağırlığı hareketinde toplam yük = o günkü kilo + ek ağırlık (kilo girildiyse).
  // Şimdilik sadece kayıt/hacim için; ↑/↓ karşılaştırmasında kullanılmıyor.
  function totalLoad(set) {
    return set && set.bodyWeight > 0 ? set.bodyWeight + (set.weight || 0) : null;
  }

  // a, b'den iyiyse 1, kötüyse -1, eşitse 0.
  function compareSets(type, a, b) {
    return compareScores(setScore(type, a), setScore(type, b));
  }

  function bestSet(type, sets) {
    let best = null;
    for (const s of sets || []) {
      if (!isWorkingSet(s)) continue;
      if (!best || compareSets(type, s, best) > 0) best = s;
    }
    return best;
  }

  // 'up' | 'down' | 'same' | 'new' | null
  function trend(type, prevBest, curBest) {
    if (!curBest) return null;
    if (!prevBest) return 'new';
    const c = compareSets(type, curBest, prevBest);
    return c > 0 ? 'up' : c < 0 ? 'down' : 'same';
  }

  // ---------- Hedef önerisi (çift ilerleme) ----------

  function repRange(ex) {
    const min = ex && ex.repMin > 0 ? ex.repMin : 6;
    const max = ex && ex.repMax > min ? ex.repMax : Math.max(min + 4, 12);
    return { min, max };
  }

  function timeStepOf(ex) {
    return ex && ex.timeStep > 0 ? ex.timeStep : 5;
  }

  // Taslak (giriş kutuları) için setin değerleri
  function draftOf(s) {
    return s.seconds > 0 ? { weight: s.weight || 0, seconds: s.seconds } : { weight: s.weight || 0, reps: s.reps };
  }

  // Geçen seferin aynı sıradaki setine göre bu setin hedefi:
  // tekrar aralığının tepesine ulaşılmadıysa +1 tekrar, ulaşıldıysa +1 ağırlık adımı ve aralığın alt ucu.
  // Vücut ağırlığında hep +1 tekrar.
  function nextTarget(ex, prev) {
    if (!prev || prev.isWarmup) return null;
    const type = ex ? ex.type : 'weighted';
    // Süreli: geçen seferki süre + süre adımı, ek ağırlık aynı
    if (type === 'timed') {
      if (!(prev.seconds > 0)) return null;
      return { weight: prev.weight || 0, seconds: prev.seconds + timeStepOf(ex), kind: 'time' };
    }
    if (!(prev.reps > 0)) return null;
    if (type === 'bodyweight' || type === 'assisted') {
      return { weight: prev.weight || 0, reps: prev.reps + 1, kind: 'reps' };
    }
    const r = repRange(ex);
    if (prev.reps < r.max) return { weight: prev.weight, reps: prev.reps + 1, kind: 'reps' };
    return { weight: stepValue(prev.weight, ex.weightStep || 2.5, 1), reps: r.min, kind: 'weight' };
  }

  // Hedef sadece son N sette verilir (tükenişe yakın, ilerlemeyi asıl taşıyan setler).
  // Önceki setler geçen seferki gibi doldurulur. Plandan fazla eklenen setler de "son" sayılır.
  function isTargetSet(index, plannedSets, lastN) {
    const n = lastN > 0 ? lastN : 2;
    return index >= Math.max(0, (plannedSets || 0) - n);
  }

  // Bu setin rolü ve hedefi (Ayarlar → Hedef önerisi):
  //  mode 'top'  : üst set düzeni. İlk çalışma seti = üst set; geçen seferin en iyi setine göre hedef.
  //               Sonraki çalışma setleri düşüş seti: hedef yok, aynı ağırlıkla devam (tekrar alt sınırın
  //               altına düşecekse ağırlık %5–10 azaltılır).
  //  mode 'last1' / 'last2': yükselen piramit. Hedef son 1–2 sette, öncekiler hazırlık seti.
  // Dönüş: { role: 'warmup' | 'top' | 'backoff' | 'target' | 'prep', target, ref, draft, lighter }
  function setPlan(o) {
    const ex = o.exercise || { type: 'weighted' };
    const type = ex.type;
    const prev = o.prevSets || [];
    const cur = o.currentSets || [];
    if (o.isWarmup) return { role: 'warmup', target: null, ref: null, draft: null };
    // Süreli hareket (kullanıcı isteği, v17): set düzeninden bağımsız, her çalışma seti
    // geçen seferin aynı sıradaki setinin süresi + süre adımı (o sıra yoksa geçen seferin son seti).
    if (type === 'timed') {
      const pw = prev.filter(isWorkingSet);
      const i = cur.filter(isWorkingSet).length;
      const ref = pw[i] || pw[pw.length - 1] || null;
      const target = nextTarget(ex, ref);
      return { role: 'target', target, ref, draft: target ? draftOf(target) : null };
    }
    if (o.mode === 'top') {
      const working = cur.filter(isWorkingSet);
      if (!working.length) {
        const ref = bestSet(type, prev);
        const target = nextTarget(ex, ref);
        return { role: 'top', target, ref, draft: target ? draftOf(target) : null };
      }
      const top = working[0];
      const last = working[working.length - 1];
      // Geçen seferin aynı sıradaki çalışma seti bugünkü son setten ağır değilse onu, yoksa bugünkü son seti öner
      // (düşüş seti hiçbir zaman bir önceki setten ağır önerilmez)
      const p = prev.filter(isWorkingSet)[working.length];
      const base = p && p.weight <= last.weight ? p : last;
      const lighter = type !== 'weighted' ? null
        : Math.max(0, Math.floor((top.weight * 0.925) / (ex.weightStep || 2.5)) * (ex.weightStep || 2.5));
      return { role: 'backoff', target: null, ref: top, draft: draftOf(base), lighter };
    }
    const n = o.mode === 'last1' ? 1 : 2;
    const i = cur.filter(isWorkingSet).length;          // ısınmalar sayılmaz
    const ref = prev.filter(isWorkingSet)[i] || null;
    if (isTargetSet(i, o.plannedSets, n)) {
      const target = nextTarget(ex, ref);
      return { role: 'target', target, ref, draft: target ? draftOf(target) : null };
    }
    return { role: 'prep', target: null, ref: ref && !ref.isWarmup ? ref : null, draft: null };
  }

  // ---------- Kişisel rekor ----------

  // Bu antrenmandan önceki (başlangıç zamanına göre) tüm bitmiş antrenmanlardaki en iyi set
  function priorBest(workouts, type, exerciseId, before, excludeId) {
    const t = new Date(before);
    const sets = (workouts || [])
      .filter((w) => w.id !== excludeId && w.endedAt && new Date(w.startedAt) < t)
      .flatMap((w) => (w.exercises || []).filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets || []));
    return bestSet(type, sets);
  }

  // Her set için: önceki tüm antrenmanları VE bu antrenmandaki önceki setleri geçiyor mu?
  // Hareket ilk kez yapılıyorsa rekor sayılmaz (kıyaslanacak geçmiş yok).
  function recordFlags(type, sets, prior) {
    let bar = prior;
    return (sets || []).map((s) => {
      if (!bar || !isWorkingSet(s)) return false;
      const rec = compareSets(type, s, bar) > 0;
      if (rec) bar = s;
      return rec;
    });
  }

  // ---------- Hareket geçmişi (detay sayfası ve grafik) ----------

  function exerciseHistory(state, exerciseId) {
    const ex = (state.exercises || {})[exerciseId] || { type: 'weighted' };
    const type = ex.type;
    const chronological = (state.workouts || []).filter(isFinished)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    const sessions = [];
    let runningBest = null;
    for (const w of chronological) {
      const sets = (w.exercises || []).filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets || []);
      const best = bestSet(type, sets);
      if (!best) continue;
      const isPR = !!runningBest && compareSets(type, best, runningBest) > 0;
      if (!runningBest || compareSets(type, best, runningBest) > 0) runningBest = best;
      sessions.push({
        workoutId: w.id, workoutName: w.name, date: w.startedAt,
        sets: sets.filter((s) => s.reps > 0 || s.seconds > 0), best, score: sessionScore(type, sets), isPR,
      });
    }
    const first = sessions[0] || null;
    const last = sessions[sessions.length - 1] || null;
    const bestSession = sessions.reduce((m, s) => (!m || compareSets(type, s.best, m.best) > 0 ? s : m), null);
    return {
      type,
      metric: metricOf(type),
      sessions,
      first,
      last,
      bestSession,
      prCount: sessions.filter((s) => s.isPR).length,
      changePct: first && last && first !== last && first.score
        ? Math.round(((last.score - first.score) / first.score) * 1000) / 10 : null,
    };
  }

  // ---------- Geçen sefer ve ön doldurma ----------

  function byStartDesc(a, b) {
    return new Date(b.startedAt) - new Date(a.startedAt);
  }

  // Bu hareketin en son yapıldığı (başka) antrenman ve setleri.
  // before verilirse yalnızca o andan önce başlamış antrenmanlar (geçmiş bir antrenmanı düzenlerken).
  function lastPerformance(workouts, exerciseId, excludeWorkoutId, before) {
    const t = before ? new Date(before) : null;
    const sorted = (workouts || []).filter((w) => w.id !== excludeWorkoutId && (!t || new Date(w.startedAt) < t)).sort(byStartDesc);
    for (const w of sorted) {
      const ex = (w.exercises || []).find((e) => e.exerciseId === exerciseId);
      if (ex && ex.sets && ex.sets.length) return { workout: w, sets: ex.sets };
    }
    return null;
  }

  // index. setin varsayılan değerleri: geçen seferin aynı sıradaki seti,
  // yoksa bu antrenmanda girilen son set, yoksa geçen seferin son seti.
  function prefill(prevSets, currentSets, index, exercise) {
    const prev = prevSets || [];
    const cur = currentSets || [];
    const pick = (s, warm) => Object.assign(draftOf(s), { isWarmup: !!warm });
    if (prev[index]) return pick(prev[index], prev[index].isWarmup);
    if (cur.length) return pick(cur[cur.length - 1], false);
    if (prev.length) return pick(prev[prev.length - 1], false);
    const type = exercise && exercise.type;
    if (type === 'timed') return { weight: 0, seconds: 30, isWarmup: false };
    return { weight: 0, reps: type === 'weighted' ? 8 : 10, isWarmup: false };
  }

  // ---------- Kalori (tahmini) ----------
  // Kardiyo: kullanıcının makineden girdiği kalori esas. Girilmediyse önce kendi geçmiş kayıtlarından
  // (aynı makine, benzer ayarlar → dakika başı kalori) tahmin edilir; geçmiş yoksa MET formülüyle.
  // Ağırlık: set sayısından süre (çalışma seti ≈ 2 dk dinlenme dahil, ısınma ≈ 1 dk) × MET 5 (orta-yoğun direnç antrenmanı).
  // Boy, yaş ve cinsiyet girildiyse 1 MET = kişinin dinlenme metabolizması (Mifflin-St Jeor), yoksa 1 MET = 1 kcal/kg/saat.

  const STRENGTH_MET = 5;
  const MIN_PER_WORK_SET = 2;
  const MIN_PER_WARMUP_SET = 1;
  // Ayar benzerliği için ölçek: bu kadar fark = 1 birim uzaklık
  const SETTING_SCALE = { speed: 1, incline: 2, level: 2, setting: 2 };

  // Dinlenme metabolizması, kcal/dk (boy, yaş, cinsiyet ve kilo gerekli)
  function restingKcalPerMin(profile, kg) {
    const p = profile || {};
    if (!(kg > 0 && p.heightCm > 0 && p.age > 0 && (p.sex === 'm' || p.sex === 'f'))) return null;
    const bmr = 10 * kg + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'm' ? 5 : -161);
    return bmr / 1440;
  }

  function kcalFromMet(met, minutes, kg, profile) {
    if (!(met > 0) || !(minutes > 0) || !(kg > 0)) return null;
    const rmr = restingKcalPerMin(profile, kg);
    return rmr !== null ? met * rmr * minutes : (met * kg * minutes) / 60;
  }

  // Makine ve ayarlara göre MET (genel formül; geçmiş kayıt yoksa)
  function cardioMet(type, st) {
    const s = st || {};
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    if (type === 'treadmill' || type === 'walk') {
      // ACSM: yürüme/koşu oksijen tüketimi (hız m/dk, eğim oran)
      const kmh = s.speed > 0 ? s.speed : type === 'walk' ? 5 : 8;
      const v = (kmh * 1000) / 60;
      const g = (s.incline || 0) / 100;
      const vo2 = kmh >= 8 ? 0.2 * v + 0.9 * v * g + 3.5 : 0.1 * v + 1.8 * v * g + 3.5;
      return vo2 / 3.5;
    }
    if (type === 'bike') return s.level > 0 ? clamp(3.5 + 0.35 * s.level, 3.5, 12) : 6.8;
    if (type === 'elliptical') return s.level > 0 ? clamp(4 + 0.3 * s.level, 4, 10) : 5;
    if (type === 'rower') return s.level > 0 ? clamp(4.8 + 0.3 * s.level, 4.8, 12) : 7;
    if (type === 'stairs') return s.level > 0 ? clamp(5 + 0.45 * s.level, 5, 12) : 9;
    return 5;
  }

  function settingDistance(a, b) {
    const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
    let d = 0;
    for (const k of keys) {
      const x = a && a[k], y = b && b[k];
      if (x === undefined || x === null || y === undefined || y === null) { d += 0.5; continue; }
      d += Math.abs(x - y) / (SETTING_SCALE[k] || 2);
    }
    return d;
  }

  // entry: { type, minutes, settings }. past: önceki kardiyo kayıtları (elle girilmiş kalorisi olanlar kullanılır).
  // Dönüş: { kcal, source: 'history' | 'formula', basedOn } ya da null
  function estimateCardioCalories(entry, past, kg, profile) {
    if (!entry || !(entry.minutes > 0)) return null;
    const same = (past || []).filter((c) => c && c !== entry && c.type === entry.type && c.calories > 0 && c.minutes > 0 && !c.caloriesEstimated);
    if (same.length) {
      const ranked = same.map((c) => ({ c, d: settingDistance(entry.settings, c.settings) }))
        .sort((x, y) => x.d - y.d).slice(0, 5);
      let wSum = 0, rate = 0;
      for (const r of ranked) {
        const w = 1 / Math.pow(1 + r.d, 2);
        wSum += w;
        rate += w * (r.c.calories / r.c.minutes);
      }
      return { kcal: Math.round((rate / wSum) * entry.minutes), source: 'history', basedOn: ranked.length };
    }
    const kcal = kcalFromMet(cardioMet(entry.type, entry.settings), entry.minutes, kg, profile);
    return kcal === null ? null : { kcal: Math.round(kcal), source: 'formula', basedOn: 0 };
  }

  // Ağırlık antrenmanının tahmini kalorisi (kardiyo hariç)
  function strengthCalories(w, kg, profile) {
    let minutes = 0;
    for (const e of (w && w.exercises) || []) {
      for (const st of e.sets || []) {
        if (!(st.reps > 0 || st.seconds > 0)) continue;
        minutes += st.isWarmup ? MIN_PER_WARMUP_SET : MIN_PER_WORK_SET;
      }
    }
    if (!minutes) return 0;
    const k = kcalFromMet(STRENGTH_MET, minutes, kg, profile);
    return k === null ? null : Math.round(k);
  }

  // O tarihteki (ya da öncesindeki en yakın) kilo; hiç yoksa en eski ölçüm
  function bodyWeightAt(workouts, at) {
    const t = new Date(at);
    const measured = (workouts || []).filter((w) => w.bodyWeight > 0)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    if (!measured.length) return null;
    let kg = measured[0].bodyWeight;
    for (const w of measured) { if (new Date(w.startedAt) <= t) kg = w.bodyWeight; else break; }
    return kg;
  }

  // Bir antrenmanın kalorisi: ağırlık (tahmini) + kardiyo (girilen ya da tahmini)
  function workoutCalories(state, w) {
    const profile = (state.settings && state.settings.profile) || {};
    const kg = w.bodyWeight > 0 ? w.bodyWeight : bodyWeightAt(state.workouts, w.startedAt);
    const strength = strengthCalories(w, kg, profile);
    let cardio = 0, entered = 0, estimated = 0, missing = 0;
    for (const c of w.cardio || []) {
      if (c.calories > 0) {
        cardio += c.calories;
        if (c.caloriesEstimated) estimated++; else entered++;
      } else {
        missing++;
      }
    }
    return {
      strength,                       // null: kilo bilinmiyor
      cardio,
      cardioEntries: (w.cardio || []).length,
      cardioMissing: missing,         // kalorisi girilmemiş kardiyo kaydı
      cardioEstimated: estimated,
      total: (strength || 0) + cardio,
    };
  }

  // Dönemin günlük kalori dizisi (Özet → kalori grafiği). week: 7 gün, month: ayın günleri.
  function calorieSeries(state, kind, ref, group) {
    const range = periodRange(kind, ref, 0);
    const done = (state.workouts || []).filter(isFinished).filter((w) => inRange(w, range) && inGroup(w, group));
    const days = [];
    for (let d = new Date(range.start); d < range.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      days.push({ date: d, strength: 0, cardio: 0, total: 0, workouts: 0 });
    }
    let strengthUnknown = 0, cardioMissing = 0;
    for (const w of done) {
      const day = days.find((x) => dayKey(x.date) === dayKey(w.startedAt));
      if (!day) continue;
      const c = workoutCalories(state, w);
      if (c.strength === null && hasStrengthSets(w)) strengthUnknown++;
      cardioMissing += c.cardioMissing;
      day.strength += c.strength || 0;
      day.cardio += c.cardio;
      day.total = day.strength + day.cardio;
      day.workouts++;
    }
    const sum = (k) => days.reduce((t, x) => t + x[k], 0);
    return { range, days, strength: sum('strength'), cardio: sum('cardio'), total: sum('total'), strengthUnknown, cardioMissing };
  }

  // Son kardiyo antrenmanı (geçen seferki kardiyo özeti için)
  function lastCardioSession(workouts, excludeId, before) {
    const t = before ? new Date(before) : null;
    return (workouts || []).filter((w) => w.id !== excludeId && (w.cardio || []).length && (!t || new Date(w.startedAt) < t))
      .sort(byStartDesc)[0] || null;
  }

  // ---------- Sürüm notu ----------
  // Görülen sürümden sonraki (şu ana kadarki) notlar, en yeni üstte, en çok max adet.
  // seen yoksa (bu özellikten önceki kullanıcı) yalnızca son sürümün notu.
  function changesSince(changelog, seen, current, max) {
    const from = seen > 0 ? seen : current - 1;
    return (changelog || []).filter((c) => c.v > from && c.v <= current)
      .sort((a, b) => b.v - a.v).slice(0, max || 5);
  }

  // ---------- Düzenleme: değişiklik listesi ----------
  // before/after: { exercises, cardio } (düzenleme başındaki kopya ve şimdiki hali). Setler ve kardiyo id ile eşlenir.
  function workoutChanges(before, after, exercises, cardioName) {
    const ex = exercises || {};
    const nameOf = (id) => (ex[id] && ex[id].name) || id;
    const typeOf = (id) => (ex[id] && ex[id].type) || 'weighted';
    const sets = (w) => {
      const m = new Map();
      for (const e of (w && w.exercises) || []) {
        (e.sets || []).forEach((st) => m.set(st.id, { exerciseId: e.exerciseId, set: st }));
      }
      return m;
    };
    const a = sets(before), b = sets(after);
    const out = [];
    const fmt = (x) => (x.set.isWarmup ? 'ısınma ' : '') + formatSet(typeOf(x.exerciseId), x.set);
    for (const [id, x] of b) {
      const old = a.get(id);
      if (!old) out.push({ kind: 'add', text: nameOf(x.exerciseId) + ': set eklendi (' + fmt(x) + ')' });
      else if (old.set.weight !== x.set.weight || old.set.reps !== x.set.reps || old.set.seconds !== x.set.seconds || !!old.set.isWarmup !== !!x.set.isWarmup) {
        out.push({ kind: 'change', text: nameOf(x.exerciseId) + ': ' + fmt(old) + ' → ' + fmt(x) });
      }
    }
    for (const [id, x] of a) if (!b.has(id)) out.push({ kind: 'remove', text: nameOf(x.exerciseId) + ': set silindi (' + fmt(x) + ')' });
    const cn = (c) => (cardioName ? cardioName(c.type) : c.type) + ' ' + c.minutes + ' dk';
    const ca = new Map(((before && before.cardio) || []).map((c) => [c.id, c]));
    const cb = new Map(((after && after.cardio) || []).map((c) => [c.id, c]));
    for (const [id, c] of cb) {
      const old = ca.get(id);
      if (!old) out.push({ kind: 'add', text: 'Kardiyo eklendi: ' + cn(c) });
      else if (JSON.stringify([old.type, old.minutes, old.distanceKm, old.calories, old.settings]) !== JSON.stringify([c.type, c.minutes, c.distanceKm, c.calories, c.settings])) {
        out.push({ kind: 'change', text: 'Kardiyo değişti: ' + cn(old) + (old.minutes !== c.minutes || old.type !== c.type ? ' → ' + cn(c) : '') });
      }
    }
    for (const [id, c] of ca) if (!cb.has(id)) out.push({ kind: 'remove', text: 'Kardiyo silindi: ' + cn(c) });
    return out;
  }

  // ---------- Dönemler ve genel bakış ----------

  // Pazartesi başlayan hafta veya takvim ayı. offset = -1 bir önceki dönem.
  function periodRange(kind, ref, offset) {
    const d = new Date(ref);
    d.setHours(0, 0, 0, 0);
    let start, end;
    if (kind === 'month') {
      start = new Date(d.getFullYear(), d.getMonth() + (offset || 0), 1);
      end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    } else {
      const dow = (d.getDay() + 6) % 7; // Pazartesi = 0
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow + 7 * (offset || 0));
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    }
    return { start, end };
  }

  function inRange(w, range) {
    const t = new Date(w.startedAt);
    return t >= range.start && t < range.end;
  }

  function isFinished(w) {
    return !!w.endedAt;
  }

  function hasStrengthSets(w) {
    return (w.exercises || []).some((e) => (e.sets || []).some(isWorkingSet));
  }

  function cardioMinutes(w) {
    return (w.cardio || []).reduce((t, c) => t + (Number(c.minutes) || 0), 0);
  }

  // Birden çok makinenin toplamı. Mesafe/kalori girilmeyen kayıtlar toplama katılmaz;
  // hiç girilmediyse null (arayüzde gösterilmez).
  function cardioTotals(list) {
    const sum = (key) => {
      const vals = (list || []).map((c) => Number(c[key])).filter((v) => v > 0);
      return vals.length ? Math.round(vals.reduce((t, v) => t + v, 0) * 100) / 100 : null;
    };
    return {
      count: (list || []).length, minutes: sum('minutes') || 0, distanceKm: sum('distanceKm'), calories: sum('calories'),
      caloriesMissing: (list || []).filter((c) => !(Number(c.calories) > 0)).length,
      caloriesEstimated: (list || []).filter((c) => Number(c.calories) > 0 && c.caloriesEstimated).length,
    };
  }

  // Bir antrenmandaki hareketin "güç puanı" = o antrenmandaki en iyi setinin değeri.
  // Ağırlıklı: tahmini 1RM (kg). Vücut ağırlığı: tekrar. Destekli: destek ağırlığı (az olan iyi).
  function metricOf(type) {
    return type === 'bodyweight' ? 'reps' : type === 'assisted' ? 'assist' : type === 'timed' ? 'seconds' : 'e1rm';
  }

  function sessionScore(type, sets) {
    const b = bestSet(type, sets);
    if (!b) return null;
    if (type === 'bodyweight') return b.reps;
    if (type === 'timed') return b.seconds;
    if (type === 'assisted') return b.weight || 0;
    return e1rm(b.weight, b.reps);
  }

  // Ortalama karşılaştırması. Çok küçük oynamalar "=" sayılır:
  // 1RM'de %0,5'ten az, tekrarda 0,1'den az fark.
  function compareAverages(metric, prev, cur) {
    if (cur === null || cur === undefined) return null;
    if (prev === null || prev === undefined) return 'new';
    const diff = metric === 'assist' ? prev - cur : cur - prev;
    const same = metric === 'e1rm' ? Math.abs(diff) < prev * 0.005
      : metric === 'seconds' ? Math.abs(diff) < 0.5 - EPS : Math.abs(diff) < 0.1 - EPS;
    return same ? 'same' : diff > 0 ? 'up' : 'down';
  }

  function mean(list) {
    return list.length ? list.reduce((t, v) => t + v, 0) / list.length : null;
  }

  // Antrenman türü grupları (Geçmiş/Özet sekmeleri): şablon sırasıyla, sonra silinmiş şablonlardan kalan kayıtlar.
  function workoutGroups(state) {
    const groups = (state.templates || []).map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
    const known = new Set(groups.map((g) => g.id));
    for (const w of state.workouts || []) {
      if (w.templateId && !known.has(w.templateId)) {
        groups.push({ id: w.templateId, name: w.name, kind: 'other' });
        known.add(w.templateId);
      }
    }
    return groups;
  }

  function inGroup(w, group) {
    return !group || group === 'all' || w.templateId === group;
  }

  // group: 'all' (veya boş) ya da şablon id'si (ör. 'push') → sadece o türün antrenmanları
  function summarize(state, kind, ref, group) {
    const range = periodRange(kind, ref, 0);
    const prevRange = periodRange(kind, ref, -1);
    const done = (state.workouts || []).filter((w) => isFinished(w) && inGroup(w, group));
    const cur = done.filter((w) => inRange(w, range));
    const prev = done.filter((w) => inRange(w, prevRange));
    const before = done.filter((w) => new Date(w.startedAt) < range.start).sort(byStartDesc);

    const setsIn = (w, id) => (w.exercises || []).filter((e) => e.exerciseId === id).flatMap((e) => e.sets || []);
    const scores = (list, type, id) => list.map((w) => sessionScore(type, setsIn(w, id))).filter((v) => v !== null);

    const exerciseIds = [];
    for (const w of cur.slice().sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))) {
      for (const e of w.exercises || []) {
        if ((e.sets || []).some(isWorkingSet) && !exerciseIds.includes(e.exerciseId)) exerciseIds.push(e.exerciseId);
      }
    }

    const exerciseProgress = exerciseIds.map((id) => {
      const ex = state.exercises[id] || { type: 'weighted', name: id };
      const metric = metricOf(ex.type);
      const curScores = scores(cur, ex.type, id);
      let prevScores = scores(prev, ex.type, id);
      let comparedTo = prevScores.length ? 'previous' : null;
      if (!prevScores.length) {
        // Önceki dönemde yapılmadıysa, bu dönemden önceki son antrenmanla karşılaştır
        const last = before.find((w) => sessionScore(ex.type, setsIn(w, id)) !== null);
        if (last) { prevScores = [sessionScore(ex.type, setsIn(last, id))]; comparedTo = 'earlier'; }
      }
      const avg = mean(curScores);
      const prevAvg = mean(prevScores);
      return {
        exerciseId: id,
        metric,
        sessions: curScores.length,
        prevSessions: prevScores.length,
        avg,
        prevAvg,
        pct: prevAvg ? Math.round(((avg - prevAvg) / prevAvg) * 1000) / 10 : null,
        best: bestSet(ex.type, cur.flatMap((w) => setsIn(w, id))),
        comparedTo,
        trend: compareAverages(metric, prevAvg, avg),
      };
    });

    // Hafta görünümü için 7 günlük şerit (Pazartesi → Pazar)
    let days = null;
    if (kind === 'week') {
      days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + i);
        const same = cur.filter((w) => dayKey(w.startedAt) === dayKey(d));
        days.push({ date: d, strength: same.some(hasStrengthSets), cardio: same.some((w) => cardioMinutes(w) > 0) });
      }
    }

    return {
      kind,
      range,
      workoutCount: cur.length,
      strengthCount: cur.filter(hasStrengthSets).length,
      cardioOnlyCount: cur.filter((w) => !hasStrengthSets(w) && cardioMinutes(w) > 0).length,
      cardioMinutes: cur.reduce((t, w) => t + cardioMinutes(w), 0),
      cardio: cardioTotals(cur.flatMap((w) => w.cardio || [])),
      totalSets: cur.reduce((t, w) => t + workingSetCount(w), 0),
      trainingDays: new Set(cur.map((w) => dayKey(w.startedAt))).size,
      days,
      upCount: exerciseProgress.filter((p) => p.trend === 'up').length,
      downCount: exerciseProgress.filter((p) => p.trend === 'down').length,
      exerciseProgress,
    };
  }

  function dayKey(d) {
    const x = new Date(d);
    return x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate();
  }

  function workingSetCount(w) {
    return (w.exercises || []).reduce((t, e) => t + (e.sets || []).filter(isWorkingSet).length, 0);
  }

  // Geçmiş listesindeki tek satır için özet
  function workoutStats(w) {
    return {
      exercises: (w.exercises || []).filter((e) => (e.sets || []).some(isWorkingSet)).length,
      sets: workingSetCount(w),
      cardioMinutes: cardioMinutes(w),
      calories: cardioTotals(w.cardio).calories,
      caloriesMissing: cardioTotals(w.cardio).caloriesMissing,
      durationMin: w.endedAt ? Math.max(0, Math.round((new Date(w.endedAt) - new Date(w.startedAt)) / 60000)) : null,
    };
  }

  // Bitmiş antrenmanlar, en yeni önce
  function history(workouts) {
    return (workouts || []).filter(isFinished).sort(byStartDesc);
  }

  // "Bu hafta", "Geçen hafta", "19 – 25 Ekim", "Kasım 2026"
  function periodLabel(kind, offset, range) {
    if (kind === 'month') {
      return (offset === 0 ? 'Bu ay · ' : '') + MONTHS_TR[range.start.getMonth()] + ' ' + range.start.getFullYear();
    }
    if (offset === 0) return 'Bu hafta';
    if (offset === -1) return 'Geçen hafta';
    const a = range.start;
    const b = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1);
    return a.getMonth() === b.getMonth()
      ? a.getDate() + ' – ' + b.getDate() + ' ' + MONTHS_TR[b.getMonth()]
      : a.getDate() + ' ' + MONTHS_TR[a.getMonth()] + ' – ' + b.getDate() + ' ' + MONTHS_TR[b.getMonth()];
  }

  function daysSince(iso, now) {
    if (!iso) return Infinity;
    return Math.floor((new Date(now) - new Date(iso)) / 86400000);
  }

  // ---------- Kilo ----------

  // En son girilen kilo ve bu dönemden (hafta/ay) önceki son ölçüm.
  function bodyWeightStatus(workouts, kind, ref) {
    const range = periodRange(kind, ref, 0);
    const measured = (workouts || []).filter((w) => w.bodyWeight > 0)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const latest = measured[0] || null;
    const before = measured.find((w) => new Date(w.startedAt) < range.start) || null;
    return {
      current: latest ? latest.bodyWeight : null,
      currentAt: latest ? latest.startedAt : null,
      previous: before && before !== latest ? before.bodyWeight : null,
      change: latest && before && before !== latest ? Math.round((latest.bodyWeight - before.bodyWeight) * 10) / 10 : null,
    };
  }

  // Haftalık kilo karşılaştırması: en son ölçüm ve ondan yaklaşık 1 hafta önceki ölçüm
  // (son ölçümden 5–10 gün önceki ölçümler arasından 7 güne en yakın olanı).
  function weeklyBodyWeight(workouts) {
    const DAY = 86400000;
    const measured = (workouts || []).filter((w) => w.bodyWeight > 0)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const latest = measured[0];
    if (!latest) return null;
    const t = new Date(latest.startedAt).getTime();
    let ref = null;
    for (const w of measured) {
      const ago = (t - new Date(w.startedAt).getTime()) / DAY;
      if (ago < 5 || ago > 10) continue;
      if (!ref || Math.abs(ago - 7) < Math.abs((t - new Date(ref.startedAt).getTime()) / DAY - 7)) ref = w;
    }
    return {
      current: latest.bodyWeight,
      currentAt: latest.startedAt,
      weekAgo: ref ? ref.bodyWeight : null,
      weekAgoAt: ref ? ref.startedAt : null,
      change: ref ? Math.round((latest.bodyWeight - ref.bodyWeight) * 10) / 10 : null,
    };
  }

  // ---------- Tarih metinleri (Node'da da aynı çıksın diye yerel ayara bağlı değil) ----------

  const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos',
    'Eylül', 'Ekim', 'Kasım', 'Aralık'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // "2 Kasım 2026" · withTime → "2 Kasım 2026, 16:43" · noYear → "2 Kasım"
  function dateTr(iso, opts) {
    const d = new Date(iso);
    const o = opts || {};
    let s = d.getDate() + ' ' + MONTHS_TR[d.getMonth()];
    if (!o.noYear) s += ' ' + d.getFullYear();
    if (o.withTime) s += ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return s;
  }

  function backupFileName(date) {
    return 'Progressive ' + dateTr(date) + '.json';
  }

  // Takvim günü farkı: "bugün", "dün", "3 gün önce"
  function relativeDay(iso, now) {
    if (!iso) return '';
    const a = new Date(iso); a.setHours(0, 0, 0, 0);
    const b = new Date(now); b.setHours(0, 0, 0, 0);
    const days = Math.round((b - a) / 86400000);
    return days <= 0 ? 'bugün' : days === 1 ? 'dün' : days + ' gün önce';
  }

  return {
    E1RM_MAX_REPS, fmtNum, parseNum, formatSet, stepValue, e1rm, isWorkingSet, setScore,
    compareScores, totalLoad, compareSets, bestSet, trend, lastPerformance, prefill, periodRange,
    hasStrengthSets, cardioMinutes, summarize, daysSince, bodyWeightStatus, weeklyBodyWeight, MONTHS_TR, dateTr,
    backupFileName, relativeDay, dayKey, workingSetCount, workoutStats, history, periodLabel,
    metricOf, sessionScore, compareAverages, workoutGroups, inGroup,
    fmtDuration, timeStepOf, cardioTotals,
    restingKcalPerMin, kcalFromMet, cardioMet, estimateCardioCalories, strengthCalories, bodyWeightAt,
    workoutCalories, calorieSeries, lastCardioSession, workoutChanges, changesSince,
    repRange, nextTarget, isTargetSet, setPlan, priorBest, recordFlags, exerciseHistory,
  };
});
