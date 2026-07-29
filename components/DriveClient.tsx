"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  ArrowCounterClockwise,
  CaretRight,
  Check,
  CheckCircle,
  CloudArrowUp,
  Copy,
  DownloadSimple,
  File as FileIcon,
  FileArchive,
  FilePdf,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GridFour,
  ImageSquare,
  LinkSimple,
  List,
  MagnifyingGlass,
  MusicNotes,
  PencilSimple,
  PushPin,
  ShareNetwork,
  SortAscending,
  SortDescending,
  Trash,
  UploadSimple,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { AppShell } from "@/components/AppShell";

type DriveScope =
  | "all"
  | "recent"
  | "image"
  | "document"
  | "video"
  | "audio"
  | "other"
  | "trash"
  | "shared";

type DriveFile = {
  id: string;
  parentId: string | null;
  kind: "file" | "folder";
  name: string;
  size: number;
  contentType: string | null;
  isPinned: boolean;
  status: "uploading" | "ready" | "failed" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

type Shortcut = Pick<DriveFile, "id" | "parentId" | "kind" | "name">;

type ShareRow = {
  id: string;
  fileId: string;
  fileName: string;
  size: number;
  contentType: string | null;
  url: string | null;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
  status: "active" | "expired" | "exhausted";
};

type UploadItem = {
  key: string;
  name: string;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  status: "running" | "done" | "error";
  message?: string;
};

type EditorState =
  | { kind: "create"; name: string }
  | { kind: "rename"; file: DriveFile; name: string }
  | null;

type ConfirmState =
  | { kind: "trash"; files: DriveFile[] }
  | { kind: "permanent"; files: DriveFile[] }
  | { kind: "empty-trash"; files: [] }
  | null;

type ApiFailure = { error?: { message?: string } };

const scopeLabels: Record<DriveScope, string> = {
  all: "我的文件",
  recent: "最近",
  image: "图片",
  document: "文档",
  video: "视频",
  audio: "音频",
  other: "其他",
  trash: "回收站",
  shared: "分享管理",
};

const validScopes = new Set<DriveScope>(Object.keys(scopeLabels) as DriveScope[]);

function formatBytes(value: number): string {
  if (!value) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
  })} ${units[index]}`;
}

function formatUploadBytes(value: number): string {
  return value > 0 ? formatBytes(value) : "0 B";
}

function formatUploadPercent(value: number): string {
  if (value >= 100) return "100%";
  if (value <= 0) return "0%";
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function responseError(response: Response): Promise<Error> {
  try {
    const data = (await response.json()) as ApiFailure;
    return new Error(data.error?.message || `请求失败 (${response.status})`);
  } catch {
    return new Error(`请求失败 (${response.status})`);
  }
}

function xhrResponseError(xhr: XMLHttpRequest, fallback: string): Error {
  try {
    const data = JSON.parse(xhr.responseText) as ApiFailure;
    return new Error(data.error?.message || `${fallback} (${xhr.status})`);
  } catch {
    return new Error(`${fallback} (${xhr.status || "网络错误"})`);
  }
}

function putBlobWithProgress(
  url: string,
  body: Blob,
  onProgress: (uploadedBytes: number) => void,
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.addEventListener("progress", (event) => {
      onProgress(Math.min(event.loaded, body.size));
    });
    xhr.addEventListener("load", () => {
      onProgress(body.size);
      resolve(xhr);
    });
    xhr.addEventListener("error", () => {
      reject(new Error("上传连接中断，请检查网络后重试。"));
    });
    xhr.addEventListener("abort", () => {
      reject(new Error("上传已取消。"));
    });
    xhr.send(body);
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function fileKind(file: Pick<DriveFile, "kind" | "name" | "contentType">): {
  label: string;
  category: "folder" | "image" | "document" | "video" | "audio" | "archive" | "other";
} {
  if (file.kind === "folder") return { label: "文件夹", category: "folder" };
  const type = (file.contentType || "").toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic"].includes(extension)) {
    return { label: `${extension.toUpperCase() || "图片"} 图片`, category: "image" };
  }
  if (type.startsWith("video/") || ["mp4", "mov", "mkv", "webm"].includes(extension)) {
    return { label: `${extension.toUpperCase() || "视频"} 视频`, category: "video" };
  }
  if (type.startsWith("audio/") || ["mp3", "m4a", "wav", "flac", "aac"].includes(extension)) {
    return { label: `${extension.toUpperCase() || "音频"} 音频`, category: "audio" };
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) {
    return { label: `${extension.toUpperCase()} 压缩包`, category: "archive" };
  }
  if (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "md", "json"].includes(extension)
  ) {
    return {
      label: `${extension.toUpperCase() || "文档"} 文档`,
      category: "document",
    };
  }
  return { label: extension ? `${extension.toUpperCase()} 文件` : "文件", category: "other" };
}

function FileGlyph({ file }: { file: Pick<DriveFile, "kind" | "name" | "contentType"> }) {
  const kind = fileKind(file);
  const Icon =
    kind.category === "folder"
      ? Folder
      : kind.category === "image"
        ? ImageSquare
        : kind.category === "document"
          ? file.name.toLowerCase().endsWith(".pdf")
            ? FilePdf
            : FileText
          : kind.category === "video"
            ? VideoCamera
            : kind.category === "audio"
              ? MusicNotes
              : kind.category === "archive"
                ? FileArchive
                : FileIcon;
  return (
    <span className={`drive-file-glyph ${kind.category}`}>
      <Icon weight={kind.category === "folder" ? "fill" : "duotone"} />
    </span>
  );
}

function activeNavigation(scope: DriveScope) {
  if (scope === "recent") return "recent" as const;
  if (scope === "shared") return "shares" as const;
  if (scope === "trash") return "trash" as const;
  return "files" as const;
}

export function DriveClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const rawScope = searchParams.get("scope") as DriveScope | null;
  const scope = rawScope && validScopes.has(rawScope) ? rawScope : "all";
  const parentId = scope === "all" ? searchParams.get("parentId") : null;

  const [files, setFiles] = useState<DriveFile[]>([]);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([]);
  const [usage, setUsage] = useState({ used: 0, quota: 0 });
  const [search, setSearch] = useState("");
  const [effectiveSearch, setEffectiveSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<"name" | "size" | "updated">("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [folders, setFolders] = useState<DriveFile[]>([]);
  const [shareFile, setShareFile] = useState<DriveFile | null>(null);
  const [shareExpiry, setShareExpiry] = useState("168");
  const [shareLimit, setShareLimit] = useState("");
  const [createdShareUrl, setCreatedShareUrl] = useState("");
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedFiles = useMemo(
    () => files.filter((file) => selectedIds.includes(file.id)),
    [files, selectedIds],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (scope === "shared") {
        const [shareResponse, shortcutResponse] = await Promise.all([
          fetch("/api/shares"),
          fetch("/api/files?scope=pinned"),
        ]);
        if (!shareResponse.ok) throw await responseError(shareResponse);
        if (!shortcutResponse.ok) throw await responseError(shortcutResponse);
        const shareData = (await shareResponse.json()) as { shares: ShareRow[] };
        const shortcutData = (await shortcutResponse.json()) as {
          shortcuts: Shortcut[];
          usage: { used: number; quota: number };
        };
        setShares(shareData.shares);
        setShortcuts(shortcutData.shortcuts);
        setUsage(shortcutData.usage);
        setFiles([]);
        setBreadcrumbs([]);
      } else {
        const query = new URLSearchParams({
          scope,
          sort,
          order,
        });
        if (parentId) query.set("parentId", parentId);
        if (effectiveSearch) query.set("search", effectiveSearch);
        const response = await fetch(`/api/files?${query.toString()}`);
        if (!response.ok) throw await responseError(response);
        const data = (await response.json()) as {
          files: DriveFile[];
          usage: { used: number; quota: number };
          breadcrumbs: Array<{ id: string; name: string }>;
          shortcuts: Shortcut[];
        };
        setFiles(data.files);
        setUsage(data.usage);
        setBreadcrumbs(data.breadcrumbs);
        setShortcuts(data.shortcuts);
        setShares([]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取文件。");
    } finally {
      setLoading(false);
    }
  }, [effectiveSearch, order, parentId, scope, sort]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadData();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadData]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setEffectiveSearch(search.trim()), 260);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const preferred = localStorage.getItem("r2drive-default-view");
      if (preferred === "grid") setView("grid");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/config", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const config = (await response.json()) as { sharingEnabled?: boolean };
        setSharingEnabled(config.sharingEnabled === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSelectedIds([]);
      setSearch("");
      setShareFile(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [scope, parentId]);

  function updateUpload(key: string, update: Partial<UploadItem>) {
    setUploads((items) =>
      items.map((item) => (item.key === key ? { ...item, ...update } : item)),
    );
  }

  async function uploadOne(file: File) {
    const key = crypto.randomUUID();
    setUploads((items) => [
      ...items,
      {
        key,
        name: file.name,
        progress: 0,
        uploadedBytes: 0,
        totalBytes: file.size,
        bytesPerSecond: 0,
        status: "running",
      },
    ]);
    let fileId = "";
    try {
      const uploadStartedAt = performance.now();
      const uploadedByPart = new Map<number, number>();
      let uploadedBytes = 0;
      function reportPartProgress(
        partNumber: number,
        partBytes: number,
        nextUploadedBytes: number,
      ) {
        const previous = uploadedByPart.get(partNumber) || 0;
        const current = Math.max(
          previous,
          Math.min(Math.max(nextUploadedBytes, 0), partBytes),
        );
        if (current <= previous) return;
        uploadedByPart.set(partNumber, current);
        uploadedBytes = Math.min(file.size, uploadedBytes + current - previous);
        const elapsedSeconds = Math.max(
          (performance.now() - uploadStartedAt) / 1000,
          0.25,
        );
        updateUpload(key, {
          progress: Math.min(99.9, (uploadedBytes / file.size) * 100),
          uploadedBytes,
          bytesPerSecond: uploadedBytes / elapsedSeconds,
        });
      }

      const networkProfile =
        localStorage.getItem("r2drive-network-profile") || "balanced";
      const partSizeHintBytes =
        networkProfile === "stable"
          ? 16 * 1024 ** 2
          : networkProfile === "throughput"
            ? 80 * 1024 ** 2
            : 64 * 1024 ** 2;
      const startResponse = await fetch("/api/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
          parentId,
          partSizeHintBytes,
        }),
      });
      if (!startResponse.ok) throw await responseError(startResponse);
      const plan = (await startResponse.json()) as {
        fileId: string;
        partSize: number;
        expectedParts: number;
        direct: boolean;
        storageFallback?: boolean;
      };
      fileId = plan.fileId;
      if (plan.storageFallback) {
        updateUpload(key, {
          message: "附加节点暂不可用，已自动回退主 R2",
        });
      }
      const completed: Array<{ partNumber: number; etag: string }> = [];
      const partNumbers = Array.from(
        { length: plan.expectedParts },
        (_, index) => index + 1,
      );
      let cursor = 0;
      const preferredConcurrency = Number(
        localStorage.getItem("r2drive-upload-concurrency") || 3,
      );
      const concurrency = Math.min(
        Math.max(
          Number.isFinite(preferredConcurrency) ? preferredConcurrency : 3,
          1,
        ),
        8,
        plan.expectedParts,
      );

      async function uploadProxyPart(partNumber: number, body: Blob): Promise<string> {
        const xhr = await putBlobWithProgress(
          `/api/uploads/${fileId}/parts/${partNumber}`,
          body,
          (loaded) => reportPartProgress(partNumber, body.size, loaded),
        );
        if (xhr.status < 200 || xhr.status >= 300) {
          throw xhrResponseError(xhr, "分片上传失败");
        }
        try {
          const etag = (JSON.parse(xhr.responseText) as { etag?: string }).etag;
          if (!etag) throw new Error("missing etag");
          return etag;
        } catch {
          throw new Error("上传服务没有返回有效的分片编号。");
        }
      }

      async function uploadDirectPart(partNumber: number, body: Blob): Promise<string> {
        const signResponse = await fetch(
          `/api/uploads/${fileId}/parts/${partNumber}/sign`,
          { method: "POST" },
        );
        if (!signResponse.ok) throw await responseError(signResponse);
        const signed = (await signResponse.json()) as { url: string };
        const xhr = await putBlobWithProgress(
          signed.url,
          body,
          (loaded) => reportPartProgress(partNumber, body.size, loaded),
        );
        if (xhr.status < 200 || xhr.status >= 300) {
          throw new Error(`R2 分片 ${partNumber} 上传失败 (${xhr.status})`);
        }
        const etag = xhr.getResponseHeader("etag") || "";
        if (!etag) {
          throw new Error("R2 未返回 ETag；请在 R2 CORS 中暴露 ETag 响应头。");
        }
        return etag;
      }

      async function uploadPart(partNumber: number, body: Blob): Promise<string> {
        let lastError: unknown;
        if (plan.direct) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              return await uploadDirectPart(partNumber, body);
            } catch (error) {
              lastError = error;
              await wait(600 * 2 ** attempt);
            }
          }
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            return await uploadProxyPart(partNumber, body);
          } catch (error) {
            lastError = error;
            if (attempt < 2) await wait(700 * 2 ** attempt);
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(`分片 ${partNumber} 上传失败。`);
      }

      async function worker() {
        while (cursor < partNumbers.length) {
          const partNumber = partNumbers[cursor];
          cursor += 1;
          const start = (partNumber - 1) * plan.partSize;
          const body = file.slice(
            start,
            Math.min(start + plan.partSize, file.size),
          );
          const etag = await uploadPart(partNumber, body);
          reportPartProgress(partNumber, body.size, body.size);
          completed.push({ partNumber, etag });
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      updateUpload(key, {
        progress: 99.9,
        uploadedBytes: file.size,
        message: "正在确认文件完整性",
      });
      let completeResponse: Response | null = null;
      const completeBody = JSON.stringify({ parts: completed });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        completeResponse = await fetch(`/api/uploads/${fileId}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: completeBody,
        });
        if (completeResponse.ok || completeResponse.status < 500) break;
        if (attempt < 2) await wait(800 * 2 ** attempt);
      }
      if (!completeResponse) {
        throw new Error("上传服务没有返回完成状态。");
      }
      if (!completeResponse.ok) throw await responseError(completeResponse);
      updateUpload(key, {
        progress: 100,
        uploadedBytes: file.size,
        status: "done",
        message: "上传完成",
      });
      await loadData();
    } catch (error) {
      if (fileId) {
        await fetch(`/api/uploads/${fileId}/abort`, {
          method: "POST",
        }).catch(() => undefined);
      }
      updateUpload(key, {
        status: "error",
        message: error instanceof Error ? error.message : "上传失败",
      });
    }
  }

  async function chooseFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      if (file.size === 0) {
        setNotice(`“${file.name}” 是空文件；当前版本仅接受非空文件。`);
        continue;
      }
      void uploadOne(file);
    }
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (scope !== "all") {
      setNotice("请先进入“我的文件”再上传。");
      return;
    }
    void chooseFiles(event.dataTransfer.files);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selected) => selected !== id)
        : [...current, id],
    );
  }

  function selectAll() {
    setSelectedIds((current) =>
      current.length === files.length ? [] : files.map((file) => file.id),
    );
  }

  function openFolder(file: DriveFile | Shortcut) {
    if (file.kind !== "folder") return;
    router.push(`/drive?parentId=${encodeURIComponent(file.id)}`);
  }

  async function saveEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !editor.name.trim()) return;
    setBusy(true);
    try {
      const response =
        editor.kind === "create"
          ? await fetch("/api/files", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: editor.name, parentId }),
            })
          : await fetch(`/api/files/${editor.file.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: editor.name }),
            });
      if (!response.ok) throw await responseError(response);
      setEditor(null);
      await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(file: DriveFile) {
    const response = await fetch(`/api/files/${file.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPinned: !file.isPinned }),
    });
    if (!response.ok) setNotice((await responseError(response)).message);
    else await loadData();
  }

  async function executeConfirmation() {
    if (!confirmState) return;
    setBusy(true);
    try {
      if (confirmState.kind === "empty-trash") {
        const response = await fetch("/api/files?scope=trash", {
          method: "DELETE",
        });
        if (!response.ok) throw await responseError(response);
      } else {
        for (const file of confirmState.files) {
          const suffix =
            confirmState.kind === "permanent" ? "?permanent=true" : "";
          const response = await fetch(`/api/files/${file.id}${suffix}`, {
            method: "DELETE",
          });
          if (!response.ok) throw await responseError(response);
        }
      }
      setConfirmState(null);
      setSelectedIds([]);
      await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function restore(filesToRestore: DriveFile[]) {
    setBusy(true);
    try {
      for (const file of filesToRestore) {
        const response = await fetch(`/api/files/${file.id}/restore`, {
          method: "POST",
        });
        if (!response.ok) throw await responseError(response);
      }
      setSelectedIds([]);
      await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复失败。");
    } finally {
      setBusy(false);
    }
  }

  async function openMove(filesToMove: DriveFile[]) {
    setSelectedIds(filesToMove.map((file) => file.id));
    const response = await fetch("/api/files?scope=folders&sort=name");
    if (!response.ok) {
      setNotice((await responseError(response)).message);
      return;
    }
    const data = (await response.json()) as { files: DriveFile[] };
    setFolders(data.files);
    setMoveTarget("");
    setMoveOpen(true);
  }

  async function moveSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      for (const file of selectedFiles) {
        const response = await fetch(`/api/files/${file.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentId: moveTarget || null }),
        });
        if (!response.ok) throw await responseError(response);
      }
      setMoveOpen(false);
      setSelectedIds([]);
      await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "移动失败。");
    } finally {
      setBusy(false);
    }
  }

  function openShare(file: DriveFile) {
    if (!sharingEnabled) {
      setNotice("分享已关闭。请先到管理页面绑定自己的域名。");
      return;
    }
    setShareFile(file);
    setShareExpiry("168");
    setShareLimit("");
    setCreatedShareUrl("");
  }

  async function createShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shareFile) return;
    setBusy(true);
    try {
      const response = await fetch("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileId: shareFile.id,
          expiresInHours: shareExpiry === "never" ? null : Number(shareExpiry),
          maxDownloads: shareLimit ? Number(shareLimit) : null,
        }),
      });
      if (!response.ok) throw await responseError(response);
      const data = (await response.json()) as { url: string };
      setCreatedShareUrl(data.url);
      await navigator.clipboard.writeText(data.url).catch(() => undefined);
      if (scope === "shared") await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建分享失败。");
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(id: string) {
    const response = await fetch(`/api/shares/${id}`, { method: "DELETE" });
    if (!response.ok) setNotice((await responseError(response)).message);
    else await loadData();
  }

  function changeSort(nextSort: "name" | "size" | "updated") {
    if (sort === nextSort) setOrder((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSort(nextSort);
      setOrder(nextSort === "updated" ? "desc" : "asc");
    }
  }

  const canUpload = scope === "all";
  const pageTitle = effectiveSearch ? `搜索“${effectiveSearch}”` : scopeLabels[scope];

  return (
    <AppShell
      title={pageTitle}
      activeNav={activeNavigation(scope)}
      hideHeader
      showStorageMeter={false}
      contentClassName="drive-app-content"
    >
      {(user) => (
        <div
          className={`drive-v2 ${dragging ? "is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={drop}
        >
          <DriveCategoryRail
            scope={scope}
            shortcuts={shortcuts}
            usage={usage.quota ? usage : { used: user.storageUsed, quota: user.storageQuota }}
            onShortcut={openFolder}
          />

          <section className="drive-main-pane" aria-label={pageTitle}>
            <header className="drive-command-bar">
              <div className="drive-primary-actions">
                <button
                  className="button drive-upload-button"
                  onClick={() => inputRef.current?.click()}
                  disabled={!canUpload}
                  title={canUpload ? "上传文件" : "请先进入我的文件"}
                >
                  <UploadSimple weight="bold" /> 上传
                </button>
                <button
                  className="button drive-new-folder-button"
                  onClick={() => setEditor({ kind: "create", name: "新建文件夹" })}
                  disabled={!canUpload}
                >
                  <FolderPlus /> 新建文件夹
                </button>
              </div>
              <label className="drive-global-search">
                <MagnifyingGlass />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索文件或文件夹"
                />
                {search && (
                  <button onClick={() => setSearch("")} aria-label="清除搜索">
                    <X />
                  </button>
                )}
              </label>
              <div className="drive-view-toggle" aria-label="文件视图">
                <button
                  className={view === "list" ? "active" : ""}
                  onClick={() => setView("list")}
                  aria-label="列表视图"
                >
                  <List />
                </button>
                <button
                  className={view === "grid" ? "active" : ""}
                  onClick={() => setView("grid")}
                  aria-label="网格视图"
                >
                  <GridFour />
                </button>
              </div>
            </header>

            {notice && (
              <div className="notice-bar drive-notice" role="status">
                <span>{notice}</span>
                <button onClick={() => setNotice("")} aria-label="关闭">
                  <X />
                </button>
              </div>
            )}

            <div className="drive-context-bar">
              <div className="drive-breadcrumbs">
                <button onClick={() => router.push("/drive")}>我的文件</button>
                {breadcrumbs.map((item) => (
                  <span key={item.id}>
                    <CaretRight />
                    <button
                      onClick={() =>
                        router.push(`/drive?parentId=${encodeURIComponent(item.id)}`)
                      }
                    >
                      {item.name}
                    </button>
                  </span>
                ))}
                {scope !== "all" && (
                  <span>
                    <CaretRight />
                    <strong>{scopeLabels[scope]}</strong>
                  </span>
                )}
              </div>
              {scope === "trash" && files.length > 0 && (
                <button
                  className="text-action danger"
                  onClick={() => setConfirmState({ kind: "empty-trash", files: [] })}
                >
                  清空回收站
                </button>
              )}
            </div>

            {selectedFiles.length > 0 && scope !== "shared" && (
              <SelectionBar
                files={selectedFiles}
                scope={scope}
                sharingEnabled={sharingEnabled}
                onClear={() => setSelectedIds([])}
                onShare={(file) => openShare(file)}
                onMove={() => void openMove(selectedFiles)}
                onTrash={() =>
                  setConfirmState({ kind: "trash", files: selectedFiles })
                }
                onRestore={() => void restore(selectedFiles)}
                onPermanent={() =>
                  setConfirmState({ kind: "permanent", files: selectedFiles })
                }
              />
            )}

            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                if (event.target.files) void chooseFiles(event.target.files);
                event.target.value = "";
              }}
            />

            {scope === "shared" ? (
              <ShareManager
                shares={shares}
                loading={loading}
                sharingEnabled={sharingEnabled}
                onCopy={(url) => {
                  void navigator.clipboard
                    .writeText(url)
                    .then(() => setNotice("分享链接已复制。"))
                    .catch(() => setNotice("复制失败，请选中链接后手动复制。"));
                }}
                onRevoke={(id) => void revokeShare(id)}
                onReshare={(share) =>
                  openShare({
                    id: share.fileId,
                    parentId: null,
                    kind: "file",
                    name: share.fileName,
                    size: share.size,
                    contentType: share.contentType,
                    isPinned: false,
                    status: "ready",
                    createdAt: share.createdAt,
                    updatedAt: share.createdAt,
                    deletedAt: null,
                  })
                }
              />
            ) : (
              <FileBrowser
                files={files}
                loading={loading}
                scope={scope}
                view={view}
                sort={sort}
                order={order}
                selectedIds={selectedIds}
                search={effectiveSearch}
                sharingEnabled={sharingEnabled}
                onSelect={toggleSelected}
                onSelectAll={selectAll}
                onSort={changeSort}
                onOpen={openFolder}
                onShare={openShare}
                onRename={(file) =>
                  setEditor({ kind: "rename", file, name: file.name })
                }
                onMove={(file) => void openMove([file])}
                onPin={(file) => void togglePin(file)}
                onTrash={(file) =>
                  setConfirmState({ kind: "trash", files: [file] })
                }
                onRestore={(file) => void restore([file])}
                onPermanent={(file) =>
                  setConfirmState({ kind: "permanent", files: [file] })
                }
              />
            )}

            <footer className="drive-list-footer">
              <span>{scope === "shared" ? shares.length : files.length} 项</span>
              <span>已使用 {formatBytes(usage.used)} / {formatBytes(usage.quota)}</span>
            </footer>
          </section>

          {dragging && (
            <div className="drive-drop-overlay">
              <CloudArrowUp />
              <strong>释放以上传到当前位置</strong>
              <span>支持多文件和 R2 Multipart 大文件分片</span>
            </div>
          )}

          {uploads.length > 0 && (
            <UploadQueue
              uploads={uploads}
              onClear={() =>
                setUploads((items) =>
                  items.filter((item) => item.status === "running"),
                )
              }
            />
          )}

          {editor && (
            <Dialog title={editor.kind === "create" ? "新建文件夹" : "重命名"} onClose={() => setEditor(null)}>
              <form className="drive-dialog-form" onSubmit={saveEditor}>
                <label>
                  <span>名称</span>
                  <input
                    autoFocus
                    value={editor.name}
                    onChange={(event) =>
                      setEditor(
                        editor.kind === "create"
                          ? { ...editor, name: event.target.value }
                          : { ...editor, name: event.target.value },
                      )
                    }
                    required
                    maxLength={255}
                  />
                </label>
                <div className="drive-dialog-actions">
                  <button className="button button-secondary" type="button" onClick={() => setEditor(null)}>
                    取消
                  </button>
                  <button className="button button-primary" disabled={busy}>
                    <Check /> 保存
                  </button>
                </div>
              </form>
            </Dialog>
          )}

          {moveOpen && (
            <Dialog title={`移动 ${selectedFiles.length} 个项目`} onClose={() => setMoveOpen(false)}>
              <form className="drive-dialog-form" onSubmit={moveSelected}>
                <label>
                  <span>目标文件夹</span>
                  <select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
                    <option value="">我的文件（根目录）</option>
                    {folders
                      .filter((folder) => !selectedIds.includes(folder.id))
                      .map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="drive-dialog-help">
                  文件夹不能移动到自身或自己的子文件夹，服务端会再次校验。
                </p>
                <div className="drive-dialog-actions">
                  <button className="button button-secondary" type="button" onClick={() => setMoveOpen(false)}>
                    取消
                  </button>
                  <button className="button button-primary" disabled={busy}>
                    移动
                  </button>
                </div>
              </form>
            </Dialog>
          )}

          {confirmState && (
            <Dialog
              title={
                confirmState.kind === "trash"
                  ? "移入回收站"
                  : confirmState.kind === "permanent"
                    ? "永久删除"
                    : "清空回收站"
              }
              onClose={() => setConfirmState(null)}
            >
              <div className="drive-confirm-copy">
                <WarningCircle weight="duotone" />
                <p>
                  {confirmState.kind === "trash"
                    ? `将 ${confirmState.files.length} 个项目移入回收站。对象仍占用存储空间，可稍后恢复。`
                    : confirmState.kind === "permanent"
                      ? `将永久删除 ${confirmState.files.length} 个项目及其中所有内容，R2 对象无法恢复。`
                      : "将永久删除回收站中的全部对象，此操作无法恢复。"}
                </p>
              </div>
              <div className="drive-dialog-actions">
                <button className="button button-secondary" onClick={() => setConfirmState(null)}>
                  取消
                </button>
                <button className="button button-danger" onClick={() => void executeConfirmation()} disabled={busy}>
                  {confirmState.kind === "trash" ? "移入回收站" : "永久删除"}
                </button>
              </div>
            </Dialog>
          )}

          {shareFile && (
            <ShareDrawer
              file={shareFile}
              expiry={shareExpiry}
              limit={shareLimit}
              createdUrl={createdShareUrl}
              busy={busy}
              onExpiry={setShareExpiry}
              onLimit={setShareLimit}
              onSubmit={createShare}
              onClose={() => setShareFile(null)}
            />
          )}
        </div>
      )}
    </AppShell>
  );
}

function DriveCategoryRail({
  scope,
  shortcuts,
  usage,
  onShortcut,
}: {
  scope: DriveScope;
  shortcuts: Shortcut[];
  usage: { used: number; quota: number };
  onShortcut: (file: Shortcut) => void;
}) {
  const categories = [
    { scope: "all", label: "我的文件", icon: FolderOpen },
    { scope: "image", label: "图片", icon: ImageSquare },
    { scope: "document", label: "文档", icon: FileText },
    { scope: "video", label: "视频", icon: VideoCamera },
    { scope: "audio", label: "音频", icon: MusicNotes },
    { scope: "other", label: "其他", icon: Archive },
  ] as const;
  const usedPercent = usage.quota
    ? Math.min((usage.used / usage.quota) * 100, 100)
    : 0;
  return (
    <aside className="drive-category-rail">
      <nav aria-label="文件分类">
        {categories.map((item) => {
          const Icon = item.icon;
          const href = item.scope === "all" ? "/drive" : `/drive?scope=${item.scope}`;
          return (
            <Link
              key={item.scope}
              href={href}
              className={scope === item.scope ? "active" : ""}
            >
              <Icon weight={scope === item.scope ? "fill" : "regular"} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <section className="drive-shortcuts">
        <h2>快捷访问</h2>
        {shortcuts.length === 0 ? (
          <p>在文件操作中选择“固定”，常用项目会出现在这里。</p>
        ) : (
          shortcuts.map((file) =>
            file.kind === "folder" ? (
              <button key={file.id} onClick={() => onShortcut(file)}>
                <Folder weight="fill" />
                <span>{file.name}</span>
              </button>
            ) : (
              <a key={file.id} href={`/api/files/${file.id}/download`}>
                <FileIcon />
                <span>{file.name}</span>
              </a>
            ),
          )
        )}
      </section>
      <section className="drive-capacity">
        <div>
          <span>存储空间</span>
          <strong>{usedPercent.toFixed(0)}%</strong>
        </div>
        <div className="meter-track">
          <i style={{ width: `${usedPercent}%` }} />
        </div>
        <p>{formatBytes(usage.used)} / {formatBytes(usage.quota)}</p>
      </section>
    </aside>
  );
}

function SelectionBar({
  files,
  scope,
  sharingEnabled,
  onClear,
  onShare,
  onMove,
  onTrash,
  onRestore,
  onPermanent,
}: {
  files: DriveFile[];
  scope: DriveScope;
  sharingEnabled: boolean;
  onClear: () => void;
  onShare: (file: DriveFile) => void;
  onMove: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onPermanent: () => void;
}) {
  const oneFile = files.length === 1 && files[0].kind === "file" ? files[0] : null;
  return (
    <div className="drive-selection-bar">
      <button onClick={onClear} aria-label="取消选择"><X /></button>
      <strong>已选择 {files.length} 项</strong>
      {scope === "trash" ? (
        <>
          <button onClick={onRestore}><ArrowCounterClockwise /> 恢复</button>
          <button className="danger" onClick={onPermanent}><Trash /> 永久删除</button>
        </>
      ) : (
        <>
          {oneFile && (
            <a href={`/api/files/${oneFile.id}/download`}><DownloadSimple /> 下载</a>
          )}
          {oneFile && sharingEnabled && <button onClick={() => onShare(oneFile)}><ShareNetwork /> 分享</button>}
          <button onClick={onMove}><FolderOpen /> 移动</button>
          <button className="danger" onClick={onTrash}><Trash /> 移入回收站</button>
        </>
      )}
    </div>
  );
}

function FileBrowser({
  files,
  loading,
  scope,
  view,
  sort,
  order,
  selectedIds,
  search,
  sharingEnabled,
  onSelect,
  onSelectAll,
  onSort,
  onOpen,
  onShare,
  onRename,
  onMove,
  onPin,
  onTrash,
  onRestore,
  onPermanent,
}: {
  files: DriveFile[];
  loading: boolean;
  scope: DriveScope;
  view: "list" | "grid";
  sort: "name" | "size" | "updated";
  order: "asc" | "desc";
  selectedIds: string[];
  search: string;
  sharingEnabled: boolean;
  onSelect: (id: string) => void;
  onSelectAll: () => void;
  onSort: (sort: "name" | "size" | "updated") => void;
  onOpen: (file: DriveFile) => void;
  onShare: (file: DriveFile) => void;
  onRename: (file: DriveFile) => void;
  onMove: (file: DriveFile) => void;
  onPin: (file: DriveFile) => void;
  onTrash: (file: DriveFile) => void;
  onRestore: (file: DriveFile) => void;
  onPermanent: (file: DriveFile) => void;
}) {
  const SortIcon = order === "asc" ? SortAscending : SortDescending;
  if (loading) {
    return (
      <div className="drive-loading" aria-label="正在读取文件">
        {Array.from({ length: 7 }, (_, index) => <i key={index} />)}
      </div>
    );
  }
  if (!files.length) {
    return (
      <div className="drive-empty-state">
        {scope === "trash" ? <Trash /> : search ? <MagnifyingGlass /> : <FolderOpen />}
        <h2>{scope === "trash" ? "回收站是空的" : search ? "没有匹配的项目" : "这里还没有文件"}</h2>
        <p>
          {scope === "trash"
            ? "移入回收站的文件会保留在这里，直到你永久删除。"
            : search
              ? "尝试更短的关键词，搜索会覆盖整个网盘。"
              : scope === "all"
                ? "上传文件或新建文件夹开始整理。"
                : "此分类暂时没有内容。"}
        </p>
      </div>
    );
  }
  return (
    <div className={`drive-file-browser ${view === "grid" ? "grid" : "list"}`}>
      {view === "list" && (
        <div className="drive-file-head">
          <label>
            <input
              type="checkbox"
              checked={selectedIds.length === files.length && files.length > 0}
              onChange={onSelectAll}
              aria-label="全选"
            />
          </label>
          <button onClick={() => onSort("name")}>
            文件名 {sort === "name" && <SortIcon />}
          </button>
          <button onClick={() => onSort("size")}>
            大小 {sort === "size" && <SortIcon />}
          </button>
          <span>类型</span>
          <button onClick={() => onSort("updated")}>
            {scope === "trash" ? "删除时间" : "修改时间"} {sort === "updated" && <SortIcon />}
          </button>
          <span>操作</span>
        </div>
      )}
      <div className="drive-file-items">
        {files.map((file) => {
          const selected = selectedIds.includes(file.id);
          const kind = fileKind(file);
          return (
            <article className={`drive-file-row ${selected ? "selected" : ""}`} key={file.id}>
              <label className="drive-file-check">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onSelect(file.id)}
                  aria-label={`选择 ${file.name}`}
                />
              </label>
              <button
                className="drive-file-name"
                onClick={() => onOpen(file)}
                disabled={file.kind !== "folder"}
              >
                <FileGlyph file={file} />
                <span>
                  <strong>{file.name}</strong>
                  {view === "grid" && <small>{kind.label} · {formatBytes(file.size)}</small>}
                </span>
              </button>
              <span className="drive-file-size">{file.kind === "folder" ? "—" : formatBytes(file.size)}</span>
              <span className="drive-file-type">{kind.label}</span>
              <time>{formatDate(scope === "trash" ? file.deletedAt : file.updatedAt)}</time>
              <div className="drive-row-actions">
                {scope === "trash" ? (
                  <>
                    <button onClick={() => onRestore(file)} title="恢复"><ArrowCounterClockwise /></button>
                    <button className="danger" onClick={() => onPermanent(file)} title="永久删除"><Trash /></button>
                  </>
                ) : (
                  <>
                    {file.kind === "file" && (
                      <a href={`/api/files/${file.id}/download`} title="下载"><DownloadSimple /></a>
                    )}
                    {file.kind === "file" && sharingEnabled && <button onClick={() => onShare(file)} title="分享"><ShareNetwork /></button>}
                    <button onClick={() => onRename(file)} title="重命名"><PencilSimple /></button>
                    <button onClick={() => onMove(file)} title="移动"><FolderOpen /></button>
                    <button onClick={() => onPin(file)} title={file.isPinned ? "取消固定" : "固定到快捷访问"}>
                      <PushPin weight={file.isPinned ? "fill" : "regular"} />
                    </button>
                    <button className="danger" onClick={() => onTrash(file)} title="移入回收站"><Trash /></button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ShareManager({
  shares,
  loading,
  sharingEnabled,
  onCopy,
  onRevoke,
  onReshare,
}: {
  shares: ShareRow[];
  loading: boolean;
  sharingEnabled: boolean;
  onCopy: (url: string) => void;
  onRevoke: (id: string) => void;
  onReshare: (share: ShareRow) => void;
}) {
  if (loading) return <div className="drive-loading">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>;
  if (!sharingEnabled) {
    return (
      <div className="drive-empty-state drive-sharing-disabled">
        <WarningCircle />
        <h2>公开分享尚未开启</h2>
        <p>绑定自己的域名并完成发布后，才能创建可供别人下载的链接。</p>
        <Link className="button button-primary" href="/admin">
          前往管理页面绑定域名
        </Link>
      </div>
    );
  }
  if (!shares.length) {
    return (
      <div className="drive-empty-state">
        <ShareNetwork />
        <h2>还没有分享记录</h2>
        <p>在文件右侧选择“分享”，创建允许他人直接下载的公开链接。</p>
      </div>
    );
  }
  return (
    <div className="drive-share-list">
      <div className="drive-share-head">
        <span>文件</span><span>状态</span><span>下载</span><span>有效期</span><span>操作</span>
      </div>
      {shares.map((share) => (
        <article key={share.id}>
          <div>
            <FileGlyph file={{ kind: "file", name: share.fileName, contentType: share.contentType }} />
            <span>
              <strong>{share.fileName}</strong>
              <small>{formatBytes(share.size)}</small>
              {share.url ? (
                <input
                  className="drive-share-url"
                  aria-label={`${share.fileName} 的分享链接`}
                  readOnly
                  value={share.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              ) : (
                <small>旧版链接无法恢复，请重新创建一次。</small>
              )}
            </span>
          </div>
          <span className={`share-status ${share.status}`}>
            {share.status === "active" ? "有效" : share.status === "expired" ? "已过期" : "次数已用完"}
          </span>
          <span>{share.downloadCount}{share.maxDownloads === null ? " 次" : ` / ${share.maxDownloads} 次`}</span>
          <span>{share.expiresAt ? formatDate(share.expiresAt) : "长期有效"}</span>
          <div>
            {share.url ? (
              <button onClick={() => onCopy(share.url!)}><Copy /> 复制链接</button>
            ) : (
              <button onClick={() => onReshare(share)}><LinkSimple /> 重新创建</button>
            )}
            <button className="danger" onClick={() => onRevoke(share.id)}><X /> 撤销</button>
          </div>
        </article>
      ))}
      <p className="drive-share-security-note">
        分享链接会保留在当前网盘中，可随时回来查看和复制；过期或撤销后链接将无法下载。
      </p>
    </div>
  );
}

function UploadQueue({
  uploads,
  onClear,
}: {
  uploads: UploadItem[];
  onClear: () => void;
}) {
  return (
    <section className="drive-upload-queue">
      <header>
        <div><strong>上传任务</strong><span>{uploads.filter((item) => item.status === "running").length} 个进行中</span></div>
        <button onClick={onClear}>清除已完成</button>
      </header>
      {uploads.map((item) => (
        <div className="drive-upload-row" key={item.key}>
          {item.status === "done" ? <CheckCircle weight="fill" /> : item.status === "error" ? <WarningCircle weight="fill" /> : <CloudArrowUp />}
          <div>
            <p>
              <strong>{item.name}</strong>
              <span>{formatUploadPercent(item.progress)}</span>
            </p>
            <div
              className="progress-track"
              role="progressbar"
              aria-label={`${item.name} 上传进度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(item.progress)}
            >
              <i style={{ width: `${item.progress}%` }} />
            </div>
            <div className={`drive-upload-meta ${item.status}`}>
              <span>
                {item.message ||
                  `${formatUploadBytes(item.uploadedBytes)} / ${formatUploadBytes(item.totalBytes)}`}
              </span>
              {item.status === "running" && item.bytesPerSecond > 0 && (
                <span>{formatUploadBytes(item.bytesPerSecond)}/s</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="drive-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="drive-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header><h2>{title}</h2><button onClick={onClose} aria-label="关闭"><X /></button></header>
        {children}
      </section>
    </div>
  );
}

function ShareDrawer({
  file,
  expiry,
  limit,
  createdUrl,
  busy,
  onExpiry,
  onLimit,
  onSubmit,
  onClose,
}: {
  file: DriveFile;
  expiry: string;
  limit: string;
  createdUrl: string;
  busy: boolean;
  onExpiry: (value: string) => void;
  onLimit: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  return (
    <aside className="drive-share-drawer" aria-label={`分享 ${file.name}`}>
      <header>
        <div><p>创建下载链接</p><h2>{file.name}</h2></div>
        <button onClick={onClose} aria-label="关闭"><X /></button>
      </header>
      <div className="drive-share-summary">
        <span><ShareNetwork weight="duotone" /></span>
        <div><strong>公开链接分享</strong><p>获得链接的人可直接下载此文件。</p></div>
      </div>
      <form onSubmit={onSubmit}>
        <label>
          <span>链接有效期</span>
          <select value={expiry} onChange={(event) => onExpiry(event.target.value)}>
            <option value="24">1 天</option>
            <option value="168">7 天</option>
            <option value="720">30 天</option>
            <option value="never">长期有效</option>
          </select>
        </label>
        <label>
          <span>最大下载次数（可选）</span>
          <input
            type="number"
            min={1}
            max={1_000_000}
            value={limit}
            onChange={(event) => onLimit(event.target.value)}
            placeholder="不限制"
          />
        </label>
        {createdUrl && (
          <div className="drive-share-result">
            <span>链接已创建并尝试复制</span>
            <div><input readOnly value={createdUrl} /><button type="button" onClick={() => navigator.clipboard.writeText(createdUrl)} aria-label="复制链接"><Copy /></button></div>
            <small>关闭后仍可在“分享”页面再次查看和复制此链接。</small>
          </div>
        )}
        <button className="button button-primary button-block" disabled={busy}>
          <LinkSimple /> {createdUrl ? "创建新链接" : "创建分享链接"}
        </button>
      </form>
    </aside>
  );
}
