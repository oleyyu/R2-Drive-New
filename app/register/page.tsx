import type { Metadata } from "next";
import { AuthForm } from "@/components/AuthForm";

export const metadata: Metadata = { title: "创建账号" };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
