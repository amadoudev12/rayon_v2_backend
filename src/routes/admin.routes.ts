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

/** Routes de la plateforme (`/api/admin/**`) : toutes réservées au super administrateur. */
const router = Router();

router.get("/overview", requireSuperAdmin, getOverview);
router.get("/analytics", requireSuperAdmin, getAnalytics);
router.get("/activity", requireSuperAdmin, getActivity);
router.get("/organizations", requireSuperAdmin, getAllOrganizations);
router.post("/organizations", requireSuperAdmin, createOrganization);
router.get("/organizations/:id", requireSuperAdmin, getOrganizationById);
router.patch("/organizations/:id", requireSuperAdmin, updateOrganizationStatus);
router.get("/users", requireSuperAdmin, getAllUsers);
router.patch("/users/:id", requireSuperAdmin, updateUserStatus);
router.patch("/profile", requireSuperAdmin, updateProfile);

export default router;
