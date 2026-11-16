#!/usr/bin/env bash
# 调度中心启动脚本（云端 Linux 开发环境用；Windows 使用 start.bat）
# 服务只监听 127.0.0.1，端口默认 3210（被占用时自动顺延）。
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖..."
  npm install
fi
if [ ! -f dist/main.js ]; then
  echo "构建..."
  npm run build
fi
if [ ! -f config.json ]; then
  echo "尚未创建 config.json，已生成模板（config.example.json），请先填写大脑 API Key。"
  cp config.example.json config.json
fi

echo "启动调度中心（Ctrl+C 停止）..."
exec node dist/main.js
