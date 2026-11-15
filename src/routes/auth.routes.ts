import { Router } from "express";
import { authRateLimit } from "@/middleware/authRateLimit";
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

router.post("/auth/login", authRateLimit("login"), login);
router.post("/auth/logout", logout);
router.get("/auth/session", getSessionState);
router.post("/auth/session/refresh", refreshSession);
router.get("/session/expired", closeExpiredSession);
router.post("/session/active-store", verifyToken, setActiveStore);
router.post("/mobile/auth/login", authRateLimit("login"), mobileLogin);
router.post("/register", authRateLimit("register"), register);
router.get("/me", verifyToken, getMe);
router.post("/onboarding", verifyAccount, completeOnboarding);

export default router;
