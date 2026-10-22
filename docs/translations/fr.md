# Français (`fr`)

Catalogue : `src/i18n/locales/fr.json`. Règles générales : [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Français neutre, compréhensible en France, en Afrique francophone (Burkina Faso, Côte d'Ivoire, Sénégal…), au Canada et en Belgique ; pas de régionalisme.
- Instructions à l'impératif, forme de politesse « vous » : « Activez », « Choisissez », « Collez », « Réessayez ». Les infobulles d'action peuvent utiliser l'infinitif : « Développer le panneau », « Réinitialiser la caméra ».
- Casse de phrase, pas de Title Case : « Live Flights » → « Vols en direct ». Le TEXTE EN MAJUSCULES reste en majuscules : « EN DIRECT », « AUCUNE DONNÉE ».
- Espaces avant `:`, `;`, `!`, `?` et `%` : « 50 % », « Erreur : {message} ». Les guillemets sont « français ».
- Libellés courts, pastilles et affichages HUD restent courts : PRÉC., SUIV., VIT., DIST., SYNC., RECH.
- Les codes HUD HDG/BRG/CRS/FOV/DEST/SPD/ALT sont traduits seulement quand ils servent de mot dans une phrase : cap, portée, vitesse sol (VS), vitesse verticale (VV).
- Les touches restent en anglais ou à leur nom français usuel : Espace, Échap, Entrée, Tab, Maj.
- Unités : km, m, km/h, m/s, kt (nœuds), ft (pieds), h, min, s ; en majuscules KM, KT, FT, MIN. « m » est toujours le mètre : les minutes s'écrivent « min » (« il y a 5 min »). `°` reste collé au nombre.
- « Il y a » précède la durée : « il y a {count} min ». Quand un paramètre contient déjà un texte localisé (`{age}`, `{ago}`), ne pas ajouter « il y a ».
- Devises : « {amount} k$ », « {amount} M$ », « {amount} Md$ ».

## Pluriels

Une entrée `tn()` demande trois formes. `Intl.PluralRules('fr')` choisit :

| Forme   | Nombres                                          | Exemple              |
| ------- | ------------------------------------------------ | -------------------- |
| `one`   | 0 et 1 (et 1,5)                                  | 1 caméra             |
| `many`  | 1 000 000, 2 000 000… (millions exacts)          | 1 000 000 de caméras |
| `other` | tout le reste : 2 à 999 999…                     | 3 caméras            |

La forme `many` est la forme `other` avec « de » (ou « d' ») après le nombre : « {count} de caméras chargées », « {count} d'aéronefs ».

## Glossaire

| Anglais                                | Français                                     |
| -------------------------------------- | -------------------------------------------- |
| layer / data layer                     | couche / couche de données                   |
| feed / source / data source            | flux / source / source de données            |
| LIVE (statut) / live data              | EN DIRECT / données en direct                |
| SIMULATED                              | SIMULÉ                                       |
| stale / degraded / unavailable         | obsolète / dégradé / indisponible            |
| retry / retrying                       | nouvel essai / nouvel essai en cours         |
| key (API key) / POWER UP / POWERED UP  | clé / ACTIVER / ACTIVÉ                       |
| shot / scene                           | plan / scène                                 |
| cockpit                                | cockpit                                      |
| street level                           | niveau de la rue                             |
| coverage                               | couverture                                   |
| heading / pitch / range                | cap / tangage / portée                       |
| vessel / aircraft / satellite          | navire / aéronef / satellite                 |
| wildfire / perimeter / contained       | feu / périmètre / maîtrisé                   |
| rain radar / lightning density         | radar de pluie / densité de foudre           |
| bike share                             | vélos en libre-service                       |
