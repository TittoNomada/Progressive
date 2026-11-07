# Progressive

Ağırlık antrenmanında **progressive overload** ve kardiyo takibi için sade bir web uygulaması (PWA). Sunucu veya hesap gerektirmez; veriler cihazda saklanır.

**Uygulama:** https://tittonomada.github.io/Progressive/

## Neler yapıyor

- **Hızlı kayıt:** her set 1–3 dokunuş; geçen seferki değerler ve bugünkü 🎯 hedef hazır gelir (çift ilerleme; üst set ya da piramit düzeni).
- **İlerleme:** kişisel rekorlar 🏆, hareket hareket grafik, haftalık / aylık özet.
- **Süreli hareketler** (plank vb.) için kronometre.
- **Kardiyo:** makineye özel ayarlar (hız, eğim, seviye), mesafe, kalori; girilmeyen kalori geçmişe göre tahmin edilir.
- **Kalori:** ağırlık antrenmanının tahmini kalorisi + kardiyo; Özet'te günlük grafik ve haftalık hedef.
- **Geçmiş:** salt okunur; "Antrenmanı düzenle" ile onaylı değişiklik.
- **İlk kurulum:** program seçimi (Push/Pull, PPL, Üst/Alt, Tüm vücut ya da kendin), ana ekrana ekleme rehberi.

## Telefona kurmak

- **iPhone:** Safari'de aç → ••• → Paylaş → **Ana Ekrana Ekle** → "Web Uygulaması Olarak Aç" açık → Ekle. Sonra uygulamayı ana ekrandaki simgeden aç.
  Safari sekmesinde kullanma: Safari ~7 gün açılmayan sitelerin kayıtlarını silebilir ve Safari'deki kayıtlar ana ekran uygulamasına geçmez.
- **Android:** Chrome'da aç → ⋮ → **Ana ekrana ekle**.

Uygulama açılışta ve Ayarlar'da aynı rehberi gösterir.

## Verilerin güvenliği

- Veriler yalnızca bu cihazdaki tarayıcı depolamasında durur (bulut yok, henüz).
- **Ana ekrandaki simgeyi silersen veriler de silinir.**
- Ayarlar → **Yedek al** ile ara ara yedek al (iPhone'da iCloud Drive'a kaydet). 7 gün yedek alınmazsa uygulama hatırlatır.
- Yeni cihazda: ilk açılışta "Yedeğim var, geri yükle" ya da Ayarlar → **Yedekten geri yükle**.

## Mac'te denemek

`index.html` dosyasına çift tıkla (çevrimdışı mod hariç her şey çalışır). Tam PWA davranışı için klasörde:

```
python3 -m http.server 8000
```

sonra `http://localhost:8000`. Örnek veri: Ayarlar → Yedekten geri yükle → `deneme/` klasöründeki dosyalar.

## Testler

```
node --test                 # hesaplamalar (birim testler)
python3 tests/e2e.py        # tarayıcıda uçtan uca (isteğe bağlı; Playwright gerekir)
```

## Yeni sürüm yayınlamak

Uygulama dosyası değişince sürümü **üç yerde** artır: `js/app.js` `APP_VERSION`, `index.html` içindeki tüm `?v=`, `sw.js` `VERSION`. `js/seed.js` `CHANGELOG`'a kısa not ekle; kullanıcılar açılışta "Neler yeni" olarak görür. Ayrıntılı kurallar: `CLAUDE.md`.

## Dosya yapısı

```
index.html            Giriş sayfası
css/styles.css        Görünüm
js/seed.js            Hareket katalogu, programlar, kardiyo makineleri, sürüm notları
js/storage.js         Veri saklama, şema yükseltme, yedek dışa/içe aktarma
js/logic.js           Hesaplamalar (hedef, rekor, özet, kalori, değişiklik listesi…)
js/app.js             Arayüz
sw.js                 Çevrimdışı çalışma
manifest.webmanifest  Ana ekran uygulaması ayarları
docs/                 Ürün brifi ve vizyon
deneme/               Test için örnek yedekler
tests/                Birim testler ve tarayıcı testi
```
