import { Router } from "express";
import { verifyAccount, verifyToken } from "@/middleware/verifyToken";
import {
  login,
  logout,
  getSessionState,
  refreshSession,
  closeExpiredSession,
  setActiveStore,
  mobileLogin,
  register,
  getMe,
  completeOnboarding,
} from "@/controllers/auth.controller";

const router = Router();

router.post("/auth/login", login);
router.post("/auth/logout", logout);
router.get("/auth/session", getSessionState);
router.post("/auth/session/refresh", refreshSession);
router.get("/session/expired", closeExpiredSession);
router.post("/session/active-store", verifyToken, setActiveStore);
router.post("/mobile/auth/login", mobileLogin);
router.post("/register", register);
router.get("/me", verifyToken, getMe);
router.post("/onboarding", verifyAccount, completeOnboarding);

export default router;
