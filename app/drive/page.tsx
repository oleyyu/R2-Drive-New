import type { Metadata } from "next";
import { DriveClient } from "@/components/DriveClient";

export const metadata: Metadata = { title: "我的文件" };

export default function DrivePage() {
  return <DriveClient />;
}
