import { ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { apiError, HttpError, json } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

type EnrollmentRow = {
  expires_at: string;
  completed_node_id: string | null;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireAdmin(request);
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new HttpError(400, "节点连接编号无效。", "invalid_enrollment");
    }
    const db = await ensureDatabase();
    const enrollment = await db
      .prepare(
        `SELECT expires_at, completed_node_id
         FROM storage_node_enrollments
         WHERE id = ?`,
      )
      .bind(id)
      .first<EnrollmentRow>();
    if (!enrollment) {
      throw new HttpError(404, "节点连接不存在。", "not_found");
    }
    const connected = Boolean(enrollment.completed_node_id);
    const expired =
      !connected && Date.parse(enrollment.expires_at) <= Date.now();
    return json({
      status: connected ? "connected" : expired ? "expired" : "pending",
      nodeId: enrollment.completed_node_id,
    });
  } catch (error) {
    return apiError(error);
  }
}
