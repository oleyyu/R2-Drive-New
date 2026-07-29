#!/usr/bin/env bash

set -o pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

pause_launcher() {
  printf "\n按回车键关闭窗口…"
  IFS= read -r _
}

show_node_help() {
  printf "\n未找到可用的 Node.js 22.13 或更高版本。\n"
  printf "已尝试打开 Node.js 官方下载页面。安装 LTS 版本后，再双击本文件。\n"
  open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
  pause_launcher
  exit 1
}

if [ -t 1 ]; then
  clear
fi
printf "====================================================\n"
printf " R2 Drive 小白启动器 · macOS\n"
printf "====================================================\n"
printf "这个窗口只在你的电脑上运行，不会把密钥发给项目作者。\n\n"

command -v node >/dev/null 2>&1 || show_node_help
command -v npm >/dev/null 2>&1 || show_node_help

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  show_node_help
fi

printf "Node.js %s 已就绪。\n" "$(node --version)"
printf "请选择打开网盘、配置、更新，或一键卸载当前实例。\n\n"

if ! node scripts/launcher.mjs; then
  printf "\nR2 Drive 启动器意外停止。请重新双击 R2-Drive.command 再试一次。\n"
  pause_launcher
  exit 1
fi

printf "\nR2 Drive 启动器已退出。下次需要时重新双击本文件即可。\n"
pause_launcher
