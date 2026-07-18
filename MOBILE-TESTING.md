# Mobile-Test-Checkliste

Von oben nach unten abarbeiten. `📱` = nur auf echtem Gerät testbar (kein Desktop).

## 1. Vorbereitung (am Laptop)

- [x] `npm run dev` läuft
- [x] `npm run tunnel` läuft, QR-Code sichtbar
- [x] Test-Event angelegt (Gast-QR + Host-Link zur Hand)
- [x] Handy auf **Mobilfunk**, nicht WLAN

## 2. Eintritt des Gasts

- [x] QR scannen → Seite lädt
- [x] Einwilligungs-Hinweis erscheint zuerst
- [x] Zustimmen → Kamera öffnet sich
- [x] Link erneut öffnen → direkt zur Kamera (kein zweites Consent)

## 3. 📱 Foto — Grundlagen

- [x] Live-Vorschau sichtbar, kein Vollbild-Kaper
- [x] 1 Foto → Vorschau → „Keep" → zurück zur Kamera
- [x] **3–4 Fotos hintereinander** — Kamera bleibt am Leben (Reattach-Bug!)
- [x] Foto verwerfen funktioniert

## 4. 📱 Kamera wechseln

- [x] „Flip" → Frontkamera, Vorschau gespiegelt
- [ ] Gespeichertes Front-Foto ist **nicht** gespiegelt (Text lesbar) #ist gespiegelt
- [x] Zurück auf Rückkamera funktioniert

## 5. 📱 Ausrichtung & Qualität

- [x] Hochformat-Foto kommt aufrecht an
- [x] Querformat-Foto stimmt #bleibt auch quer, soll dann richtung geändert werden
- [x] Fotoqualität am echten Display beurteilen (ggf. hochschrauben)

## 6. 📱 Video

- [x] iPhone: Video → lädt hoch (mp4) #gibt kein replay bevor man es hochladen kann (Auf laptop geht es)
- [ ] Android: Video → lädt hoch (webm) #kein Android, später testen
- [x] 15-Sekunden-Stop greift automatisch
- [x] Mikro ablehnen → Video (stumm) wird trotzdem aufgenommen
- [x] Roter Aufnahme-Indikator + Countdown sichtbar

## 7. 📱 Offline-Verhalten

- [x] Flugmodus an → Foto → „Keep" → „sicher auf deinem Handy"
- [x] Flugmodus aus → lädt automatisch hoch, Zähler stimmt
- [x] „Try now"-Button funktioniert
- [x] iOS Privat-Modus → sauberer Fallback statt Absturz

## 8. Limit & letzter Schuss

- [x] Zähler „X von Y" zählt korrekt runter
- [x] Wartende Offline-Shots werden mitgezählt
- [x] Alle Shots aufbrauchen → „That was your last shot"
- [x] Event voll → „No room left" für neuen Gast

## 9. Host-Seite am Handy

- [x] Galerie lädt, Bilder erscheinen
- [x] Lightbox / Vollbild funktioniert
- [x] Slideshow läuft #gibt kein zurück knopf
- [x] Einstellungen + Unlock funktionieren
- [x] „Download all" (ZIP) funktioniert auf dem Handy #Foto ist als jpg passt. Video ist als webm format, soll lieber als .mp4 abgespeichert werden

## 10. Mehrere Geräte

- [x] 3–4 echte Handys gleichzeitig (iPhone + Android gemischt) #habe nur zwei aber gleichzeitig hochladen hat normal funktioniert
- [ ] Server stabil, keine doppelten/verlorenen Uploads #kann man mit zwei geräten nicht beurteilen
