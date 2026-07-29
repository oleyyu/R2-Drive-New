import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "R2 Drive - 可自托管的 Cloudflare R2 网盘",
    template: "%s · R2 Drive",
  },
  description:
    "给自己使用的开源 Cloudflare R2 网盘。支持超大文件分片直传、分享下载、API 与完整管理后台。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "R2 Drive - 你的对象存储，你的网盘",
    description: "开源、私人使用、超大文件分片直传，运行在自己的 Cloudflare 账号。",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "R2 Drive - 你的对象存储，你的网盘" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "R2 Drive - 你的对象存储，你的网盘",
    description: "开源、私人使用、超大文件分片直传，运行在自己的 Cloudflare 账号。",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
