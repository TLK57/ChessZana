# Comparaison avec l'analyse serveur de Lichess (3 parties réelles)

Parties publiques du compte Lichess « thibault », analysées par les serveurs de Lichess (annotations ?!, ?, ??), puis par l'application (passe rapide puis passe profonde : 1 500 000 positions par coup).

Sur 142 demi-coups : **123 classés pareil** (87 %), 10 annotés seulement par Lichess, 2 seulement par l'application, 7 annotés par les deux mais à un niveau différent.

**Causes des écarts** : Même perte des deux côtés (9) ; Théorie (4) ; Évaluations différentes des deux moteurs (3) ; Catégorie « occasion manquée » de l'application (2) ; Règle de mat de Lichess (1).

Rappel des seuils : Lichess annote dès 5 % de chances de gain perdues (?!), 10 % (?) et 15 % (??) ; l'application, comme chess.com, à partir de 6 % (imprécision), 12 % (erreur) et 22 % (gaffe). L'application a aussi « occasion manquée », compté ici comme erreur ou gaffe selon la perte.

## alhamaoee (1960) – thibault (1836), rapid, https://lichess.org/ZlkPN7gH

56 demi-coups, analysés en 2 min 07 s (passes rapide + profonde). 2 écarts :

| Coup | Lichess | Application | Perte Lichess | Perte application | Meilleur coup (app / Lichess) | Cause de l'écart |
|---|---|---|---|---|---|---|
| 18… Rab8 | Gaffe | Erreur | 16.7 % | 15.1 % | d4 / d4 | Même perte des deux côtés (≈ 15 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 19. Ba3 | Imprécision | Bon | 5.8 % | 5.0 % | Bd6 / Bd6 | Même perte des deux côtés (≈ 5 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |

## thibault (1750) – SergeyB123 (1838), blitz, https://lichess.org/0IdR4QNI

46 demi-coups, analysés en 2 min 09 s (passes rapide + profonde). 13 écarts :

| Coup | Lichess | Application | Perte Lichess | Perte application | Meilleur coup (app / Lichess) | Cause de l'écart |
|---|---|---|---|---|---|---|
| 2. f4 | Imprécision | Théorie | 5.1 % | 7.9 % | Nf3 / Nf3 | Théorie : l'application n'annote pas les coups de la base d'ouvertures (comme chess.com) ; Lichess si. |
| 4. Bc4 | Imprécision | Théorie | 8.9 % | 10.7 % | h4 / h4 | Théorie : l'application n'annote pas les coups de la base d'ouvertures (comme chess.com) ; Lichess si. |
| 4… Bg7 | Imprécision | Théorie | 6.8 % | 1.4 % | g4 / g4 | Théorie : l'application n'annote pas les coups de la base d'ouvertures (comme chess.com) ; Lichess si. |
| 5. O-O | Erreur | Théorie | 10.2 % | 10.6 % | h4 / h4 | Théorie : l'application n'annote pas les coups de la base d'ouvertures (comme chess.com) ; Lichess si. |
| 5… h6 | Imprécision | Excellent | 5.3 % | 0.4 % | Nc6 / d6 | Évaluations différentes des deux moteurs (perte 5.3 % pour Lichess, 0.4 % pour l'application). |
| 10. h4 | Erreur | Imprécision | 13.4 % | 11.4 % | d5 / d5 | Même perte des deux côtés (≈ 11 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 13. Rxd1 | Imprécision | Bon | 5.2 % | 5.3 % | Nxd1 / Nxd1 | Même perte des deux côtés (≈ 5 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 14. Ne4 | Erreur | Imprécision | 10.5 % | 11.8 % | Rf1 / Re1 | Même perte des deux côtés (≈ 12 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 15. Bb5+ | Imprécision | Bon | 5.8 % | 4.6 % | Bxe6 / Bxe6 | Même perte des deux côtés (≈ 5 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 16… Rd8 | Gaffe | Erreur | 18.2 % | 16.3 % | Bd5 / h5 | Même perte des deux côtés (≈ 16 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 17. Re1 | Gaffe | Occasion manquée | 20.1 % | 19.8 % | Bxf4 / Bxf4 | Catégorie « occasion manquée » de l'application (absente de Lichess) : l'adversaire venait de faire une erreur. |
| 18… Nf5 | Imprécision | Bon | 5.2 % | 4.9 % | h5 / h5 | Même perte des deux côtés (≈ 5 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |
| 22. Rxe5 | Gaffe | Imprécision | 9.3 % | 8.9 % | Ne4 / Ne4 | Règle de mat de Lichess (le mat devient inévitable) : annoté gaffe quelle que soit la perte. |

## subziiro98 (1805) – thibault (1811), rapid, https://lichess.org/aDN8u0zd

40 demi-coups, analysés en 2 min 15 s (passes rapide + profonde). 4 écarts :

| Coup | Lichess | Application | Perte Lichess | Perte application | Meilleur coup (app / Lichess) | Cause de l'écart |
|---|---|---|---|---|---|---|
| 5. O-O | Gaffe | Occasion manquée | 15.9 % | 14.0 % | Bxf7+ / Bxf7+ | Catégorie « occasion manquée » de l'application (absente de Lichess) : l'adversaire venait de faire une erreur. |
| 7. Rxf3 | — | Imprécision | 1.8 % | 6.8 % | gxf3 / — | Évaluations différentes des deux moteurs (perte 1.8 % pour Lichess, 6.8 % pour l'application). |
| 9. Bf1 | — | Imprécision | 2.0 % | 6.3 % | Be2 / — | Évaluations différentes des deux moteurs (perte 2.0 % pour Lichess, 6.3 % pour l'application). |
| 17. Bc4+ | Imprécision | Bon | 5.1 % | 5.9 % | Qf2 / Qf2 | Même perte des deux côtés (≈ 6 %) : seuils différents (Lichess 5 / 10 / 15 %, application 6 / 12 / 22 %). |

---
Remarque : Stockfish utilise plusieurs cœurs, son analyse varie donc légèrement d'une fois à l'autre ; relancer la comparaison peut faire bouger un ou deux coups.
