import { getSessionUser } from "@/lib/auth";
import { apiError, json } from "@/lib/http";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getSessionUser(request);
    if (!user) return json({ user: null }, { status: 401 });
    return json({ user });
  } catch (error) {
    return apiError(error);
  }
}
