import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CloudArrowUp,
  Database,
  Gauge,
  GithubLogo,
  GlobeHemisphereWest,
  LockKey,
  SlidersHorizontal,
} from "@phosphor-icons/react/dist/ssr";
import { UploadPlanner } from "@/components/UploadPlanner";

export const metadata: Metadata = {
  title: "开源 Cloudflare R2 网盘",
  description:
    "给主人自己使用的开源网盘，支持超大文件分片直传和公开分享下载，部署在你自己的 Cloudflare 账号。",
};

export default function Home() {
  return (
    <main className="marketing-shell">
      <nav className="topbar">
        <Link href="/" className="brand" aria-label="R2 Drive 首页">
          <span className="brand-mark">R2</span>
          <span>R2 Drive</span>
        </Link>
        <div className="nav-links" aria-label="主导航">
          <a href="#architecture">架构</a>
          <a href="#capabilities">能力</a>
          <a href="#china">网络优化</a>
          <Link href="/login" className="button button-secondary">登录</Link>
          <Link href="/register" className="button button-primary">创建主人账号 <ArrowRight /></Link>
        </div>
      </nav>

      <section className="hero section-rule">
        <div className="hero-copy">
          <p className="eyebrow">OPEN SOURCE · CLOUDFLARE NATIVE</p>
          <h1>你的对象存储，<br /><span>你的网盘。</span></h1>
          <p className="hero-lede">
            R2 Drive 是一套给自己使用的开源网盘。文件直接分片上传至 R2，
            元数据留在 D1，登录、分享与开发者 API 都由你掌控。
          </p>
          <div className="hero-actions">
            <Link href="/register" className="button button-primary button-large">
              创建主人账号 <ArrowRight />
            </Link>
            <a href="#architecture" className="button button-ghost">
              查看部署架构
            </a>
          </div>
          <div className="proof-row">
            <span><Check /> 最大约 4.995 TiB / 对象</span>
            <span><Check /> 最多 10,000 个分片</span>
            <span><Check /> 数据出口免流量费</span>
          </div>
        </div>
        <UploadPlanner />
      </section>

      <section className="metrics-strip" aria-label="核心能力">
        <div><strong>5 TiB</strong><span>R2 单对象量级</span></div>
        <div><strong>∞</strong><span>桶容量与对象数量</span></div>
        <div><strong>64 MiB</strong><span>默认自适应分片</span></div>
        <div><strong>0</strong><span>R2 公网出口费</span></div>
      </section>

      <section className="content-section section-rule" id="architecture">
        <div className="section-heading">
          <p className="eyebrow">ARCHITECTURE</p>
          <h2>边缘只做控制，数据直接进桶。</h2>
          <p>控制面与数据面分离，避免让超大文件穿过 Worker 请求体限制。</p>
        </div>
        <div className="architecture-flow">
          <article>
            <span className="step-index">01</span>
            <CloudArrowUp />
            <h3>浏览器分片</h3>
            <p>按文件大小自动计算分片，保持在 R2 的 10,000 分片边界内。</p>
          </article>
          <span className="flow-arrow">→</span>
          <article>
            <span className="step-index">02</span>
            <LockKey />
            <h3>Worker 授权</h3>
            <p>验证用户、父目录和剩余配额，仅签发短期、单分片上传地址。</p>
          </article>
          <span className="flow-arrow">→</span>
          <article>
            <span className="step-index">03</span>
            <Database />
            <h3>R2 直传</h3>
            <p>文件流量不经过应用服务器；D1 只记录可查询的业务元数据。</p>
          </article>
        </div>
      </section>

      <section className="content-section capabilities-section section-rule" id="capabilities">
        <div className="section-heading split-heading">
          <div>
            <p className="eyebrow">ONE REPOSITORY, TWO EXPERIENCES</p>
            <h2>自己使用简单，所有数据可控。</h2>
          </div>
          <p>它不是上传演示。私人账号、空间策略、分享、审计与 API 都是完整产品能力。</p>
        </div>
        <div className="capability-grid">
          {[
            [GlobeHemisphereWest, "文件与分享", "拖放上传、文件夹、续传友好的分片任务、范围下载、到期与限次分享。"],
            [Gauge, "容量保护", "主人可设置界面容量，上传前会预留校验，避免任务超出设定。"],
            [SlidersHorizontal, "完整设置", "个人偏好、密码、API 令牌、分享缓存与网络模式都可管理。"],
            [LockKey, "默认安全", "HttpOnly 会话、同源写操作、哈希令牌、最小权限 R2 凭据与审计事件。"],
          ].map(([Icon, title, text]) => {
            const FeatureIcon = Icon as typeof LockKey;
            return (
              <article key={String(title)}>
                <FeatureIcon />
                <h3>{String(title)}</h3>
                <p>{String(text)}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="china-section section-rule" id="china">
        <div>
          <p className="eyebrow">PERSONAL-READY OPTIMIZATION</p>
          <h2>不用企业线路，也能把跨境传输做稳。</h2>
        </div>
        <div className="china-copy">
          <p>
            面向普通部署者，默认使用 Cloudflare 免费可开的 R2 Local Uploads、APAC 存储提示、
            Worker 代理回退、可调分片与失败重试。没有“神奇中国节点”，但每一项都能自己启用。
          </p>
          <div className="china-options">
            <span>R2 Local Uploads</span>
            <span>APAC Location Hint</span>
            <span>Worker Proxy Fallback</span>
            <span>HTTP/3 + Edge Cache</span>
          </div>
          <Link href="/register" className="text-link">进入个人部署配置 <ArrowRight /></Link>
        </div>
      </section>

      <footer className="site-footer">
        <div className="brand"><span className="brand-mark">R2</span><span>R2 Drive</span></div>
        <p>Cloudflare-native · Self-hosted · Open source</p>
        <a href="https://github.com/" className="footer-link"><GithubLogo /> GitHub</a>
      </footer>
    </main>
  );
}
