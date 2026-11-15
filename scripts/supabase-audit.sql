-- Contrôle d'exposition Supabase (LECTURE SEULE). À exécuter dans l'éditeur
-- SQL du projet Supabase de production, puis transmettre le résultat.
-- Aucune donnée ni aucun réglage n'est modifié.
--
-- Contexte : Prisma crée les tables dans le schéma `public`. Si l'API Data de
-- Supabase (PostgREST) expose ce schéma et que les rôles `anon` /
-- `authenticated` ont des droits sur ces tables sans RLS, toute personne
-- connaissant l'URL du projet et la clé `anon` (publique par conception)
-- pourrait lire ou modifier les données, en contournant entièrement l'API Rayon.

-- 1. Tables de `public` : RLS activée ?
SELECT c.relname AS "table",
       c.relrowsecurity AS rls_activee,
       c.relforcerowsecurity AS rls_forcee,
       (SELECT COUNT(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS politiques
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

-- 2. Droits des rôles exposés par l'API Data sur les tables et séquences.
SELECT grantee AS role, table_name AS objet, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS droits
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
GROUP BY grantee, table_name
ORDER BY grantee, table_name;

SELECT grantee AS role, object_name AS sequence, string_agg(privilege_type, ', ') AS droits
FROM information_schema.usage_privileges
WHERE object_schema = 'public' AND object_type = 'SEQUENCE' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
GROUP BY grantee, object_name;

-- 3. Droits par défaut appliqués aux FUTURES tables (migrations à venir).
SELECT pg_get_userbyid(d.defaclrole) AS proprietaire,
       n.nspname AS schema,
       d.defaclobjtype AS type_objet,
       d.defaclacl AS droits
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public' OR n.nspname IS NULL;

-- 4. Rôle utilisé par Prisma et propriétaire des tables (le propriétaire
--    contourne la RLS : activer la RLS ne gêne donc pas l'application).
SELECT current_user AS role_courant,
       (SELECT DISTINCT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'Vente') AS proprietaire_des_tables;

-- 5. Fonctions SECURITY DEFINER de `public` (appelables via l'API si exposées).
SELECT p.proname AS fonction, pg_get_userbyid(p.proowner) AS proprietaire
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef;

-- À vérifier aussi dans le tableau de bord Supabase (non visible en SQL) :
--   Settings > API > « Exposed schemas » : `public` y figure-t-il ?
--   Settings > API : l'API Data est-elle activée ?
--   La clé `service_role` n'est-elle utilisée nulle part côté client ?
