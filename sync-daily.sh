#!/bin/bash
# ARAM 后端每日数据同步脚本（由 cron 调用）
#
# 安装方法（在服务器 111.228.8.99 上）：
#   1) 把本文件放到 /opt/aram-backend/sync-daily.sh 并赋可执行权限：
#        chmod +x /opt/aram-backend/sync-daily.sh
#   2) 加入 crontab：
#        crontab -e
#      粘贴下面一行（注意时区，见下方说明）：
#        0 5 * * * /opt/aram-backend/sync-daily.sh
#   3) 验证：crontab -l
#
# ⚠️ 时区说明：cron 按服务器系统时区计时。
#    - 若服务器时区为 Asia/Shanghai（date 显示 CST），0 5 * * * 即北京时间 05:00。
#    - 若服务器为 UTC，想在北京时间 05:00 跑则改为：0 21 * * * /opt/aram-backend/sync-daily.sh
#    用 `date` 命令确认服务器时区。
#
# 失败排查：
#   - 完整日志：/opt/aram-backend/data/cron-sync.log（含报错堆栈）
#   - 状态摘要：/opt/aram-backend/data/sync-status.json
#   - 远程查看：浏览器/curl http://111.228.8.99:3000/api/sync-status

LOG=/opt/aram-backend/data/cron-sync.log
STATUS=/opt/aram-backend/data/sync-status.json
mkdir -p "$(dirname "$LOG")"

START=$(date '+%Y-%m-%d %H:%M:%S')
echo "=== [$START] 开始每日同步 ===" >> "$LOG"
cd /opt/aram-backend || {
  echo "❌ 无法进入 /opt/aram-backend" >> "$LOG"
  SYNC_END="$START" SYNC_OK="false" SYNC_ERR="无法进入 /opt/aram-backend" \
    node -e "const fs=require('fs');fs.writeFileSync('$STATUS',JSON.stringify({lastRun:process.env.SYNC_END,ok:false,error:process.env.SYNC_ERR||''}))"
  exit 1
}

# 运行同步，stdout/stderr 全部进日志
bash -lc 'npm run sync' >> "$LOG" 2>&1
RC=$?
END=$(date '+%Y-%m-%d %H:%M:%S')

if [ "$RC" -eq 0 ]; then
  echo "=== [$END] 同步成功 (exit=0) ===" >> "$LOG"
  SYNC_END="$END" SYNC_OK="true" SYNC_ERR="" \
    node -e "const fs=require('fs');fs.writeFileSync('$STATUS',JSON.stringify({lastRun:process.env.SYNC_END,ok:true,error:''}))"
else
  # 提取日志末尾错误片段（用于日志横幅 + 状态文件；JSON.stringify 保证合法 JSON）
  ERR=$(tail -n 30 "$LOG")
  echo "=== [$END] ❌ 同步失败 (exit=$RC) ===" >> "$LOG"
  echo "❌ 最近错误：" >> "$LOG"
  echo "$ERR" >> "$LOG"
  SYNC_END="$END" SYNC_OK="false" SYNC_EXIT="$RC" SYNC_ERR="$ERR" \
    node -e "const fs=require('fs');fs.writeFileSync('$STATUS',JSON.stringify({lastRun:process.env.SYNC_END,ok:false,exit:Number(process.env.SYNC_EXIT)||0,error:process.env.SYNC_ERR||''}))"
fi

exit $RC
