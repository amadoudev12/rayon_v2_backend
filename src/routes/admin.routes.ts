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
import {
  getAdminAudit,
  getAdminPaymentAnomalies,
  getAdminPaymentById,
  getAdminPayments,
  getAdminReceipts,
  getAdminSubscriptionDashboard,
  getAdminSubscriptions,
  postAssignPlan,
  postExtendSubscription,
  postGrantTrial,
  postReactivateSubscription,
  postSuspendSubscription,
} from "@/controllers/adminBilling.controller";
import {
  getOrganizationSubscription,
  postConfirmSubscriptionPayment,
  postReconcileSubscriptionPayments,
  postRejectSubscriptionPayment,
  postSubscriptionPayment,
  putOrganizationSubscription,
} from "@/controllers/subscription.controller";

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
// Saisie directe d'un paiement avec sa période (ancien mode, conservé pour compatibilité).
router.post("/organizations/:id/subscription/payments", requireSuperAdmin, postSubscriptionPayment);
// Transactions créées par les clients : confirmation d'un paiement reçu, refus, rapprochement.
// Interventions sur un abonnement : motif obligatoire, journalisées.
router.post("/organizations/:id/subscription/assign", requireSuperAdmin, postAssignPlan);
router.post("/organizations/:id/subscription/extend", requireSuperAdmin, postExtendSubscription);
router.post("/organizations/:id/subscription/suspend", requireSuperAdmin, postSuspendSubscription);
router.post("/organizations/:id/subscription/reactivate", requireSuperAdmin, postReactivateSubscription);
router.post("/organizations/:id/subscription/trial", requireSuperAdmin, postGrantTrial);
router.get("/subscriptions", requireSuperAdmin, getAdminSubscriptions);
router.get("/subscriptions/dashboard", requireSuperAdmin, getAdminSubscriptionDashboard);
router.get("/subscription-payments", requireSuperAdmin, getAdminPayments);
router.get("/subscription-payments/anomalies", requireSuperAdmin, getAdminPaymentAnomalies);
router.post("/subscription-payments/reconcile", requireSuperAdmin, postReconcileSubscriptionPayments);
router.get("/subscription-payments/:id", requireSuperAdmin, getAdminPaymentById);
router.post("/subscription-payments/:id/confirm", requireSuperAdmin, postConfirmSubscriptionPayment);
router.post("/subscription-payments/:id/reject", requireSuperAdmin, postRejectSubscriptionPayment);
router.get("/subscription-receipts", requireSuperAdmin, getAdminReceipts);
router.get("/audit", requireSuperAdmin, getAdminAudit);
router.get("/users", requireSuperAdmin, getAllUsers);
router.patch("/users/:id", requireSuperAdmin, updateUserStatus);
router.patch("/profile", requireSuperAdmin, updateProfile);

export default router;
