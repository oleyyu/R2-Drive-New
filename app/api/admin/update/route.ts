import { requireAdmin } from "@/lib/auth";
import { apiError, json } from "@/lib/http";
import { checkLatestRelease } from "@/lib/update-check";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    return json(await checkLatestRelease());
  } catch (error) {
    return apiError(error);
  }
}
