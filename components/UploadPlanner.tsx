"use client";

import { useMemo, useState } from "react";
import { ArrowRight, CloudArrowUp, File, ShieldCheck } from "@phosphor-icons/react";

const MIB = 1024 ** 2;
const MIN_PART = 5 * MIB;
const DEFAULT_PART = 64 * MIB;
const MAX_PARTS = 10_000;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const order = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** order).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${units[order]}`;
}

export function UploadPlanner() {
  const [sizeGiB, setSizeGiB] = useState(120);
  const plan = useMemo(() => {
    const bytes = Math.max(sizeGiB, 0.01) * 1024 ** 3;
    const required = Math.ceil(bytes / MAX_PARTS / MIB) * MIB;
    const partSize = Math.max(DEFAULT_PART, MIN_PART, required);
    return { bytes, partSize, parts: Math.ceil(bytes / partSize) };
  }, [sizeGiB]);

  return (
    <div className="upload-planner" aria-label="上传分片计算器">
      <div className="planner-header">
        <div className="window-dots" aria-hidden="true"><span /><span /><span /></div>
        <span>上传计划 / R2 MULTIPART</span>
        <ShieldCheck weight="fill" />
      </div>
      <div className="planner-file">
        <div className="file-icon"><File weight="fill" /></div>
        <div>
          <strong>archive-production.tar</strong>
          <span>{formatBytes(plan.bytes)} · application/x-tar</span>
        </div>
        <span className="status-chip">READY</span>
      </div>
      <label className="planner-slider">
        <span>模拟文件大小</span>
        <strong>{sizeGiB.toLocaleString("zh-CN")} GiB</strong>
        <input
          type="range"
          min="1"
          max="5000"
          step="1"
          value={sizeGiB}
          onChange={(event) => setSizeGiB(Number(event.target.value))}
        />
      </label>
      <div className="planner-stats">
        <div><span>分片大小</span><strong>{formatBytes(plan.partSize)}</strong></div>
        <div><span>分片数量</span><strong>{plan.parts.toLocaleString("zh-CN")}</strong></div>
        <div><span>传输路径</span><strong>浏览器 → R2</strong></div>
      </div>
      <div className="planner-route">
        <span><CloudArrowUp /> Browser</span>
        <i><ArrowRight /></i>
        <span>Signed URL</span>
        <i><ArrowRight /></i>
        <span className="route-target">R2 Bucket</span>
      </div>
    </div>
  );
}
