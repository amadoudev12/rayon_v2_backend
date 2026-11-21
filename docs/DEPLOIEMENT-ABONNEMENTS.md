# Déploiement du système d'abonnement Rayon

Procédure pour mettre en production les phases 2 à 5 (abonnements, paiements
hors ligne, reçus, notifications, administration centrale), puis activer la
commercialisation. Règles détaillées : `docs/ABONNEMENTS.md`. Procédure
générale de déploiement : `docs/EXPLOITATION.md` §2.

## 1. Ce qui change

| Élément | Contenu |
|---|---|
| Migrations (additives) | `20261121120000_abonnements_fondations`, `20261122120000_paiements_recus_notifications`, `20261123120000_administration_abonnements` |
| Backend | catalogue, droits et quotas, essais, paiements, reçus, notifications, webhooks génériques, administration, tâche horaire |
| Site web | page `/abonnement`, cloche de notifications, administration `/admin/abonnements`, `/admin/paiements`, `/admin/journal` |
| Mobile | écrans Abonnement et Notifications (JavaScript uniquement, aucune dépendance native ajoutée) |

Aucune donnée existante n'est supprimée ni modifiée, à une exception près :
les paiements d'abonnement déjà enregistrés sont rattachés à leur
organisation (nouvelle colonne). Les organisations existantes restent **non
soumises** (aucune limite) tant que l'administration ne leur attribue rien.

## 2. Avant le déploiement

1. **Sauvegarde vérifiée** de la production (EXPLOITATION.md §2, étape 1) :
   `BACKUP_DATABASE_URL=<url directe> bash scripts/backup.sh`.
2. **Répétition des migrations sur cette sauvegarde** (conteneur de test
   jetable, aucune autre base touchée) :

   ```
   npm run test:db:up
   PG_BIN="<dossier de pg_restore>" bash scripts/verify-migrations-on-dump.sh <sauvegarde.dump>
   ```

   Attendu : les trois migrations listées en attente, « aucune ligne
   existante perdue », « schéma obtenu = schema.prisma ». Répétition faite le
   2026-11-21 sur la base de développement : 34 tables, aucune perte.
3. **Version de PostgreSQL** : 12 ou plus (deux valeurs d'énumération ajoutées
   dans une même migration). Supabase : conforme.
4. **Tests** : `npm test` (base de test Docker) doit être entièrement vert.

## 3. Déploiement

Ordre impératif : base, puis backend, puis site, puis mobile.

1. Heure creuse. `npm run db:migrate` avec `DIRECT_URL` (port 5432).
2. Supabase : exécuter `scripts/supabase-audit.sql` ; si de nouvelles tables
   sont exposées aux rôles `anon` / `authenticated`, exécuter
   `scripts/supabase-hardening.sql` (après validation, voir son en-tête).
3. Variables du backend (aucun secret à ajouter pour le paiement hors ligne) :

   | Variable | Valeur au déploiement |
   |---|---|
   | `SUBSCRIPTIONS_ENFORCED` | `false` (activation au §4) |
   | `SUBSCRIPTION_MANUAL_PAYMENT_INSTRUCTIONS` | vos numéros Mobile Money, ex : « Envoyez le montant par Wave au +225 … ou Orange Money au +221 … » |
   | `SUBSCRIPTION_JOBS_INTERVAL_MINUTES` | laisser vide (60) |
   | `SUBSCRIPTION_PAYMENT_PROVIDER` | laisser vide (pas de prestataire en ligne) |

4. Déployer le backend, vérifier `GET /health/ready` puis les journaux :
   aucun `subscription_jobs.*_failed`.
5. Déployer le site (Vercel). Vérifier : page `/abonnement` (propriétaire et
   vendeur), cloche de notifications, pages d'administration.
6. Mobile : la mise à jour ne contient que du JavaScript ; elle peut être
   publiée par mise à jour à distance (`npx eas-cli@latest update`) ou par une
   nouvelle version. Les anciennes versions installées continuent de
   fonctionner (champs ajoutés à `/api/me` sans rien retirer).

## 4. Activation commerciale (décision, pas un effet du déploiement)

1. **Attribuer les abonnements des organisations existantes** depuis
   `/admin/abonnements` → fiche de l'organisation → « Accorder l'essai » ou
   « Attribuer un forfait », avec un motif. Les organisations restées sans
   abonnement conservent un accès illimité.
2. **Prévenir les clients** des forfaits et de la date d'activation.
3. Passer `SUBSCRIPTIONS_ENFORCED=true` et redémarrer. À partir de là :
   lecture seule à l'expiration (après 7 jours de grâce), fonctionnalités et
   quotas des forfaits, rappels d'échéance dans l'application.

**Point d'attention** : les organisations créées après le déploiement
reçoivent leur essai de 14 jours dès leur inscription, même si l'activation
n'a pas encore eu lieu. Si l'activation est tardive, leurs essais seront déjà
terminés et elles passeront en lecture seule dès l'activation : les prolonger
au besoin (`Prolonger`, avec motif), ou activer peu après le déploiement.

## 5. Exploitation quotidienne

- **Paiements à confirmer** (cloche de l'administration, `/admin/paiements`) :
  à la réception de l'argent, « Confirmer » avec le montant reçu, le moyen, la
  référence de l'opération et la date de réception. L'abonnement est activé
  une seule fois, le reçu émis, le propriétaire notifié.
- **À traiter** (même page) : paiements en vérification (montant insuffisant,
  abonnement suspendu…), argent reçu non activé, transactions en attente
  depuis plus de 48 h. Le rapprochement tourne chaque heure et peut être lancé
  à la main.
- **Interventions** (fiche d'une organisation) : attribuer, prolonger,
  suspendre, réactiver, toujours avec un motif ; tout figure au journal
  d'audit (`/admin/journal`), qui ne peut être ni modifié ni effacé.
- **Remboursements et litiges** : procédure administrative hors application
  (cahier §16). Ne jamais « annuler » un paiement confirmé : l'historique
  financier est conservé.

## 6. Retour arrière

- **Désactiver les blocages** : `SUBSCRIPTIONS_ENFORCED=false` suffit à
  rendre l'accès complet à toutes les organisations, sans perte de données.
- **Code** : les migrations étant additives, l'ancienne version démarre sur le
  nouveau schéma. Mais elle ne connaît pas les transactions sans référence
  externe ni les nouveaux statuts de paiement : dès qu'un client a créé une
  demande de paiement, préférer une correction en avant. Ne jamais supprimer
  les nouvelles tables (historique financier).
- **Base** : restaurer la sauvegarde seulement en cas de corruption (perte des
  opérations enregistrées depuis).

## 7. Brancher SasPay plus tard

Dès l'approbation du compte et la réception de la documentation officielle :
adaptateur `src/services/billing/providers/saspay.ts` (contrat de
`provider.ts`), identifiants dans `backend/.env` uniquement, URL de
notification `https://<api>/api/webhooks/payments/saspay`, tests en Sandbox,
puis `SUBSCRIPTION_PAYMENT_PROVIDER=saspay` après validation explicite
(`docs/ABONNEMENTS.md` §11). Le paiement hors ligne reste disponible.

## 8. Contrôles après mise en production

- [ ] `GET /health/ready` : 200.
- [ ] Une nouvelle inscription reçoit un essai de 14 jours (fiche dans `/admin/abonnements`).
- [ ] Une demande de paiement d'un propriétaire apparaît dans `/admin/paiements` ; sa confirmation émet un reçu téléchargeable et une notification.
- [ ] Le journal d'audit contient l'intervention.
- [ ] Une organisation existante sans abonnement n'est pas bloquée.
- [ ] Aucune erreur `subscription_jobs.*_failed` ni `billing.*` inattendue dans les journaux.
