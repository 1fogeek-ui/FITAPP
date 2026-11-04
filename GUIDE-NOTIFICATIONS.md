# Les notifications du coach pour Hélène : guide pas à pas

**Ce que ça fait.** Hélène reçoit sur son iPhone, chaque jour, des notifications signées « Faissal », avec ton portrait comme icône :

| Quand | Message (la formulation change tous les jours, le sens reste le même) |
|---|---|
| 9h00 | Tes omelettes t'attendent 🍳 |
| entre 15h30 et 16h45 | Fromage blanc ou repas protéiné 🥣 |
| 17h30 (lun, mer, ven) | Séance cuisses & fessiers 🍑 (pas envoyé si elle s'est déjà entraînée) |
| 19h30 (jours de séance) | Dernier rappel, seulement si elle n'a pas encore fait sa séance |
| 12h30 (mar, jeu, sam) | Encouragement du coach |
| 18h00 | Message de reprise, si elle n'a pas fait de séance depuis 4 jours ou plus |
| 20h30 | Le chocolat du soir : oui, avec modération 🍫 |
| dimanche 19h00 | Bilan de la semaine (3/3 : bravo ; sinon : on repart de zéro) |
| 25 secondes après sa séance | Félicitations, avec le nombre de séries et ses records ★ |

Tous les messages l'appellent « ma Puce », avec ton humour. Il y a plus de 60 combinaisons par type de message : elle ne reçoit pas deux fois la même phrase de suite.

Il faut **4 étapes de ton côté** (environ 15 minutes) puis **1 étape sur son téléphone**.

---

## Étape 1 · Créer les tables (Supabase, 1 minute)

1. Ouvre ton projet Supabase → **SQL Editor** → **New query**.
2. Copie tout le contenu du fichier `1-schema-notifications.sql`, colle-le, clique **Run**.
3. Résultat attendu : « Success. No rows returned ». Tu peux le relancer sans risque.

## Étape 2 · Créer la fonction d'envoi (Supabase, 5 minutes)

1. **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Nom de la fonction : **`tempo-push`** (exactement).
3. Efface le code d'exemple, colle tout le contenu du fichier `index.ts`, puis **Deploy**.
4. Dans les réglages de la fonction, **désactive « Verify JWT »** (la fonction est protégée par un secret, pas par une connexion).
   *(Si tu utilises la ligne de commande : `supabase functions deploy tempo-push --no-verify-jwt`.)*
5. **Edge Functions → Secrets** (ou Project Settings → Edge Functions → Secrets) : ajoute
   - `TEMPO_PUSH_SECRET` = une longue suite de lettres et de chiffres de ton choix (par exemple 30 caractères au hasard). **Note-la, tu en as besoin à l'étape 3.**
   - *(facultatif)* `COACH_NAME` = le nom qui s'affiche en haut de la notification. Par défaut : **Faissal**.
   - *(seulement si les logs disent « clé de service introuvable »)* `TEMPO_SERVICE_KEY` = ta clé **secret** (Project Settings → API Keys → Secret keys, elle commence par `sb_secret_`).

## Étape 3 · Lancer le minuteur (Supabase, 2 minutes)

1. Ouvre le fichier `2-minuteur-notifications.sql` et **remplace `REMPLACE_PAR_TON_SECRET`** par le secret de l'étape 2.
2. **SQL Editor** → colle → **Run**. (Ne mets jamais ce fichier dans GitHub : il contient ton secret.)
3. Attends 2 minutes, puis vérifie dans le SQL Editor :
   ```sql
   select name from public.tempo_push_config;                                   -- doit afficher : vapid
   select status, start_time from cron.job_run_details order by start_time desc limit 3;   -- « succeeded »
   ```
   « vapid » = la fonction tourne et a créé les clés d'identification de l'expéditeur toute seule.

## Étape 4 · Mettre à jour le site (GitHub, 3 minutes)

Dans ton dépôt, **Add file → Upload files**, et dépose **tous** ces fichiers à la racine (à côté d'`index.html`) :

`index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `badge-96.png`

Puis **Commit changes** et attends que **Actions** passe au vert. (`sw.js` doit être à la racine, pas dans un dossier.)

---

## Sur le téléphone d'Hélène (iPhone, iOS 16.4 ou plus récent)

1. Dans **Safari** (pas Chrome), elle ouvre `https://1fogeek-ui.github.io/FITAPP/`.
2. Bouton **Partager** (le carré avec la flèche) → **Sur l'écran d'accueil** → **Ajouter**. L'icône sera **ton portrait**. Elle peut renommer l'appli (par exemple « Mon coach 💪 ») : c'est ce nom qui apparaît en haut des notifications.
3. Elle ouvre l'appli **depuis cette icône** (pas depuis Safari) et se reconnecte avec son prénom : l'écran d'accueil garde ses propres données.
4. Onglet **Profil** → carte **Notifications** → **Activer les notifications** → **Autoriser**.
   Elle doit voir « Notifications activées ✓ ».
5. Elle peut toucher **Tester l'affichage** : une notification de test doit apparaître.

## Activer le coach pour elle (toi, 1 minute)

Dès qu'elle a activé les notifications, vérifie dans le SQL Editor que tu la vois :
```sql
select id, label, left(owner_key, 8) as compte, coach, created_at from public.tempo_push_subs order by created_at desc;
```
Puis active son programme :
```sql
update public.tempo_push_subs set coach = true where label ilike 'h_l_ne';
```
Sur son téléphone, la carte Notifications indique alors « Le programme de ton coach est actif ».

**Envoyer un message de test tout de suite** (elle doit recevoir « Test réussi, ma Puce 🎉 » dans les secondes qui suivent) :
```sql
select net.http_post(
  url := 'https://mmkrzwmezowkxjxkongu.supabase.co/functions/v1/tempo-push',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-tempo-secret', 'TON_SECRET'),
  body := '{"action":"test"}'::jsonb);
```

---

## Régler le programme

```sql
-- ses jours de séance (1 = lundi … 7 = dimanche) et l'heure du rappel (heure de Paris)
update public.tempo_push_subs set train_days = '{2,4,6}', train_time = '18:00' where label ilike 'h_l_ne';
-- mettre le coach en pause / le rétablir
update public.tempo_push_subs set coach = false where label ilike 'h_l_ne';
update public.tempo_push_subs set coach = true  where label ilike 'h_l_ne';
-- tout arrêter
select cron.unschedule('tempo-push-tick');
```
Pour changer les phrases, le ton ou les horaires fixes, demande-moi : je modifie `index.ts` et tu le recolles dans la fonction.

## Si elle ne reçoit rien

1. **iOS 16.4 minimum**, et l'appli doit être **ouverte depuis l'icône** de l'écran d'accueil (pas depuis Safari).
2. **Réglages de l'iPhone → Notifications → Tempo** : « Autoriser les notifications » activé. Les modes Concentration (Ne pas déranger, Sommeil…) peuvent aussi les masquer.
3. Dans la carte Notifications : « Notifications activées ✓ » et « programme de ton coach actif » ? Sinon, reprendre « Activer le coach » ci-dessus.
4. Vérifier les erreurs d'envoi :
   ```sql
   select label, coach, last_ok_at, last_error from public.tempo_push_subs;
   ```
5. Dans Supabase → Edge Functions → `tempo-push` → **Logs**, regarde la réponse du dernier passage.
6. Dernier recours : elle désactive puis réactive les notifications dans la carte (cela crée un nouvel abonnement), ou supprime l'icône et recommence l'étape « Sur l'écran d'accueil ».

## À savoir

- Une notification ne peut afficher que **l'icône de l'appli** : sur iPhone, c'est ton portrait (l'icône de l'écran d'accueil). Le nom en gras est « Faissal ».
- Elle peut désactiver les notifications à tout moment (carte Notifications, ou Réglages de l'iPhone). Le coach ne peut rien lui envoyer sans son accord.
- Coût : aucun sur l'offre gratuite de Supabase (1 440 passages par jour, très légers).
- Le minuteur ne lit son historique de séances que lorsqu'un message est dû ; il s'en sert pour ne pas la relancer si elle s'est déjà entraînée.
