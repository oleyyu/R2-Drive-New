import { audit, ensureDatabase } from "@/db/runtime";
import { requireAdmin } from "@/lib/auth";
import { apiError, assertSameOrigin, HttpError, json } from "@/lib/http";
import { readStorageNodeJson } from "@/lib/storage";
import { signedNodeFetch } from "@/lib/storage-capability";
import { z } from "zod";

type RouteContext = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    status: z.enum(["active", "draining"]).optional(),
    checkHealth: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.checkHealth === true,
    "没有需要更新的内容。",
  );

type NodeRow = {
  id: string;
  quota_owner_id: string | null;
  endpoint: string;
  status: "active" | "draining" | "offline";
  soft_limit_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
};

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const input = patchSchema.safeParse(await request.json());
    if (!input.success) {
      throw new HttpError(400, "节点设置无效。", "invalid_input");
    }
    const db = await ensureDatabase();
    const node = await db
      .prepare(
        `SELECT id, quota_owner_id, endpoint, status, soft_limit_bytes, used_bytes, reserved_bytes
         FROM storage_nodes WHERE id = ?`,
      )
      .bind(id)
      .first<NodeRow>();
    if (!node) throw new HttpError(404, "存储节点不存在。", "not_found");
    let lastHealthAt: string | null = null;
    let lastError: string | null = null;
    let checkedStatus: "active" | "draining" | "offline" | undefined;
    if (input.data.checkHealth) {
      lastHealthAt = new Date().toISOString();
      try {
        const response = await signedNodeFetch(
          { id: node.id, endpoint: node.endpoint },
          "/v1/health",
          { method: "GET", signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await readStorageNodeJson(response, "健康检查");
        if (
          typeof result !== "object" ||
          result === null ||
          !("ok" in result) ||
          !("nodeId" in result) ||
          !("protocol" in result) ||
          result.ok !== true ||
          result.nodeId !== node.id ||
          result.protocol !== "r2drive-storage-node-v1"
        ) {
          throw new Error("节点身份不匹配");
        }
        checkedStatus =
          input.data.status ?? (node.status === "offline" ? "active" : node.status);
      } catch (error) {
        checkedStatus = "offline";
        lastError = error instanceof Error ? error.message.slice(0, 240) : "健康检查失败";
      }
    }

    const now = new Date().toISOString();
    const status = checkedStatus ?? input.data.status ?? node.status;
    await db
      .prepare(
        `UPDATE storage_nodes
         SET status = ?,
             last_health_at = COALESCE(?, last_health_at),
             last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(status, lastHealthAt, lastError, now, id)
      .run();
    await audit("storage_node.updated", admin.id, "storage_node", id, {
      status,
      softLimitBytes: node.soft_limit_bytes,
      healthChecked: input.data.checkHealth === true,
    });
    return json({
      ok: true,
      status,
      softLimitBytes: node.soft_limit_bytes,
      lastHealthAt,
      lastError,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireAdmin(request);
    const { id } = await context.params;
    const db = await ensureDatabase();
    const node = await db
      .prepare("SELECT id FROM storage_nodes WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!node) throw new HttpError(404, "存储节点不存在。", "not_found");
    throw new HttpError(
      409,
      "当前版本不能只从网页断开节点，否则会遗留本机清单和 Cloudflare 资源。请先暂停新写入；如需删除全部节点，请在本机启动器使用“一键卸载”。",
      "local_helper_required",
    );
  } catch (error) {
    return apiError(error);
  }
}
