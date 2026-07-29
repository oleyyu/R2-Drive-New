import { clearSessionCookie, destroySession } from "@/lib/auth";
import { apiError, assertSameOrigin, json } from "@/lib/http";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    await destroySession(request);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(request) } });
  } catch (error) {
    return apiError(error);
  }
}
