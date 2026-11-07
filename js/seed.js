/*
 * Başlangıç verisi: hareket katalogu, şablonlar ve 1 Kasım 2026 Push kaydı.
 * Tarayıcıda window.Seed, Node'da require('./seed.js') olarak kullanılır.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Seed = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // type: 'weighted' (ağırlık × tekrar) | 'bodyweight' (tekrar, ağırlık = ek yük) |
  //       'assisted' (ağırlık = karşı/destek ağırlığı, azalması ilerlemedir)
  // repMin / repMax: çift ilerleme için tekrar aralığı (hedef önerisi). Ayarlar'dan değiştirilebilir.
  // 'timed' (plank vb.): set.seconds = süre, weight = ek ağırlık; timeStep = süre adımı (sn), hedef her seferinde +timeStep.
  // primaryMuscles / secondaryMuscles: şimdilik arayüzde kullanılmıyor (ileride hacim hesabı için).
  const EXERCISES = [
    { id: 'chest-press', repMin: 6, repMax: 10, name: 'Chest press', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['chest'], secondaryMuscles: ['triceps', 'front-delt'] },
    { id: 'fly', repMin: 6, repMax: 10, name: 'Fly', type: 'weighted', weightStep: 7,
      primaryMuscles: ['chest'], secondaryMuscles: ['front-delt'] },
    { id: 'dips', repMin: 6, repMax: 15, name: 'Dips', type: 'bodyweight', weightStep: 2.5,
      primaryMuscles: ['chest', 'triceps'], secondaryMuscles: ['front-delt'] },
    { id: 'shoulder-press', repMin: 6, repMax: 10, name: 'Shoulder press', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['front-delt'], secondaryMuscles: ['side-delt', 'triceps'] },
    { id: 'lateral-cable-raise', repMin: 8, repMax: 12, name: 'Lateral cable raise', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['side-delt'], secondaryMuscles: [] },
    { id: 'pull-up', repMin: 4, repMax: 12, name: 'Pull up', type: 'bodyweight', weightStep: 2.5,
      primaryMuscles: ['lats'], secondaryMuscles: ['biceps', 'upper-back'] },
    { id: 'lat-pulldown', repMin: 6, repMax: 10, name: 'Lat pulldown', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['lats'], secondaryMuscles: ['biceps', 'upper-back'] },
    { id: 'seated-row', repMin: 6, repMax: 10, name: 'Seated row', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['upper-back', 'lats'], secondaryMuscles: ['biceps', 'rear-delt'] },
    { id: 'face-pull', repMin: 10, repMax: 15, name: 'Face pull', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['rear-delt'], secondaryMuscles: ['upper-back'] },
    { id: 'reverse-crunch', repMin: 8, repMax: 20, name: 'Ters mekik', type: 'bodyweight', weightStep: 2.5,
      primaryMuscles: ['abs'], secondaryMuscles: [] },
    { id: 'dumbbell-curl', repMin: 8, repMax: 12, name: 'Dumbbell curl', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['biceps'], secondaryMuscles: ['forearms'] },
    // Bacak ve diğer programlar için (v19)
    { id: 'leg-press', repMin: 8, repMax: 12, name: 'Leg press', type: 'weighted', weightStep: 5,
      primaryMuscles: ['quads', 'glutes'], secondaryMuscles: ['hamstrings'] },
    { id: 'romanian-deadlift', repMin: 6, repMax: 10, name: 'Romanian deadlift', type: 'weighted', weightStep: 2.5,
      primaryMuscles: ['hamstrings', 'glutes'], secondaryMuscles: ['lower-back'] },
    { id: 'leg-extension', repMin: 10, repMax: 15, name: 'Leg extension', type: 'weighted', weightStep: 5,
      primaryMuscles: ['quads'], secondaryMuscles: [] },
    { id: 'leg-curl', repMin: 10, repMax: 15, name: 'Leg curl', type: 'weighted', weightStep: 5,
      primaryMuscles: ['hamstrings'], secondaryMuscles: [] },
    { id: 'calf-raise', repMin: 10, repMax: 15, name: 'Calf raise', type: 'weighted', weightStep: 5,
      primaryMuscles: ['calves'], secondaryMuscles: [] },
    { id: 'plank', name: 'Plank', type: 'timed', weightStep: 2.5, timeStep: 5, repMin: 6, repMax: 12,
      primaryMuscles: ['abs'], secondaryMuscles: [] },
  ];

  const TEMPLATES = [
    { id: 'push', name: 'Push', kind: 'strength', items: [
      { exerciseId: 'chest-press', targetSets: 3 },
      { exerciseId: 'fly', targetSets: 3 },
      { exerciseId: 'dips', targetSets: 3 },
      { exerciseId: 'shoulder-press', targetSets: 3 },
      { exerciseId: 'lateral-cable-raise', targetSets: 3 },
    ] },
    { id: 'pull', name: 'Pull', kind: 'strength', items: [
      { exerciseId: 'pull-up', targetSets: 3 },
      { exerciseId: 'lat-pulldown', targetSets: 3 },
      { exerciseId: 'seated-row', targetSets: 3 },
      { exerciseId: 'face-pull', targetSets: 3 },
      { exerciseId: 'reverse-crunch', targetSets: 3 },
      { exerciseId: 'dumbbell-curl', targetSets: 3 },
    ] },
    { id: 'cardio', name: 'Sadece kardiyo', kind: 'cardio', items: [] },
  ];

  // Kardiyo makineleri ve her birinde sorulan ayarlar (hepsinde ayrıca süre, mesafe, kalori var).
  // Ayarlar kayıtta cardio.settings içinde: { speed, incline, level, setting }. Üst sınır yok.
  const CARDIO_FIELDS = {
    // start: alan boşken −/+ ilk dokunuşta gelinen başlangıç değeri
    speed: { label: 'Hız', unit: 'km/s', step: 0.5, decimal: true, start: 6 },
    incline: { label: 'Eğim', unit: '%', step: 0.5, decimal: true, start: 1 },
    level: { label: 'Seviye', unit: '', step: 1, decimal: false, start: 5 },
    setting: { label: 'Ayar', unit: '', step: 1, decimal: true, start: 1 },
  };

  // İlk kurulumda seçilen hazır programlar (v19). Her program kendi günlerini (güç şablonları) ekler;
  // "Sadece kardiyo" her kullanıcıda vardır. Hareketler EXERCISES katalogundan, 3'er set.
  const T = (id, name, ids) => ({ id, name, kind: 'strength', items: ids.map((exerciseId) => ({ exerciseId, targetSets: 3 })) });
  const DAY_PUSH = ['chest-press', 'fly', 'dips', 'shoulder-press', 'lateral-cable-raise'];
  const DAY_PULL = ['pull-up', 'lat-pulldown', 'seated-row', 'face-pull', 'reverse-crunch', 'dumbbell-curl'];
  const DAY_LEGS = ['leg-press', 'romanian-deadlift', 'leg-extension', 'leg-curl', 'calf-raise', 'plank'];
  const PROGRAMS = [
    { id: 'push-pull', name: 'Push / Pull', desc: '2 gün: itme (göğüs, omuz, arka kol) ve çekme (sırt, ön kol)',
      templates: [T('push', 'Push', DAY_PUSH), T('pull', 'Pull', DAY_PULL)] },
    { id: 'ppl', name: 'Push / Pull / Legs', desc: '3 gün: itme, çekme ve bacak',
      templates: [T('push', 'Push', DAY_PUSH), T('pull', 'Pull', DAY_PULL), T('legs', 'Legs', DAY_LEGS)] },
    { id: 'upper-lower', name: 'Üst / Alt vücut', desc: '2 gün: üst vücut ve bacak',
      templates: [
        T('upper', 'Üst vücut', ['chest-press', 'lat-pulldown', 'shoulder-press', 'seated-row', 'lateral-cable-raise', 'dumbbell-curl']),
        T('lower', 'Alt vücut', ['leg-press', 'romanian-deadlift', 'leg-curl', 'leg-extension', 'calf-raise', 'plank'])] },
    { id: 'full-body', name: 'Tüm vücut', desc: '1 gün: her antrenmanda tüm vücut, haftada 2–3 kez',
      templates: [T('full', 'Tüm vücut', ['leg-press', 'chest-press', 'lat-pulldown', 'shoulder-press', 'seated-row', 'leg-curl', 'plank'])] },
    { id: 'custom', name: 'Kendim oluşturacağım', desc: 'Boş başla; günlerini ve hareketlerini Ayarlar\'dan ekle', templates: [] },
  ];

  const CARDIO_TYPES = [
    { id: 'treadmill', name: 'Koşu bandı', fields: ['speed', 'incline'] },
    { id: 'bike', name: 'Bisiklet', fields: ['level'] },
    { id: 'elliptical', name: 'Eliptik', fields: ['level', 'speed'] },
    { id: 'rower', name: 'Kürek', fields: ['level'] },
    { id: 'stairs', name: 'Merdiven', fields: ['level'] },
    { id: 'walk', name: 'Yürüyüş', fields: ['speed'] },
    { id: 'other', name: 'Diğer', fields: ['setting'] },
  ];

  // 1 Kasım 2026 Push antrenmanı (kullanıcının ilk kaydı). Dips 2. set bilinmiyor.
  // v19'dan beri yeni kullanıcılara yüklenmez; yalnızca testlerde (Store.initialState({ withSeed: true })).
  function seedWorkouts() {
    const start = new Date(2026, 10, 1, 18, 0, 0); // ay 0'dan başlar: 10 = Kasım
    const end = new Date(2026, 10, 1, 19, 15, 0);
    const s = (weight, reps) => ({ weight, reps });
    const data = [
      ['chest-press', [s(32.5, 10), s(35, 8), s(37.5, 6)]],
      ['fly', [s(47, 7), s(54, 7), s(61, 7)]],
      ['dips', [s(0, 10), s(0, 7)]],
      ['shoulder-press', [s(20, 8), s(22.5, 7), s(25, 7)]],
      ['lateral-cable-raise', [s(6.25, 7), s(8.75, 5), s(8.75, 7)]],
    ];
    let n = 0;
    return [{
      id: 'seed-2026-11-01-push',
      templateId: 'push',
      name: 'Push',
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      sessionRpe: null,
      notes: 'İlk kayıt (elle girildi). Dips 2. set bilinmiyor.',
      exercises: data.map(([exerciseId, sets]) => ({
        exerciseId,
        sets: sets.map((x) => ({
          id: 'seed-set-' + (++n),
          weight: x.weight,
          reps: x.reps,
          isWarmup: false,
          isFailure: null,
          rir: null,
          completedAt: start.toISOString(),
        })),
      })),
      cardio: [],
    }];
  }

  // Sürüm notları (v21): yeni sürüm gelince açılışta bir kez gösterilir (settings.lastSeenVersion).
  // Kullanıcıya dönük, kısa; en yeni üstte. Yeni sürümde buraya bir satır ekle.
  const CHANGELOG = [
    { v: 24, items: ['Ana ekrana ekleme adımlarına "bu sayfayı kapat, simgeden aç" eklendi; Android açıklaması netleşti.', 'Kayıtların telefonda kalıcı tutulması için depolama izni isteniyor.'] },
    { v: 23, items: ['İlk kurulumda ana ekrana ekleme artık ayrı bir adım; başlangıç ekranında kısa özeti var.'] },
    { v: 22, items: ['Ana ekrana ekleme rehberinde "Neden önemli?": iPhone\'da Safari\'de kayıtların silinebilmesi ve ana ekran uygulamasına taşınmaması.'] },
    { v: 21, items: ['Yeni sürüm gelince açılışta bu "Neler yeni" notu çıkıyor.', 'İlk açılışta ve Ayarlar\'da telefonda ana ekrana ekleme rehberi.'] },
    { v: 20, items: ['Ayarlar → Baştan başla: tüm verileri sıfırlama (önce yedek alma seçeneğiyle).'] },
    { v: 19, items: ['Yeni kullanıcılar için ilk kurulum: program seçimi (Push/Pull, PPL, Üst/Alt, Tüm vücut) ve profil.', 'Kataloğa bacak hareketleri ve plank eklendi.'] },
    { v: 18, items: ['Geçmiş listesinde kalorisi girilmemiş kardiyo belirtiliyor.', 'Düzenlemeden çıkarken sade pencere: Düzenle / Değişiklikleri sil.'] },
    { v: 17, items: ['Kalori: kardiyo tahmini, ağırlık antrenmanı kalorisi, Özet\'te günlük kalori grafiği ve hedef.', 'Geçmiş salt okunur; değişiklikler "Antrenmanı düzenle" ile ve onaylı.', 'Süreli hareketlerde her set geçen seferin aynı setine +5 sn.'] },
    { v: 16, items: ['Süreli hareketler (plank) ve kronometre.', 'Makineye özel kardiyo ayarları (hız, eğim, seviye), kalori ve toplamlar.', 'Bitmiş antrenmanı düzenleme.'] },
  ];

  return { EXERCISES, TEMPLATES, PROGRAMS, CARDIO_TYPES, CARDIO_FIELDS, CHANGELOG, seedWorkouts };
});
