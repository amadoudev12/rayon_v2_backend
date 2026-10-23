import { Router } from "express";
import { verifyPageToken } from "@/middleware/verifyToken";
import { requirePageSuperAdmin } from "@/middleware/requireSuperAdmin";
import { requirePermission } from "@/middleware/requirePermission";
import { SESSION_RENEW_AFTER_MS, renewSessionCookie } from "@/lib/auth/web-session";
import {
  getOnboardingPage,
  getSuspendedPage,
  getShellPage,
  getDashboardPage,
  getProductsPage,
  getStockPage,
  getStockMovementsPage,
  getSalesPage,
  getNewSalePage,
  getCreditsPage,
  getQuotesPage,
  getPurchasesPage,
  getCustomersPage,
  getSuppliersPage,
  getExpensesPage,
  getSettingsPage,
} from "@/controllers/page.controller";
import {
  getAdminShellPage,
  getAdminHomePage,
  getAdminOrganizationsPage,
  getAdminOrganizationPage,
  getAdminUsersPage,
  getAdminStatisticsPage,
  getAdminActivityPage,
  getAdminProfilePage,
} from "@/controllers/adminPage.controller";

/**
 * Lectures de page du site web (`/api/pages/**`).
 *
 * Chaque route renvoie, en une requête, tout ce qu'une page affiche. Un compte
 * qui n'a pas sa place sur la page reçoit une redirection (`{ redirect }`)
 * plutôt que des données : c'est le rôle de `verifyPageToken` et de
 * `requirePageSuperAdmin`.
 *
 * Les routes `/api/**` restent la référence pour l'application mobile ;
 * celles-ci sont propres au site.
 */
const router = Router();

// Session glissante : le cookie d'un compte qui utilise le site est renouvelé
// au plus une fois par jour.
router.use((_req, res, next) => {
  renewSessionCookie(res, { olderThanMs: SESSION_RENEW_AFTER_MS }).then(() => next(), next);
});

router.get("/onboarding", getOnboardingPage);
router.get("/suspendu", getSuspendedPage);
router.get("/shell", verifyPageToken, getShellPage);
router.get("/dashboard", verifyPageToken, getDashboardPage);
router.get("/produits", verifyPageToken, getProductsPage);
router.get("/stock", verifyPageToken, getStockPage);
router.get("/stock/mouvements", verifyPageToken, getStockMovementsPage);
router.get("/ventes", verifyPageToken, getSalesPage);
router.get("/ventes/nouvelle", verifyPageToken, getNewSalePage);
router.get("/creances", verifyPageToken, getCreditsPage);
router.get("/devis", verifyPageToken, getQuotesPage);
// Un devis se compose avec le même catalogue et les mêmes clients qu'une vente.
router.get("/devis/nouveau", verifyPageToken, getNewSalePage);
router.get("/achats", verifyPageToken, requirePermission("purchase:manage"), getPurchasesPage);
router.get("/clients", verifyPageToken, getCustomersPage);
router.get("/fournisseurs", verifyPageToken, requirePermission("supplier:manage"), getSuppliersPage);
router.get("/depenses", verifyPageToken, requirePermission("expense:manage"), getExpensesPage);
router.get("/parametres", verifyPageToken, requirePermission("members:manage"), getSettingsPage);
// Statut relu en base à chaque requête : tout autre compte est redirigé.
router.get("/admin/shell", requirePageSuperAdmin, getAdminShellPage);
router.get("/admin", requirePageSuperAdmin, getAdminHomePage);
router.get("/admin/boutiques", requirePageSuperAdmin, getAdminOrganizationsPage);
router.get("/admin/boutiques/:id", requirePageSuperAdmin, getAdminOrganizationPage);
router.get("/admin/utilisateurs", requirePageSuperAdmin, getAdminUsersPage);
router.get("/admin/statistiques", requirePageSuperAdmin, getAdminStatisticsPage);
router.get("/admin/activite", requirePageSuperAdmin, getAdminActivityPage);
router.get("/admin/profil", requirePageSuperAdmin, getAdminProfilePage);

export default router;
