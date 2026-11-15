-- Durcissement Supabase — NE PAS EXÉCUTER SANS VALIDATION EXPLICITE.
--
-- À appliquer sur le projet Supabase de production seulement après :
--   1. lecture des résultats de scripts/supabase-audit.sql ;
--   2. une sauvegarde vérifiée (scripts/backup.sh + scripts/restore-test.sh) ;
--   3. l'accord du responsable de la plateforme.
--
-- Effet : les rôles publics de l'API Data (`anon`, `authenticated`) perdent
-- tout accès aux tables de Rayon et la RLS est activée sans aucune politique
-- (tout refusé pour ces rôles). L'application n'est PAS affectée : Prisma se
-- connecte avec le rôle propriétaire des tables, qui contourne la RLS.
-- Réversible : voir la section « Retour arrière » en bas du fichier.
-- Vérifié sur une base PostgreSQL locale simulant les rôles Supabase.

BEGIN;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Tables créées par les futures migrations : aucun droit par défaut.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Défense en profondeur : RLS activée partout (aucune politique = tout refusé
-- pour les rôles non propriétaires).
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

COMMIT;

-- Recommandé en plus, dans le tableau de bord : retirer `public` des
-- « Exposed schemas » (ou désactiver l'API Data), Rayon ne l'utilisant pas.
--
-- Retour arrière (si une intégration externe légitime utilisait l'API Data) :
--   ALTER TABLE public."<table>" DISABLE ROW LEVEL SECURITY;
--   GRANT SELECT ON public."<table>" TO authenticated;   -- au cas par cas
