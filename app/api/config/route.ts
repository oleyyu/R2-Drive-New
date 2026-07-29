import { appConfig, directR2Configured } from "@/lib/config";
import { registrationStatus } from "@/lib/auth";
import { apiError, json } from "@/lib/http";

export async function GET(): Promise<Response> {
  try {
    const config = appConfig();
    const registration = await registrationStatus();
    return json({
      appName: config.appName,
      registrationMode: registration.mode,
      firstOwnerPending: registration.firstOwnerPending,
      canRegister: registration.canRegister,
      maxFileSizeBytes: config.maxFileSizeBytes,
      preferredPartSizeBytes: config.preferredPartSizeBytes,
      directUpload: config.uploadMode !== "proxy" && directR2Configured(),
      uploadMode: config.uploadMode,
      downloadMode: config.downloadMode,
      sharingEnabled: config.sharingEnabled,
    });
  } catch (error) {
    return apiError(error);
  }
}
