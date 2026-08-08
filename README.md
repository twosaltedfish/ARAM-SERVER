# ARAM 数据后端（aram-data-backend）

海克斯大乱斗（ARAM）英雄数据后端：定时从第三方数据源 `data.dtodo.cn` 拉取榜单 / 详情 / 装备 / 海克斯强化等数据，落本地 SQLite，向微信小程序提供查询接口，并提供别名管理、源数据查看等管理页面。

- 技术栈：Node.js（≥18） + Express + better-sqlite3 + pinyin-pro
- 数据源：`https://data.dtodo.cn/api/v1/zh-CN`（Bearer 鉴权，按 credits 计费）
- 进程管理：pm2
- 反向代理：nginx（小程序通过 `https://www.liceworld.online/api/...` 访问）

---

## 1. 目录结构

```
backend/
├── server.js              # Express 服务，对外提供所有查询/写入接口
├── fetch-data.js          # 数据同步主脚本（npm run sync）
├── sync-pinyin.js         # 仅重算 champions 表的拼音字段（不影响其他数据）
├── db.js                  # SQLite 初始化与建表、meta KV 读写
├── lib/
│   └── dtodo.js           # 第三方 API 客户端：多 Key 额度池、超时重试、归一化
├── public/                # 管理端静态页面（由 nginx /admin/ 托管）
│   ├── aliases.html       # 自定义英雄别名管理
│   └── source.html        # 单英雄源数据查看
├── scripts/
│   ├── fetch-one.js       # 调试：拉取单个英雄原始+归一化详情，保存到 tmp/
│   └── aggregate-tags.js  # 标签聚合脚本（详见脚本头部注释）
├── data/                  # 运行时生成：aram.db（SQLite）、cron 日志、sync-status.json
├── tmp/                   # 调试脚本输出目录
├── sync-daily.sh          # 每日 cron 调用的同步包装脚本（写日志+状态文件）
├── crontab.example        # cron 配置示例
├── nginx.example.conf     # nginx 反代配置示例
├── .env.example           # 环境变量样例（复制为 .env 填写）
└── package.json
```

---

## 2. 快速开始

```bash
cd backend
npm install                # 安装依赖（含 better-sqlite3 原生编译，需 Python/build 工具）

cp .env.example .env       # 填写 API Key 等配置
# 编辑 .env，至少填 DTODO_API_KEYS

npm run sync               # 首次拉取数据（写入 data/aram.db）
npm start                  # 启动服务，默认监听 3000
```

访问 `http://localhost:3000/health` 应返回 `{"ok":true,...}`。

---

## 3. 环境变量（.env）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DTODO_API_KEYS` | 空 | 第三方 API Key，**必填**。多 Key 用逗号分隔（`k1,k2`），顺序耗尽、自动切换，叠加每日额度。 |
| `DTODO_API_KEY` | 空 | 单 Key 兼容写法（与上面二选一）。 |
| `PORT` | `3000` | 服务监听端口。 |
| `DB_PATH` | `./data/aram.db` | SQLite 文件路径（可填绝对路径）。 |
| `FETCH_DETAILS` | `false` | 是否拉取每个英雄详情（`/champions/{id}.json`）。开启后全量约 349 credits，需多 Key（2 Key≈400/天）；单 Key 额度不足会中途停止。 |
| `FETCH_AUGMENTS` | `true` | 海克斯强化库同步开关。设为 `false` 关闭。 |
| `FETCH_ITEMS` | `true` | 装备库同步开关。设为 `false` 关闭。 |
| `ADMIN_TOKEN` | 未设置 | 可选管理员鉴权。设置后，所有写接口（增删改别名）需带 `x-admin-token` 请求头或 `?token=`。未设置则放行（个人项目便捷）。 |
| `FORCE` | `false` | **仅运行 sync 时生效**：`FORCE=true npm run sync` 忽略版本比对与所有当日缓存，强制全量重拉（用于修复解析 bug、验证全链路）。 |

> API Key 仅存于服务器 `.env`，**切勿写入小程序前端**。

---

## 4. 数据同步策略

同步主脚本 `fetch-data.js` 的核心理念是**按「榜单是否变化」分流，最大化节省第三方 credits**：

判定「榜单是否变化」依据 `config.json` 的 `version` 与 `generatedAt`（两者都与本地 meta 一致才算「未变」）。

| 当天判定 | 英雄榜 | 英雄详情 | 强化库/装备库 | 强化详情/装备详情 |
|---|---|---|---|---|
| **榜单变化**（version 或 generatedAt 不一致 / 首次运行） | 拉取（有当日缓存则跳过） | 拉取（若开 `FETCH_DETAILS`，且每项有当日缓存） | **跳过**（额度优先给榜单/详情） | **跳过**（额度优先给榜单/详情） |
| **榜单未变** | 复用库内（不拉） | **跳过**（不重拉） | 拉取（当日缓存保护） | 拉取（当日缓存保护） |
| `FORCE=true` | 强制拉 | 强制拉 | 强制拉 | 强制拉 |
| `FETCH_*=false` | — | — | 跳过 | 跳过 |

要点：

- **第三方榜单约每 1–2 周更新一次**，因此绝大多数日子都是「榜单未变」的安静日，基础数据（装备/海克斯/详情）一定会在这些天补齐。
- 英雄榜、英雄详情均有「当日缓存」：同日内重复运行 sync 几乎不消耗 credits；只有跨天或 `FORCE=true` 才重拉。
- 基础数据（augments/items/augment_details/item_details）各自有当日缓存键，每天最多各拉 1 次。
- 四段基础数据拉取均有独立 try 保护，单段失败不影响其他数据写入。
- 每日约消耗 credits：榜单变化日 ≈ 1 + 详情(346)；安静日 ≈ 4（基础数据）+ 3（榜单读取 config 等免费接口）。单 Key 200/天额度对安静日绰绰有余；变化日全量详情需多 Key。

### 运行同步

```bash
npm run sync                       # 正常同步（按版本比对，安静日拉基础数据）
FORCE=true npm run sync            # 强制全量重拉
FETCH_DETAILS=true npm run sync    # 本次额外拉取英雄详情
```

### 部署为每日定时任务

服务器上用 `sync-daily.sh` + cron（脚本会写 `data/cron-sync.log` 与 `data/sync-status.json`）：

```bash
crontab -e
# 北京时间每日 05:00（若服务器时区为 Asia/Shanghai）；UTC 则改为 0 21 * * *
0 5 * * * /opt/aram-backend/sync-daily.sh
```

远程查看上次同步成败：

```bash
curl https://www.liceworld.online/api/sync-status
```

---

## 5. API 接口

所有接口均返回 JSON。写接口（`POST/PUT/DELETE` 别名）在配置了 `ADMIN_TOKEN` 时需带鉴权头 `x-admin-token`（或查询参数 `?token=`）。

### 健康检查 & 状态

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/sync-status` | 读取 `data/sync-status.json`，查看上次同步成败/报错 |

### 英雄榜单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/champions` | 英雄强度榜（按 tier 升序、winRate 降序）。**实时合并自定义别名**，并把自定义别名+称号中文转拼音拼入 `pinyin`/`pinyinInitials`（前端拼音/首字母搜索可命中别名与称号）。 |
| GET | `/api/champions-raw` | 英雄榜原始 raw JSON（入库时原样保存），用于核对字段/调试。 |
| GET | `/api/champions/:id` | 单英雄详情（归一化后，供详情页消费）。未同步返回 404。 |
| GET | `/api/champions/:id/source` | 单英雄详情原始 payload（读 `champion_detail` 表）。 |

### 自定义英雄别名（独立于 champions 表，sync 不覆盖）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/champions/:id/aliases` | 查看某英雄全部自定义别名（每条带自增 id） |
| POST | `/api/champions/:id/aliases` | 新增：body `{ "alias": "风男" }` 或 `{ "aliases": ["风男","快乐风男"] }` |
| PUT | `/api/champions/:id/aliases/:aliasId` | 重命名：body `{ "alias": "新名" }` |
| DELETE | `/api/champions/:id/aliases/:aliasId` | 按 id 精确删除 |
| DELETE | `/api/champions/:id/aliases` | 按文本删除 `{ "alias": "..." }` / `{ "aliases": [...] }`；或 `{ "clear": true }` 清空该英雄全部 |

### 装备 / 海克斯

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/augments` | 海克斯强化库（列表摘要） |
| GET | `/api/items` | 装备库（列表摘要） |
| GET | `/api/augments-details` | 海克斯强化详情全量（来自 `aram-mayhem-augments.zh_cn.json`） |
| GET | `/api/augments-details/:id` | 单个海克斯详情 |
| GET | `/api/items-details` | 装备详情全量（来自 `items-zh_cn.json`） |
| GET | `/api/items-details/:id` | 单个装备详情 |

---

## 6. 数据表结构（SQLite）

| 表 | 字段 | 说明 |
|---|---|---|
| `meta` | `key`, `value` | KV 存储：dataVersion / version / updatedAt / lastSync / 各数据当日缓存日期 |
| `champions` | `id, name, alias, title, icon, tier, winRate, pickRate, raw, pinyin, pinyin_initials, updatedAt` | 英雄强度榜；`raw` 为第三方原始 JSON；`pinyin` 同步时由 name 算一次 |
| `champion_detail` | `id, payload, updatedAt` | 单英雄详情原始 payload |
| `augments` | `id, payload` | 海克斯强化列表摘要 |
| `items` | `id, payload` | 装备列表摘要 |
| `augment_details` | `id, payload, updatedAt` | 海克斯强化完整详情 |
| `item_details` | `id, payload, updatedAt` | 装备完整详情 |
| `champion_aliases` | `id`(自增), `champion_id`, `alias`, `created_at`, `UNIQUE(champion_id, alias)` | 用户自定义别名 |

> 列表摘要表（augments/items）只含 id/name/icon 等精简字段；详情表（augment_details/item_details）含描述、数值等完整字段，源自各自的 `.zh_cn.json` 单文件，按 id 拆分存储。

---

## 7. 管理页面

由 nginx 以 `/admin/` 路径托管 `backend/public/`（生产地址 `https://www.liceworld.online/admin/...`）：

- **`/admin/aliases.html`** — 自定义英雄别名管理：搜索、展开英雄、新增（支持多别名）、就地重命名、删除、清空。
- **`/admin/source.html`** — 单英雄源数据查看器：输入英雄 id，查看 `champion_detail` 原始 JSON，可复制。

> 这两个是静态文件，服务器 `git pull` 即更新，无需 `pm2 restart`；浏览器需硬刷新（清缓存）才生效。

---

## 8. 生产部署

### 8.1 启动服务（pm2）

```bash
cd /opt/aram-backend
pm2 start server.js --name aram-backend
pm2 save
# 代码更新后：
git pull && pm2 restart aram-backend
```

### 8.2 Nginx 反代

小程序通过 `https://www.liceworld.online/api/...` 访问，`/api` 反代到本地 3000（`proxy_pass` 末尾不带 `/`，保留前缀）。参考 `nginx.example.conf` 的子域写法，或生产用的子路径写法：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> 管理页与静态资源由 nginx 直接托管，不经过 Node：
> ```nginx
> location /admin/ {
>     alias /opt/aram-backend/public/;
>     try_files $uri $uri/ =404;
> }
> ```

### 8.3 微信小程序端

- 小程序 `request` 合法域名填 `https://www.liceworld.online`。
- 前端 `BASE_URL = https://www.liceworld.online`。
- 本地联调可临时用 `http://<服务器IP>:3000` 并勾选「不校验合法域名」。

---

## 9. 辅助脚本

- **`scripts/fetch-one.js <id>`** — 调试单个英雄详情：拉取 `/champions/{id}.json` 原始响应 + 归一化结果，保存到 `tmp/`，并对比两段结构。只消耗 1 credit，不写业务库。
  ```bash
  node scripts/fetch-one.js 266     # 指定英雄 id（266 = 亚托克斯）
  ```
- **`scripts/aggregate-tags.js`** — 标签聚合脚本（用途详见脚本头部注释）。
- **`npm run sync-pinyin`** — 仅重算 `champions` 表的 `pinyin`/`pinyin_initials` 字段（当拼音计算逻辑调整、但无需重拉榜单时使用）。

---

## 10. 故障排查

| 现象 | 可能原因 / 处理 |
|---|---|
| 详情页一直「加载中」 | 未同步详情表（`FETCH_DETAILS` 未开或没跑过）→ 服务器 `FETCH_DETAILS=true npm run sync` + `pm2 restart`；前端联调需勾「不校验合法域名」。 |
| 接口返回 HTML 或 `Unexpected token '<'` | 服务器跑的是旧进程、路由未注册 → `pm2 restart aram-backend`（`git pull` 拉了新代码但没重启）。 |
| 同步中途停止、日志 `当日 API 额度耗尽` | 单 Key 额度不足（英雄详情约 346 credits）→ 配置多个 Key（DTODO_API_KEYS）叠加额度。 |
| 同步后基础数据（装备/海克斯）为空 | 仅在「榜单未变」的安静日才拉取；若恰逢首跑当天榜单变化，需等到下一个安静日。 |
| 别名管理页搜索失效 | 浏览器缓存了旧页面 → 硬刷新。 |

---

## 11. 已知问题 / 待修复

- `lib/dtodo.js` 的 `normalizeChampionDetail` 对第三方异常字段（如召唤师技能、技能加点）可能返回空，前端已做隐藏/空状态处理；若第三方恢复数据，详情页对应栏目会自动显示。
- 多音字（如「重」「乐」）按 pinyin-pro 默认常用音处理，个别别名/称号拼音可能不准，但模糊搜索容忍度高。
- 本文件此前 `server.js` 中 `/api/champions-raw` 有一条 SQL 笔误（`信仰 raw`）已修复；如仍在旧版本请 `git pull` 更新。
