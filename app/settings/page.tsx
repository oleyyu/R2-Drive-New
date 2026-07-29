import type { Metadata } from "next";
import { SettingsClient } from "@/components/SettingsClient";

export const metadata: Metadata = { title: "个人设置" };

export default function SettingsPage() {
  return <SettingsClient />;
}
