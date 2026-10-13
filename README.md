# Lecteur multipistes (PWA)

Application web installable : lecture synchronisée de pistes Opus depuis Google Drive, boucles par section, cache hors ligne, thèmes sombre / clair / contraste élevé.
Avec les métadonnées du morceau : accords (pop, jazz, Nashville), paroles surlignées mot à mot, carte de structure, mesure et temps, calage des sauts sur la grille.

## Publier sur GitHub Pages
1. Créez un dépôt GitHub (public) et déposez **tout le contenu de ce dossier** à la racine du dépôt (le plus gros fichier fait 10 Mo, sous la limite de 25 Mo de l'envoi par navigateur).
2. Dépôt > Settings > Pages > « Deploy from a branch » > branche `main`, dossier `/ (root)` > Save.
3. L'adresse sera `https://VOTRE_NOM.github.io/NOM_DU_DEPOT/`.
4. **Clé API Google** : dans « Restrictions relatives aux applications > Sites Web », ajoutez `https://VOTRE_NOM.github.io/*`
   (le navigateur n'envoie que le domaine aux autres sites : une restriction avec le chemin du dépôt risque de bloquer les requêtes).
   Gardez la restriction aux API sur « Google Drive API ».

## Installer
- Android (Chrome) : menu ⋮ > « Installer l'application ».
- iPhone (Safari) : Partager > « Sur l'écran d'accueil ». L'application installée conserve mieux le cache audio.

## Publier une nouvelle version
1. Modifiez le code (ou les fichiers de l'application).
2. Changez le numéro dans **`version.js`** (ex. `1.0.0` -> `1.0.1`). C'est le seul endroit.
3. Si vous avez ajouté un fichier à l'application, ajoutez-le aussi à la liste `SHELL` de `sw.js`.
4. Envoyez sur GitHub. Chez l'utilisateur, une bannière « Une nouvelle version est disponible » apparaît ; la mise à jour se fait quand il clique (pas de coupure en pleine lecture). Réglages > « Vérifier les mises à jour » force la recherche.

## Thèmes
Chaque thème est un objet de variables CSS dans `themes.js` ; aucune couleur n'est écrite en dur dans `styles.css`.
Pour en ajouter un, ajoutez une entrée dans `THEMES` (ou appelez `Themes.register('id', {...})`) : il apparaît automatiquement dans Réglages.
Exemple :
```js
sepia: { label: 'Sépia', scheme: 'light', color: '#f4ecd8', vars: {
  bg: '#f4ecd8', surface: '#fbf6e9', 'surface-2': '#eadfc6', text: '#2b2118', muted: '#5a4a3a', border: '#7a6650',
  accent: '#8a3b12', 'on-accent': '#ffffff', danger: '#a4161a', ok: '#2d6a2d', focus: '#0b5cad', bw: '1px', 'focus-w': '3px' } }
```
Le mode « Automatique » suit le système (sombre, clair, et contraste élevé si le système demande un contraste renforcé).

## Utilisation avec les métadonnées
- **Accords** : accord courant et suivant (avec le nombre de temps avant le changement). Réglages : notation Pop / Jazz / Nashville et niveau Basique / Simple / Complexe.
- **Paroles** : ligne active et mots chantés surlignés ; toucher une ligne saute au début de cette ligne. Source : `lyrics_new_format.json`, sinon `paroles.lrc`.
- **Structure** : carte proportionnelle des sections ; toucher une section la **sélectionne** (cadre épais) et s'y place ; retoucher la même carte la désélectionne. La case **« Boucler la section sélectionnée »** (sous le curseur, cochée par défaut) fait tourner en boucle uniquement cette section ; décochée, la lecture continue normalement. Cocher la case sans rien sélectionner prend la section en cours. La boucle manuelle A-B (dans « Boucle et calage ») reste disponible quand aucune section n'est sélectionnée. « Regrouper les sections identiques » fusionne les tronçons consécutifs de même nom (Chorus, Chorus, Chorus devient Chorus 1) et numérote les répétitions.
- **Calage** (Boucle et calage) : les sauts du curseur se calent sur le temps le plus proche, sur la mesure, ou restent libres. « A ici » / « B ici » règlent la boucle à la position courante (calée de la même façon). ⏮ ⏭ : mesure précédente / suivante.
- **Volume général** : curseur à côté des boutons de lecture (⏮ ▶ ⏭), mémorisé ; il agit sur toutes les pistes ensemble, en plus du volume de chaque piste (courbe quadratique pour un réglage plus fin aux faibles niveaux).
- **Clavier** : Espace lecture/pause, flèches gauche/droite mesure précédente/suivante.
- Chaque fonctionnalité se masque seule si le fichier correspondant est absent ou illisible.

## Interface (version 1.8.2)
Barre d'onglets en bas : **Mixeur** (accords, structure condensée, pistes avec icône — appui court muet, appui long solo —, ⏪ ▶ ⏩, boutons Vitesse / Tonalité / Boucle), **Structure** (cartes étalées avec accords et curseur), **Paroles**, **Guitare** (à venir), **Menu** (morceaux, réglages, mode gaucher, écran allumé, boutons Solo). Vitesse en BPM avec règle à faire glisser ; boucle réglée par les cartes de structure ; ±10 s calé sur la mesure, appui long = section. Détails dans `compte-rendu-lecteur-multipistes.md`.

## Vitesse et transposition
- **Vitesse** de 50 à 150 % **sans changer la hauteur**, et **transposition** de −12 à +12 demi-tons (boutons −1 ton, −½, +½, +1 ton), dans les volets **Vitesse** et **Tonalité** du Mixeur. La vitesse est mémorisée ; la transposition revient à 0 à chaque morceau.
- Les **accords** et la **tonalité** affichés suivent la transposition (Do majeur + 1 ton : C devient D, tonalité Ré majeur). Bémols ou dièses selon la tonalité d'arrivée. La notation Nashville ne change pas.
- À 100 % et 0 demi-ton, la lecture est exactement l'ancienne. Sinon, l'étirement est calculé dans des Workers (Signalsmith Stretch, WebAssembly, licence MIT) ; les pistes muettes ne sont pas calculées. Si le téléphone peine, l'indicateur « Calcul » dépasse 85 % : choisir la qualité « Économique » (Réglages) ou une vitesse plus proche de 100 %.

## Convertisseur M4A -> Opus
Panneau « Convertir des M4A en Opus (outil) » : choisissez **le ZIP du morceau** (ou directement ses `.m4a`), Convertir, puis téléchargez le ZIP de sortie à décompresser dans le dossier du morceau sur Drive.
Le ZIP de sortie contient : les JSON et `paroles.lrc` repris tels quels, `original.opus`, `stems/*.opus`, `encodage.json`, et `_termine` si la case est cochée et que tous les contrôles sont bons (un ancien `_termine` du ZIP d'origine n'est pas repris).
Le nom du morceau est lu dans `infos.json`. Un dossier racine unique dans le ZIP est ignoré ; les entrées dangereuses (`..`) sont refusées.
- **Encodeur figé** : le profil `opus-128-v1` est affiché en clair (libopus 1.4, 128 kbit/s VBR, 48 kHz stéréo, trames de 20 ms, complexité 10, pre-skip 312) avec sa commande ffmpeg de bureau équivalente.
- **Infos de l'encodeur** : le bouton « Télécharger les infos de l'encodeur » produit un JSON (profil, versions, empreintes SHA-256 des composants, consigne pour le faire évoluer).
- **Traçabilité** : chaque fichier Opus porte les étiquettes `ENCODER`, `PROFILE`, `SETTINGS`, `DECODER`, `SOURCE`, `SOURCE_SHA256`. `encodage.json` ajoute les empreintes de sortie, les durées et les contrôles.
- **Contrôles automatiques** : durées identiques, même pre-skip, même profil. Le lecteur signale aussi un mélange d'encodeurs dans un morceau.
- **Reproductible** : mêmes entrées, mêmes composants = fichiers identiques octet pour octet. Un ffmpeg de bureau donne un audio équivalent mais pas des octets identiques : ne pas mélanger.
- **Faire évoluer l'encodeur** : ne jamais modifier le profil existant. Créer un nouveau profil (nouvel `id`, ex. `opus-96-v2`) dans `convert-core.js`, mettre à jour `vendor/VERSIONS.json` si des composants changent, reconvertir le morceau entier.
- Les composants WebAssembly (~10 Mo) ne sont pas dans l'installation de base : ils sont téléchargés à la première utilisation, puis conservés hors ligne dans un cache à part (`lecteur-tools-<TOOLS_VERSION>`). Changez `TOOLS_VERSION` dans `version.js` uniquement si les fichiers de `vendor/ffmpeg` ou `vendor/opus` changent.
- `vendor/ffmpeg/ffmpeg-core.wasm.gz` est le noyau FFmpeg compressé (`gzip -9 -n`, 10 Mo au lieu de 32) : **GitHub refuse l'envoi par navigateur d'un fichier de plus de 25 Mo**. Le worker le décompresse et vérifie son SHA-256 avant de l'utiliser. Pour le régénérer : `gzip -9 -n -c ffmpeg-core.wasm > ffmpeg-core.wasm.gz`, puis mettre à jour l'empreinte dans `convert-worker.js` et `vendor/VERSIONS.json`.
- Licences : voir `LICENSES.md` (FFmpeg est sous GPL-2.0 ou ultérieure).

## Dossiers Drive attendus
`racine/<Artiste - Titre>/` contenant les `.json`, `paroles.lrc`, `original.opus`, un fichier `_termine`, et un sous-dossier `stems/` avec les `.opus` (même commande d'encodage pour tous).

## Fichiers
`index.html`, `styles.css`, `themes.js`, `app.js` (interface + lecteur), `ogg-opus.js` (index Ogg Opus), `drive.js` (Drive + cache IndexedDB), `meta.js` (grille de temps, accords, paroles, sections, transposition des accords), `stretch.js` + `stretch-core.js` + `stretch-worker.js` + `vendor/signalsmith/` (vitesse et transposition),
`vendor/opus-decoder.min.js` (décodeur Opus WASM, embarqué pour le hors ligne), `converter.js` + `converter-lib.js` + `convert-core.js` + `opus-pack.js` + `convert-worker.js` + `vendor/ffmpeg` + `vendor/opus` (convertisseur), `LICENSES.md`, `sw.js`, `version.js`, `manifest.webmanifest`, `icons/`.
