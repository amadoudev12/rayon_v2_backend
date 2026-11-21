import { Router } from "express";
import { authRateLimit } from "@/middleware/authRateLimit";
import { verifyAccount, verifyToken, verifyTokenAllowingPasswordChange, verifyTokenAllowingReadOnly } from "@/middleware/verifyToken";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
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
  changePassword,
  getSessions,
  revokeOtherSessions,
} from "@/controllers/auth.controller";

const router = Router();

router.post("/auth/login", authRateLimit("login"), login);
router.post("/auth/logout", logout);
router.get("/auth/session", getSessionState);
router.post("/auth/session/refresh", refreshSession);
router.get("/session/expired", closeExpiredSession);
router.post("/session/active-store", verifyTokenAllowingReadOnly, setActiveStore);
router.post("/mobile/auth/login", authRateLimit("login"), mobileLogin);
router.post("/register", authRateLimit("register"), register);
// Profil, changement de mot de passe et sessions : accessibles même avec un
// mot de passe temporaire (c'est là qu'on le remplace).
router.get("/me", verifyTokenAllowingPasswordChange, getMe);
router.post("/account/password", verifyTokenAllowingPasswordChange, rateLimit(RATE_RULES.passwordChange), changePassword);
router.get("/account/sessions", verifyToken, getSessions);
router.post("/account/sessions/revoke-others", verifyTokenAllowingReadOnly, revokeOtherSessions);
router.post("/onboarding", verifyAccount, completeOnboarding);

export default router;
