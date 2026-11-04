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

  const CARDIO_TYPES = [
    { id: 'treadmill', name: 'Koşu bandı' },
    { id: 'bike', name: 'Bisiklet' },
    { id: 'elliptical', name: 'Eliptik' },
    { id: 'rower', name: 'Kürek' },
    { id: 'stairs', name: 'Merdiven' },
    { id: 'walk', name: 'Yürüyüş' },
    { id: 'other', name: 'Diğer' },
  ];

  // 1 Kasım 2026 Push antrenmanı (kullanıcının ilk kaydı). Dips 2. set bilinmiyor.
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

  return { EXERCISES, TEMPLATES, CARDIO_TYPES, seedWorkouts };
});
