import { Router, type Request, type Response } from "express";
import { verifyTokenAllowingReadOnly } from "@/middleware/verifyToken";
import { jsonData, routeId, searchParams } from "@/lib/api/response";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "@/services/notifications";

/**
 * Notifications intégrées de l'utilisateur connecté (les siennes uniquement,
 * dans son organisation). Ouvertes en lecture seule : marquer comme lu ne
 * modifie aucune donnée commerciale.
 */
const router = Router();

router.get("/", verifyTokenAllowingReadOnly, async (req: Request, res: Response) => {
  const unreadOnly = searchParams(req).get("unread") === "true";
  return jsonData(res, await listNotifications(req.user.userId, req.user.organizationId, { unreadOnly }));
});
router.post("/read-all", verifyTokenAllowingReadOnly, async (req: Request, res: Response) => {
  return jsonData(res, await markAllNotificationsRead(req.user.userId, req.user.organizationId));
});
router.post("/:id/read", verifyTokenAllowingReadOnly, async (req: Request, res: Response) => {
  await markNotificationRead(req.user.userId, req.user.organizationId, routeId(req));
  return jsonData(res, { read: true });
});

export default router;
