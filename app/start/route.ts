import { registrationStatus } from "@/lib/auth";
import { apiError } from "@/lib/http";

export async function GET(request: Request): Promise<Response> {
  try {
    const registration = await registrationStatus();
    const destination = registration.firstOwnerPending ? "/register" : "/login";
    return Response.redirect(new URL(destination, request.url), 307);
  } catch (error) {
    return apiError(error);
  }
}
