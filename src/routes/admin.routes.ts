import { Router } from "express";
import { requireSuperAdmin } from "@/middleware/requireSuperAdmin";
import {
  getOverview,
  getAnalytics,
  getActivity,
  getAllOrganizations,
  createOrganization,
  getOrganizationById,
  updateOrganizationStatus,
  getAllUsers,
  updateUserStatus,
  updateProfile,
} from "@/controllers/admin.controller";
import { getOrganizationSubscription, postSubscriptionPayment, putOrganizationSubscription } from "@/controllers/subscription.controller";

/** Routes de la plateforme (`/api/admin/**`) : toutes réservées au super administrateur. */
const router = Router();

router.get("/overview", requireSuperAdmin, getOverview);
router.get("/analytics", requireSuperAdmin, getAnalytics);
router.get("/activity", requireSuperAdmin, getActivity);
router.get("/organizations", requireSuperAdmin, getAllOrganizations);
router.post("/organizations", requireSuperAdmin, createOrganization);
router.get("/organizations/:id", requireSuperAdmin, getOrganizationById);
router.patch("/organizations/:id", requireSuperAdmin, updateOrganizationStatus);
// Abonnements : saisie et paiements reçus hors ligne (aucun prestataire intégré).
router.get("/organizations/:id/subscription", requireSuperAdmin, getOrganizationSubscription);
router.put("/organizations/:id/subscription", requireSuperAdmin, putOrganizationSubscription);
router.post("/organizations/:id/subscription/payments", requireSuperAdmin, postSubscriptionPayment);
router.get("/users", requireSuperAdmin, getAllUsers);
router.patch("/users/:id", requireSuperAdmin, updateUserStatus);
router.patch("/profile", requireSuperAdmin, updateProfile);

export default router;
