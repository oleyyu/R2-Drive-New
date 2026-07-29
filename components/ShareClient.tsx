"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, Cloud, File, Hourglass, WarningCircle } from "@phosphor-icons/react";

type ShareData = {
  file: { id: string; name: string; size: number; contentType: string | null };
  expiresAt: string | null;
  remainingDownloads: number | null;
};

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = value ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return `${(value / 1024 ** index).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${units[index]}`;
}

export function ShareClient({ token }: { token: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/public/shares/${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (!response.ok) {
          const result = (await response.json()) as { error?: { message?: string } };
          throw new Error(result.error?.message || "分享不可用。");
        }
        return response.json() as Promise<ShareData>;
      })
      .then(setData)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "分享不可用。"));
  }, [token]);

  return (
    <main className="share-page">
      <nav>
        <Link href="/" className="brand"><span className="brand-mark">R2</span><span>R2 Drive</span></Link>
        <Link href="/" className="text-link"><ArrowLeft /> 返回首页</Link>
      </nav>
      <section className="share-panel">
        <div className="share-watermark">R2</div>
        {error ? (
          <div className="share-state">
            <WarningCircle weight="fill" />
            <h1>无法访问此分享</h1>
            <p>{error}</p>
          </div>
        ) : !data ? (
          <div className="share-state"><Cloud className="pulse" /><p>正在验证分享链接…</p></div>
        ) : (
          <>
            <p className="eyebrow">SHARED WITH R2 DRIVE</p>
            <div className="share-file-icon"><File weight="fill" /></div>
            <h1>{data.file.name}</h1>
            <p className="share-meta">{formatBytes(data.file.size)} · {data.file.contentType || "application/octet-stream"}</p>
            <div className="share-constraints">
              <span><Hourglass /> {data.expiresAt ? `${new Date(data.expiresAt).toLocaleString("zh-CN")} 到期` : "长期有效"}</span>
              {data.remainingDownloads !== null && <span>剩余 {data.remainingDownloads} 次下载</span>}
            </div>
            <a className="button button-primary button-large" href={`/api/public/shares/${encodeURIComponent(token)}/download`}>
              <ArrowDown /> 下载文件
            </a>
            <p className="share-note">下载由文件所有者的 R2 Drive 实例提供。请仅打开你信任的文件。</p>
          </>
        )}
      </section>
    </main>
  );
}
