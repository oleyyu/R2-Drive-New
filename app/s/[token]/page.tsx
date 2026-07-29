import type { Metadata } from "next";
import { ShareClient } from "@/components/ShareClient";

export const metadata: Metadata = { title: "文件分享" };

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareClient token={token} />;
}
