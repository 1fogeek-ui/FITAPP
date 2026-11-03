# Tempo · Chrono musculation

Application web pour suivre vos séances de musculation : temps de présence, temps d’exercice, repos de 1 min 30, séries avec poids et répétitions, historique et comparaison avec la séance précédente.

Tout tient dans un seul fichier, `index.html` : pas de build, pas de dépendance. La synchronisation entre appareils est facultative et passe par Supabase.

## Fonctions

- **Chrono de séance** : présence globale qui ne s’arrête jamais, compteurs d’exercice et de repos indépendants, repos à la demande (1 min 30, relançable d’un appui).
- **Profils** : chaque profil a ses exercices créés, ses photos, ses séances et son historique.
- **Base d’exercices** par catégorie, avec création d’exercices et de catégories.
- **Séances enregistrées** : un nom + un ensemble d’exercices, lancées d’un appui.
- **Séries détaillées** : poids et répétitions par série, valeurs reprises de la dernière séance.
- **Progrès** : comparaison série par série avec la séance précédente, courbes par exercice.
- **Connexion par prénom** : on entre son prénom (et un code facultatif), les données suivent sur tous les appareils.
- **Sauvegarde** : export et import JSON depuis l’onglet Profil.

## Utilisation

En local : ouvrez `index.html` dans votre navigateur. Sans connexion (« Utiliser sans compte »), les données restent dans le navigateur de l’appareil.

### Publier avec GitHub Pages

1. Dépôt GitHub → **Settings** → **Pages**.
2. *Source* : **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. L’adresse sera `https://<votre-compte>.github.io/<nom-du-dépôt>/`.

## Connexion par prénom et synchronisation (Supabase)

Pas d’e-mail ni de mot de passe : le prénom (sans tenir compte des majuscules, espaces et accents), suivi d’un **code facultatif**, est transformé en une clé secrète (SHA-256) calculée dans le navigateur. Cette clé identifie vos données. Les tables ne sont pas accessibles directement : seules 8 fonctions SQL le sont, et chacune ne touche qu’aux lignes de la clé fournie.

Installation :

1. Créez un projet sur [supabase.com](https://supabase.com).
2. Dans **SQL Editor**, exécutez le contenu de `supabase-schema.sql` (il remplace tout schéma Tempo précédent).
3. Dans `index.html`, repérez la constante `SB` et indiquez l’adresse du projet et la clé **publishable** (`sb_publishable_…`). Cette clé est faite pour être visible dans une page web. **Ne mettez jamais la clé `secret` ou `service_role` dans ce fichier.**
4. Ouvrez l’appli, entrez votre prénom (et un code si vous le souhaitez).

### Ce que cela protège, et ce que cela ne protège pas

- Sans code, **quiconque connaît l’adresse de l’appli et votre prénom** peut ouvrir et modifier vos données. Avec un code, il faut en plus le connaître : plus le code est long et personnel, plus c’est sûr.
- Les données (séances de sport) sont peu sensibles, mais ne mettez rien de confidentiel dans les noms d’exercices ou de profils.
- Le code n’est pas récupérable : si vous l’oubliez, les données restent mais deviennent inaccessibles. Un prénom ou un code différent ouvre un espace vide.
- Chaque compte est limité en taille (profils, photos). Comme la clé de l’API est publique, un inconnu pourrait en théorie créer des données parasites : pour un usage familial, c’est un risque accepté. Si besoin, on peut ajouter une liste de prénoms autorisés.

### Fonctionnement

La synchronisation se fait par profil, quelques secondes après chaque modification, à l’ouverture de l’appli et au retour du réseau. En plus, une **actualisation invisible** vérifie toutes les 45 secondes (écran visible) si un autre appareil a modifié vos données : elle ne demande qu’un état très léger au serveur et ne lance une vraie synchronisation que si quelque chose a changé. Elle n’affiche rien et ne perturbe pas l’usage en cours : si vous saisissez du texte, êtes en séance ou avez une fenêtre ouverte, les données sont mises à jour mais l’écran n’est rafraîchi qu’ensuite. Si un même profil est modifié sur deux appareils hors ligne, les séances, exercices créés et séances enregistrées des deux côtés sont fusionnés sans perte ; une suppression faite sur un appareil est propagée aux autres. « Se déconnecter » efface la copie locale (les données restent dans le compte) pour qu’une autre personne puisse se connecter sur le même appareil.

## Données

- Une copie locale reste dans le navigateur (`localStorage`) : le chrono fonctionne sans réseau.
- Connecté, les profils, exercices créés, séances, historique et photos sont aussi enregistrés dans votre projet Supabase.
- **Profil → Exporter mes données** permet de garder une sauvegarde indépendante.

## Photos des exercices

Ce dépôt ne contient pas de photos par défaut. Ajoutez les vôtres depuis l’appli : onglet **Exercices** → touchez un exercice → **Ajouter une photo**. Elles sont synchronisées avec votre compte.

## Licence

À définir par l’auteur.
