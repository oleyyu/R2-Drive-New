import type { Metadata } from "next";
import { AdminClient } from "@/components/AdminClient";

export const metadata: Metadata = { title: "管理控制台" };

export default function AdminPage() {
  return <AdminClient />;
}
