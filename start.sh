#!/usr/bin/env bash
# 调度中心启动脚本（Linux 与 Windows Git Bash 通用）。
# 流程：安装依赖 → 构建 → 生成 config 模板 → 启动服务 → 读 data/runtime.json 的端口与令牌
#       → 打开带令牌的界面地址（http://127.0.0.1:<port>/?token=<token>）。
# 环境变量：DISPATCH_NO_BROWSER=1 只启动服务不开浏览器；DISPATCH_DOWNLOAD_NOPROGRESS_MS
#       调小下载无进度窗口（仅调试用）。令牌每次启动随机生成，存于 data/runtime.json。
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

mkdir -p logs
echo "启动调度中心服务（日志：logs/start.log）..."
node dist/main.js > logs/start.log 2>&1 &
SERVER_PID=$!

cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup INT TERM

# 等待服务把端口与令牌写入 data/runtime.json（最多约 90 秒）
RT="data/runtime.json"
PORT=""
TOKEN=""
for i in $(seq 1 112); do
  if [ -f "$RT" ]; then
    PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port||'')}catch{console.log('')}" "$RT" 2>/dev/null || true)
    TOKEN=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token||'')}catch{console.log('')}" "$RT" 2>/dev/null || true)
    [ -n "$PORT" ] && break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "服务启动失败，日志末尾："
    tail -20 logs/start.log || true
    exit 1
  fi
  sleep 0.8
done

if [ -z "$PORT" ]; then
  echo "等待服务就绪超时，日志末尾："
  tail -20 logs/start.log || true
  exit 1
fi

URL="http://127.0.0.1:${PORT}/?token=${TOKEN}"
echo "调度中心已启动：$URL"
if [ "${DISPATCH_NO_BROWSER:-0}" != "1" ]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      explorer.exe "$URL" 2>/dev/null || cmd.exe /c start "" "$URL" 2>/dev/null || true ;;
    Darwin*)
      open "$URL" 2>/dev/null || true ;;
    *)
      xdg-open "$URL" 2>/dev/null || true ;;
  esac
fi
echo "按 Ctrl+C 停止服务。"
wait "$SERVER_PID"
