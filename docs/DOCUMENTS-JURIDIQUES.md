# Documents juridiques et acceptations

CGU (`/conditions-utilisation`) et Politique de confidentialité
(`/politique-confidentialite`) : textes versionnés, accord obligatoire,
historique en ajout seul.

## Fonctionnement

| Élément | Emplacement |
|---|---|
| Textes publiés (immuables) | `src/legal/documents/*.ts` |
| Liste des versions | `src/legal/registry.ts` |
| Règle « faut-il un nouvel accord ? » | `src/legal/status.ts` |
| Blocage des comptes sans accord | `resolveAccount` dans `src/lib/auth/session.ts` |
| Preuves | table `AcceptationJuridique` |

Un document exige un accord si l'utilisateur n'a accepté ni sa dernière
version « avec accord », ni une version plus récente. Le calcul est fait à
chaque requête : une session déjà ouverte est concernée immédiatement.

Un compte qui doit accepter peut uniquement lire les documents, consulter son
statut, accepter et se déconnecter. Cela vaut pour les propriétaires, les
collaborateurs, les comptes créés par l'administration et les super
administrateurs. Une organisation suspendue voit d'abord l'écran de suspension.

## API

| Route | Accès | Réponse |
|---|---|---|
| `GET /api/legal` | public | documents en vigueur |
| `GET /api/legal/documents/:slug[?version=1.0]` | public | texte, versions, empreinte SHA-256 |
| `GET /api/legal/status` | compte connecté | statut et historique du compte |
| `POST /api/legal/acceptance` | compte connecté | `{ accepteDocuments: true, termsVersion, privacyVersion }` |

`POST /api/register` exige les trois mêmes champs.

| Code | HTTP | Sens |
|---|---|---|
| `LEGAL_ACCEPTANCE_REQUIRED` | 403 | accord requis avant toute fonctionnalité protégée |
| `LEGAL_CONSENT_MISSING` | 400 | accord absent ou non explicite |
| `LEGAL_VERSION_OUTDATED` | 409 | versions affichées différentes de celles en vigueur |

Les pages (`/api/pages/**`) répondent `{ redirect: "/acceptation-conditions" }`.

## Publier une nouvelle version

**Ne jamais modifier un fichier de version publiée**, même pour remplir un
champ « À COMPLÉTER » : le test « le texte d'une version publiée n'a pas
changé » échoue, et les preuves ne correspondraient plus au texte accepté.

1. Copier le dernier fichier, par exemple `terms-1.0.ts` vers `terms-1.1.ts`,
   et renommer la constante (`termsV1_1`).
2. Modifier le texte, `version`, `publishedAt`, `summary` (montré aux
   utilisateurs) et `requiresAcceptance`.
3. L'ajouter **en fin** de `releases` dans `src/legal/registry.ts`.
4. `npx vitest run tests/legal.test.ts -u`, puis vérifier que le diff du
   snapshot ne fait qu'**ajouter** une ligne.
5. `npm test`, commit, déploiement. Aucune migration ni mise à jour en base.
6. `npm run legal:report` : comptes qui devront accepter.

| Modification | `requiresAcceptance` |
|---|---|
| Identité de l'éditeur ou du responsable du traitement | `true` |
| Prix, paiement, résiliation, responsabilité, litiges | `true` |
| Nouvelle donnée, finalité, destinataire, pays de transfert | `true` |
| Durée de conservation fixée ou allongée | `true` |
| Faute, mise en forme, reformulation sans effet | `false` |
| Coordonnée de contact mise à jour | `false` |

En cas de doute : `true`, après avis d'un juriste.

## Preuves

- Colonnes : `userId`, `termsVersion`, `privacyVersion`, `acceptedAt` (heure
  du serveur, UTC), `source` (inscription, site, mobile).
- Ni adresse IP ni User-Agent : inutiles à la preuve (minimisation, loi
  n° 2013-450, article 16).
- Un trigger refuse `UPDATE` et `DELETE`. Un compte porteur d'une preuve ne se
  supprime pas : pour une demande d'effacement, anonymiser les champs
  personnels de `Utilisateur` et conserver la preuve pendant sa durée légale.
- Aucune preuve n'est créée pour un compte existant. Ne jamais en insérer à la
  main sans pièce attestant la version et la date réelles de l'accord.

## Déploiement et retour arrière

1. Sauvegarde vérifiée, puis `npm run db:migrate` avec `DIRECT_URL`.
2. Site, puis backend aussitôt : le site précédent ne connaît ni la case à
   cocher ni l'écran d'acceptation.
3. Retour arrière : redéployer les deux versions précédentes. Ne jamais
   supprimer la table.

Les applications mobiles antérieures à cet écran affichent le message du
serveur, qui renvoie vers le site pour accepter.

## À compléter avant validation juridique

Chaque champ porte la mention `À COMPLÉTER` dans les textes
(`grep -rn "À COMPLÉTER" src/legal/documents`). Les compléter se fait par une
nouvelle version. Faire relire les textes par un juriste ivoirien et vérifier
auprès de l'ARTCI les formalités des articles 5, 7 et 26 de la loi
n° 2013-450 (déclaration, numéros de téléphone, transferts hors CEDEAO).
