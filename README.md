# Rayon v2 — gestion de boutiques

Même application que la version d'origine (un seul projet Next.js), découpée en trois projets indépendants. Chacun a son propre `package.json` et s'installe séparément.

| Dossier | Rôle | Technologies | Port en local |
| --- | --- | --- | --- |
| [`backend/`](./backend) | API REST, règles métier, authentification | Node.js, Express 5, Prisma 7, PostgreSQL, Zod | 4000 |
| [`frontend/`](./frontend) | Site web | React 19, Vite, React Router 7, Tailwind 4, react-hook-form, Recharts | 5173 |
| [`mobile/`](./mobile) | Application mobile | Expo SDK 57, React Native, expo-router, TanStack Query | 8081 (Expo) |

Le site et l'application mobile ne parlent qu'au backend. Le schéma Prisma et ses migrations sont ceux de la version d'origine, sans modification : la v2 peut tourner sur la même base de données.

Prérequis : Node.js 20 ou plus récent, et un serveur PostgreSQL. Les commandes ci-dessous sont écrites pour PowerShell.

## 1. Backend

```powershell
cd backend
npm install                      # génère aussi le client Prisma
Copy-Item .env.example .env      # puis renseigner DATABASE_URL et AUTH_SECRET
npm run db:migrate               # applique les migrations (sans effet sur une base déjà à jour)
npm run db:seed                  # optionnel : données de démonstration
npm run dev                      # http://localhost:4000
```

Un secret se génère avec : `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

Comptes créés par `db:seed` (à ne jamais utiliser en production) :

- Propriétaire : `demo@boutique-diallo.test` / `Demo1234!`
- Vendeuse : `vendeuse@boutique-diallo.test` / `Demo1234!`

Le rôle de super administrateur ne s'attribue qu'en ligne de commande :

```powershell
$env:SUPER_ADMIN_EMAIL = "moi@exemple.com"; $env:SUPER_ADMIN_PASSWORD = "MotDePasse123"; npm run admin:create
```

| Commande | Description |
| --- | --- |
| `npm run dev` | Serveur de développement (redémarre à chaque modification) |
| `npm start` | Serveur sans rechargement, pour la production |
| `npm run db:migrate` | Applique les migrations Prisma |
| `npm run db:seed` | Crée les données de démonstration (ne fait rien si elles existent) |
| `npm run admin:create` | Crée ou promeut un super administrateur |
| `npm test` | Tests d'intégration (62 tests) |
| `npm run typecheck` / `npm run lint` | Contrôle de types / ESLint |

### Tests

Les tests vident toutes les tables : ils refusent toute base dont le nom ne se termine pas par `_test`. Indiquez toujours une base **locale** :

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/rayon_test"; npm test
```

Sans `TEST_DATABASE_URL`, la base utilisée est celle de `DATABASE_URL` suffixée par `_test`, créée sur le même serveur : à éviter quand `DATABASE_URL` désigne la base de production.

### Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | Connexion PostgreSQL utilisée par l'application |
| `DIRECT_URL` | Optionnel : connexion utilisée par les migrations (pooler en mode session) |
| `AUTH_SECRET` | Secret de signature des sessions. Obligatoire en production |
| `PORT` | Port d'écoute (4000 par défaut) |
| `FRONTEND_URL` | Adresse du site : seule origine autorisée à utiliser le cookie de session |
| `CORS_ORIGINS` | Optionnel : autres origines de navigateur autorisées, séparées par des virgules |
| `COOKIE_SECURE`, `COOKIE_SAMESITE` | Optionnel : réglages du cookie de session (voir `.env.example`) |
| `TEST_DATABASE_URL` | Base de test |

## 2. Frontend

```powershell
cd frontend
npm install
Copy-Item .env.example .env      # API_PROXY_TARGET = adresse du backend
npm run dev                      # http://localhost:5173
```

Le navigateur n'appelle que le site : le serveur Vite transmet les requêtes `/api` au backend (`API_PROXY_TARGET`). Le cookie de session reste ainsi attaché au site.

| Commande | Description |
| --- | --- |
| `npm run dev` | Serveur de développement |
| `npm run build` | Contrôle de types puis build de production dans `dist/` |
| `npm run preview` | Sert le build de production en local (même proxy `/api`) |
| `npm run typecheck` / `npm run lint` | Contrôle de types / ESLint |

Les pages ont les mêmes adresses que dans la version d'origine (`/dashboard`, `/produits`, `/ventes/nouvelle`, `/admin/boutiques/:id`…). Elles sont déclarées dans `src/router.tsx`, et leurs fichiers ont gardé leur emplacement (`src/app/(app)/produits/page.tsx`, etc.).

## 3. Mobile

```powershell
cd mobile
npm install
Copy-Item .env.example .env      # EXPO_PUBLIC_API_URL (backend) et EXPO_PUBLIC_WEB_URL (site)
npx expo start
```

Sur un vrai téléphone, `EXPO_PUBLIC_API_URL` doit contenir l'adresse IP de l'ordinateur, pas `localhost`. Voir [`mobile/README.md`](./mobile/README.md).

## Authentification

NextAuth est remplacé par une authentification gérée par le backend. Un jeton signé (JWT HS256, 30 jours) identifie le compte ; il ne sert à rien d'autre : rôle, organisation, suspension et désactivation sont relus en base à chaque requête, comme avant.

- **Site web** : `POST /api/auth/login` pose le jeton dans un cookie `HttpOnly`, `Secure` (en production) et `SameSite=Lax`. Le JavaScript de la page ne peut pas le lire, donc une faille XSS ne permet pas de voler la session, contrairement à un jeton rangé dans `localStorage`. En contrepartie, un cookie est envoyé automatiquement par le navigateur : toute requête d'écriture qui le porte doit donc venir du site (`Origin` égal à `FRONTEND_URL`), sinon elle est refusée (protection CSRF). Le cookie est renouvelé au plus une fois par jour tant que le compte utilise le site.
- **Mobile** : `POST /api/mobile/auth/login` renvoie le jeton dans la réponse ; l'application le garde dans `expo-secure-store` et l'envoie dans `Authorization: Bearer …`. Un jeton mobile n'est pas accepté comme cookie, et inversement.

Les sessions ouvertes avec l'ancienne application ne sont pas reconnues : chaque utilisateur se reconnecte une fois. Les mots de passe (bcrypt) sont inchangés.

## API

Les routes, leurs réponses (`{ data }`, `{ data, pagination }`, `{ message }`) et leurs erreurs (`{ message, errors }`) sont celles de la version d'origine. S'y ajoutent :

| Routes | Usage |
| --- | --- |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/session/refresh` | Session du site web (remplacent `/api/auth/[...nextauth]`) |
| `GET /api/pages/...` | Données d'une page du site en une requête. Elles reprennent les lectures que les pages faisaient directement en base quand elles étaient rendues côté serveur |
| `GET /health` | Vérification que le serveur répond |

## Mise en production

- **Site et API sur le même domaine** (recommandé) : faites transmettre `/api` au backend par l'hébergeur du site, ou placez-les sur deux sous-domaines d'un même domaine avec `VITE_API_URL`. Sur deux domaines sans lien, il faut `COOKIE_SAMESITE=none`, ce qui affaiblit la protection.
- **En-têtes de sécurité du site** : en local, ils sont posés par Vite (`vite.config.ts`). En production, reprenez-les dans la configuration de l'hébergeur du site.
- **Mobile** : `mobile/eas.json` contient encore l'adresse de l'ancienne application ; remplacez-la avant un build EAS.
- Le backend s'exécute avec `tsx` (`npm start`) : il n'y a pas d'étape de compilation vers JavaScript.
