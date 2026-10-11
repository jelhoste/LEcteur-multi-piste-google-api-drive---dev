# Composants tiers embarqués

| Composant | Fichiers | Licence | Source |
|---|---|---|---|
| @ffmpeg/core 0.12.10 (FFmpeg 5.1.4 compilé en WebAssembly) | `vendor/ffmpeg/` (le .wasm est fourni compressé en `.wasm.gz`) | **GPL-2.0 ou ultérieure** | https://github.com/ffmpegwasm/ffmpeg.wasm (paquet npm `@ffmpeg/core`) ; code FFmpeg : https://ffmpeg.org/download.html |
| opusscript 0.1.1 (libopus 1.4 compilé en WebAssembly) | `vendor/opus/` | MIT (opusscript) ; BSD-3 (libopus, voir `COPYING.libopus`) | https://github.com/abalabahaha/opusscript ; https://opus-codec.org |
| Signalsmith Stretch 1.3.2 (étirement temporel et transposition, WebAssembly) | `vendor/signalsmith/` (partie WebAssembly du paquet npm `signalsmith-stretch`) | **MIT** (Geraint Luff / Signalsmith Audio) | https://github.com/Signalsmith-Audio/signalsmith-stretch ; https://www.npmjs.com/package/signalsmith-stretch |
| opus-decoder 0.7.11 | `vendor/opus-decoder.min.js` | MIT | https://github.com/eshaz/wasm-audio-decoders |

Si vous publiez cette application, le composant FFmpeg est distribué sous GPL : conservez ce fichier et les liens vers les sources
(ou retirez `vendor/ffmpeg/` ainsi que le convertisseur, le lecteur n'en a pas besoin). Les empreintes SHA-256 exactes sont dans `vendor/VERSIONS.json`.
