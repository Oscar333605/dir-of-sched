# 日程管理助手（Dir of Sched）

一个基于**微信小程序 + WorkBuddy 云服务 + Node 提醒引擎**的个人日程管理工具，核心能力是：

> **消息输入 → AI 智能解析 → 自动排期 → 多渠道定时提醒（邮件 / 微信 / 短信）**

用户只需把一段活动安排或任务描述粘贴（或上传截图），系统自动提取名称、时间、地点、报名信息、备注等结构化字段，并按预设规则生成多条提醒，在到期时间点通过邮件、微信订阅消息、短信等渠道推送。

---

## 目录

1. [项目简介](#项目简介)
2. [整体架构](#整体架构)
3. [目录结构](#目录结构)
4. [功能说明](#功能说明)
5. [运行环境与依赖](#运行环境与依赖)
6. [启动与部署方式](#启动与部署方式)
7. [数据模型](#数据模型)
8. [已知问题](#已知问题)
9. [潜在风险](#潜在风险)
10. [后续维护建议](#后续维护建议)

---

## 项目简介

- **定位**：个人自用 + 小范围分享（如同学之间）的日程提醒工具。
- **形态**：微信原生小程序（前端）+ WorkBuddy 云服务（BaaS 后端）+ Node.js 提醒引擎（服务端发信）。
- **技术栈**：
  - 前端：微信原生小程序（WXML / WXSS / JS），无第三方 UI 框架。
  - 后端：WorkBuddy 云服务（对标 Supabase 的 BaaS），提供云数据库（PostgreSQL）、认证、对象存储、免密钥 LLM。
  - 提醒引擎：Node.js（原生 `http` 模块 + `nodemailer` + `dotenv`），无 Express 等框架依赖。

### 核心设计原则

1. **时间解析唯一入口**：所有时间的「解析/构建/规范化」统一走 `utils/datetime.js`，避免 `new Date(iso)` 散落各处导致的无时区串被误当 UTC 的 8 小时偏差。
2. **LLM 调用唯一入口**：所有大模型调用统一走 `utils/parser.js` 的 `callLLM`，确保日期上下文注入、`temperature:0` 等优化一致生效。
3. **事件删除唯一入口**：`utils/event.js` 的 `deleteEvent` 统一处理「先删提醒、再删事件」的联动删除。
4. **提醒发送唯一入口**：`reminder-engine/lib/dispatch.js` 的 `dispatchOne` 统一三渠道（邮件/微信/短信）并发发送。
5. **敏感配置不入库**：邮箱密码、AppSecret 等一律从 `.env` 读取，`.env` 已加入 `.gitignore`。

---

## 整体架构

项目由**三个互相独立、通过 HTTP/云 API 通信**的组件构成：

```
┌─────────────────────────────────────────────────────────┐
│ ① 微信小程序（前端，运行在用户手机/微信内）                 │
│    pages/index / add / detail / me 四个页面              │
│    ├─ 智能解析（调云端 LLM）                              │
│    ├─ 手动填写                                           │
│    └─ 增删改查日程/任务、设置邮箱                          │
└──────────────┬──────────────────────────────────────────┘
               │ 直连（HTTPS）
               ▼
┌─────────────────────────────────────────────────────────┐
│ ② WorkBuddy 云服务（BaaS，托管在腾讯云）                  │
│    ├─ 云数据库（PostgreSQL）：events + reminders +        │
│    │   user_settings 三张表                              │
│    ├─ 免密钥 LLM：智能解析                                │
│    ├─ 对象存储：截图上传                                  │
│    └─ 认证：微信登录（openid）                            │
└──────────────┬──────────────────────────────────────────┘
               │ 只有 WorkBuddy 的 MCP 工具能查库（无对外直连密钥）
               ▼
┌─────────────────────────────────────────────────────────┐
│ ③ 提醒引擎 reminder-engine（Node.js，跑在本地/可部署）     │
│    ├─ server.js 常驻 HTTP 服务                           │
│    ├─ sweep.js 单次执行脚本                               │
│    └─ 作用：发邮件 / 微信订阅消息 / 短信                   │
└─────────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户在小程序粘贴文字/上传截图
        ↓
LLM 解析 → 填充表单 → 用户确认
        ↓
写入 events 表 + 计算提醒写入 reminders 表
        ↓
「日程提醒调度器」自动化（每小时）查询 reminders 中
  trigger_at <= now 且 status='pending' 的记录
        ↓
调用提醒引擎发信（邮件 SMTP / 微信 / 短信）
        ↓
标记 reminders.status='sent'
```

> **关键约束（务必理解）**：WorkBuddy 云数据库**不提供对外直连能力**——查库只能通过 WorkBuddy 的数据库 MCP 工具进行，没有可给外部常驻进程直连的连接串/密钥。因此「查库」这一步由 WorkBuddy 的「日程提醒调度器」自动化完成，提醒引擎只负责「发送」。这意味着**提醒功能依赖 WorkBuddy 自动化在运行**（详见「潜在风险」）。

---

## 目录结构

```
Dir_of_Sche/
├── app.js / app.json / app.wxss          # 小程序入口、页面路由、全局样式
├── project.config.json                    # 微信开发者工具项目配置
├── sitemap.json                           # 小程序收录配置
├── package.json                           # 前端依赖（仅 workbuddy-cloud-sdk）
│
├── pages/                                 # 小程序页面
│   ├── index/                             # 首页：日程/任务列表、Tab 切换、长按删除、顶部「历史 / 设置」入口
│   ├── add/                               # 新增页：智能解析 + 手动填写表单
│   ├── detail/                            # 详情页：日程详情、提醒计划、完成标记、报名确认
│   ├── history/                           # 历史日程页：活动/任务/周期任务三类历史列表与查看
│   └── me/                                # 设置页：微信登录、邮箱设置
│
├── utils/                                 # 小程序公共工具（核心逻辑层）
│   ├── cloud.js                           # WorkBuddy 云服务 SDK 初始化（含诊断包装）
│   ├── workbuddy-cloud-diagnostics.js     # 云请求诊断日志（失败时打印结构化信息）
│   ├── auth.js                            # 会话管理：getSession / loginWithWechat
│   ├── parser.js                          # LLM 统一入口：callLLM / parseText / parseTask / parseImage / nowContext
│   ├── datetime.js                        # 时间解析唯一入口：parseToDate / buildIso / splitIso / normalizeIso
│   ├── datetime.test.js                   # 时间工具单元测试（node 直接运行）
│   ├── format.js                          # 展示格式化：formatDateTime / relativeUntil / reminderTypeLabel
│   ├── reminder.js                        # 提醒时间计算：computeReminders
│   ├── event.js                           # 事件删除公共逻辑：deleteEvent
│   └── config.js                          # 业务配置：订阅模板 ID、提醒提前量、引擎地址
│
├── reminder-engine/                       # 提醒引擎（Node.js，独立于小程序）
│   ├── server.js                          # 常驻 HTTP 服务（进程守护 + 鉴权 + 并发控制）
│   ├── sweep.js                           # 单次执行 CLI：接收 JSON 数组并发送
│   ├── wechat-send.js                     # 单条微信订阅消息发送 CLI（供自动化逐条调用）
│   ├── config.js                          # 引擎配置（从 .env 读取密钥）
│   ├── .env                               # 敏感配置（已 gitignore，含邮箱密码）
│   ├── .env.example                       # .env 模板
│   ├── .gitignore                         # 忽略 .env 与 node_modules
│   ├── package.json                       # 依赖：dotenv、nodemailer
│   ├── channels/                          # 三个发送渠道
│   │   ├── email.js                       # 邮件（SMTP，复用 transporter 连接）
│   │   ├── wechat.js                      # 微信订阅消息（access_token 缓存）
│   │   └── sms.js                         # 短信（占位，未接入）
│   └── lib/
│       ├── dispatch.js                    # 发送核心：dispatchOne（三渠道并发）
│       └── message.js                     # 按提醒类型生成各渠道文案
│
└── .workbuddy/                            # WorkBuddy 项目元数据（勿删）
    ├── applications.yaml                  # 应用 ID 映射
    └── memory/                            # 工作日志与自动化执行记录
```

---

## 功能说明

### 1. 智能解析（LLM）

- **文字解析**：粘贴一段活动/任务描述，调云端 LLM 抽取结构化字段。
- **图片解析**：上传活动截图，图片上传对象存储后走多模态 LLM 识别。
- **公众号链接解析**：识别 `mp.weixin.qq.com` 链接，交 LLM 尝试抽取（小程序无法直接抓取外链，失败时提示复制正文）。
- **日期上下文注入**：所有解析都在 system prompt 里注入 `nowContext()`（当天的年月日星期），确保「明天」「下周三」等相对时间推断准确。
- **手动填写**：短文本场景可点「手动填写」跳过 LLM，直接展开表单，秒开。

### 2. 活动管理

- 字段：名称、地点、开始/结束时间、备注、是否含报名、报名开始/截止时间。
- 列表分组：**即将开始**（未开始）、**进行中**（已开始未结束）。
- 详情页：标记完成 / 撤销完成、报名确认 / 撤销确认。
- 已结束/已完成的活动归入「历史日程」页面。

### 3. 任务管理

- 字段：任务名称、工作内容、截止时间（可选）、提醒时间（可选）、提醒频率、备注。
- 列表分组：**短期任务**（待办）、**周期任务**（每天重复）；逾期任务显示「已逾期」标签。
- **提醒频率**：三选一 —— 不提醒 / 提醒一次（`once`）/ 每天提醒（`daily`）。
- **周期任务（每天提醒）**：开启后任务不再有单一截止点，系统每天在指定时分生成一次提醒，形成每日循环。
- 周期任务与短期任务**分开展示**（顶部标签栏独立「周期任务」入口），避免周期任务过多时影响其他任务的查看和操作。
- **周期任务完成/终结**：标记完成后进入历史（而非消失）；也可「终结任务」停止后续每日提醒并归入历史备查。
- 「截止时间」「提醒时间」均为可选字段，留空不生成对应提醒。

### 3.1 历史日程（独立页面）

- 首页顶部提供**「历史」**入口，与「设置」平级，点击进入独立的历史日程页。
- 历史日程页集中展示**过往日程**，按 **活动 / 任务 / 周期任务** 三类明确分区。
- 已完成/已结束的活动、已完成的任务、已完成/已终结的周期任务分别归类，便于分别查看；点击卡片可进入详情页查看。
- 历史日程不再显示在首页下方，首页专注「待办 / 进行中 / 周期任务」。

### 4. 置顶

- 任意活动或任务均可**置顶**，置顶项在各自分组内排在最前，卡片显示「置顶」角标。
- 在列表卡片或详情页均可取消置顶。

### 5. 编辑

- 活动/任务创建后均可**编辑修改**（标题、内容、时间、提醒频率等字段）。
- 编辑入口：列表卡片「编辑」按钮 / 详情页「编辑」按钮，进入添加页自动回填原值。
- 保存编辑时会**先删除旧提醒、再按新字段重建提醒计划**，保证提醒与最新内容一致。

### 6. 定时提醒（核心）

提醒时间规则（`utils/reminder.js` 计算，`lib/message.js` 生成文案）：

| 提醒类型 | 触发时机 | 说明 |
|---|---|---|
| `registration_start` | 报名开始前 5 分钟 | 引导用户报名后回小程序确认 |
| `registration_ddl` | 报名截止前 24 小时 | 提醒完成报名 |
| `before_3d` | 活动开始前 3 天 07:00 | 提前安排时间 |
| `before_1d` | 活动开始前 1 天 23:00 | 提前准备 |
| `day_2h` | 活动当天开始前 2 小时 | 当天提醒 |
| `task_ddl` | 任务截止前 24 小时 | 提醒完成（截止时间可选，留空不生成） |
| `task_reminder` | 指定时刻（一次性） | 「提醒一次」模式（`recurrence_rule='once'`）在指定时刻发一封提醒邮件 |
| `task_daily` | 每天同一时分 | 「每天提醒」模式（`recurrence_rule='daily'`）的每日滚动提醒，未设提醒时间默认 09:00 |

提醒提前量可通过 `utils/config.js` 配置（`REGISTRATION_LEAD_HOURS`、`TASK_DDL_LEAD_HOURS` 等）。

### 7. 发送渠道

- **邮件（已接通）**：SMTP，当前使用网易企业邮（`smtp.qiye.163.com:465` SSL）。
- **微信订阅消息（未配置）**：需要 AppID/AppSecret/模板 ID/openid，目前留空。
- **短信（未接入）**：留占位接口，接入时改 `channels/sms.js`。

### 8. 用户设置

- 微信一键登录（WorkBuddy 云认证）。
- 设置接收提醒的邮箱（`user_settings` 表，按 `owner_id` 隔离，多用户互不影响）。

---

## 运行环境与依赖

### 前端（小程序）

| 项 | 要求 |
|---|---|
| 微信开发者工具 | 最新稳定版 |
| AppID | `wx39711f6c3bd2ca20`（见 `project.config.json`） |
| npm 依赖 | `@tencent-ai/workbuddy-cloud-sdk`（`dev` 版本） |

### 提醒引擎（Node.js）

| 项 | 要求 |
|---|---|
| Node.js | 18+（用了原生 `fetch`） |
| npm 依赖 | `dotenv`（读 .env）、`nodemailer`（发邮件） |
| 环境变量 | 见 `.env.example` |

### 云服务（无需自建）

- WorkBuddy 云服务（腾讯云托管）：云数据库、认证、存储、LLM，均免运维。
- App ID：`wbapp_lehL7wVwcebPnun1xnLup6`；endpoint：`https://mp-api.app.workbuddy.host`。

---

## 启动与部署方式

### A. 小程序（前端）

1. 用微信开发者工具打开项目根目录 `Dir_of_Sche`。
2. 确认 AppID 为 `wx39711f6c3bd2ca20`。
3. 在「构建 npm」后即可预览/上传体验版/提交审核。
4. `project.config.json` 的 `packOptions.ignore` 已排除 `reminder-engine`、`node_modules`、`.workbuddy` 等非前端目录，避免打包体积膨胀。

### B. 提醒引擎（发信端）

**方式 1：常驻 HTTP 服务（推荐，支持进程守护）**

```bash
cd reminder-engine
npm install
# 设置环境变量后启动（也可直接依赖 .env）
node server.js        # 默认监听 0.0.0.0:8787
```

可选环境变量：`PORT`、`HOST`、`MAX_CONCURRENT`（默认 5）、`AUTH_TOKEN`（鉴权 Token）。

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（无需鉴权） |
| POST | `/sweep` | 接收待发提醒 JSON 数组并发送 |
| POST | `/api/wx/openid` | 用 code 换 openid（需配置微信） |

**方式 2：单次执行 CLI**

```bash
echo '[{"reminder_id":1,"type":"before_1d","event_name":"示例","start_time":"2026-10-25T14:00:00+08:00","email":"you@example.com"}]' | node sweep.js
# 或
node sweep.js --reminders='[{...}]'
```

### C. 提醒调度（查库 + 触发）

由 WorkBuddy 的「日程提醒调度器」自动化（`FREQ=HOURLY;INTERVAL=1`）驱动：每小时查库 → 调用提醒引擎 → 标记已发送。执行记录见 `.workbuddy/memory/automations/` 目录。

**周期任务续期**：调度器在把 `type='task_daily'` 的提醒标记为已发送后，会自动复制该事件的 `event_id`/`owner_id`，插入一条「明天同一时分」的新 `task_daily` 提醒（status=pending），从而形成每日循环。时分取自事件的 `reminder_time`（未设则默认 09:00）。

### D. 邮件 SMTP 配置（关键）

在 `reminder-engine/.env` 配置：

```
EMAIL_ENABLED=true
EMAIL_HOST=smtp.qiye.163.com
EMAIL_PORT=465
EMAIL_SECURE=true
EMAIL_USER=you@example.com
EMAIL_PASS=你的SMTP客户端授权码
EMAIL_FROM=日程助手 <you@example.com>
```

> **注意**：`law.pku.edu.cn` 域名邮件实际由**网易企业邮**托管（MX 指向 `mxmail.netease.com`），故 SMTP 用 `smtp.qiye.163.com`，不是 `smtp.pku.edu.cn`。`EMAIL_PASS` 需填网易企业邮后台生成的「客户端授权码」（16 位，含大小写字母/数字/符号），**不是邮箱登录密码**。生成路径：登录网易企业邮网页版 → 设置 → 客户端设置/客户端授权 → 开启 SMTP → 生成授权码。实测已用授权码发信成功（250 Ok）。

---

## 数据模型

### `events` 表（活动/任务）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT | 主键 |
| `owner_id` | uuid | 归属用户（`auth.uid()`，RLS 隔离） |
| `name` | text | 名称 |
| `event_type` | text | `activity` / `task` |
| `location` | text | 地点 |
| `note` | text | 备注 |
| `start_time` / `end_time` | timestamptz | 活动开始/结束 |
| `task_content` / `task_ddl` | text / timestamptz | 任务内容/截止（`task_ddl` 可空） |
| `is_recurring` | bool | 是否每天重复（默认 false） |
| `recurrence_rule` | text | 提醒频率：`once`（提醒一次）/ `daily`（每天提醒）/ null（不提醒） |
| `reminder_time` | timestamptz | 任务提醒时间（可选，可空） |
| `pinned` | bool | 是否置顶（默认 false），置顶项在列表分组内排最前 |
| `has_registration` | bool | 是否含报名 |
| `registration_start_time` / `registration_deadline` | timestamptz | 报名开始/截止 |
| `registration_confirmed` | bool | 是否已确认报名 |
| `status` | text | `active` / `completed` |
| `completed_at` | timestamptz | 完成时间 |
| `terminated` | bool | 周期任务是否已「终结」（停止后续提醒、归入历史，默认 false） |
| `source_type` | text | `image` / `text` |
| `raw_text` | text | 原始输入 |

### `reminders` 表（提醒）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT | 主键 |
| `event_id` | BIGINT | 关联事件 |
| `type` | text | 提醒类型（见功能说明表） |
| `trigger_at` | timestamptz | 触发时间 |
| `status` | text | `pending` / `sent` |

### `user_settings` 表（用户设置）

| 字段 | 类型 | 说明 |
|---|---|---|
| `owner_id` | uuid | 归属用户 |
| `email` | text | 接收提醒的邮箱 |
| `wechat_openid` | text | 微信 openid（未启用） |

> 三张表均使用 `owner_id = auth.uid()` + RLS 四策略（owner-only）做数据隔离，多用户互不可见。

---

## 已知问题

1. **`collectOpenid` 的 upsert 未指定 owner_id**：`add.js` 的 `collectOpenid` 里 `cloud.database.from('user_settings').upsert({ wechat_openid: openid })` 未带 `.eq('owner_id', ...)` 匹配条件，接入微信后可能无法正确路由到当前用户行。**当前因 `ENGINE_BASE_URL` 为空，该函数被短路，不影响现状**，但接入微信前需修复。

2. **微信订阅消息渠道完全未配置**：`wechat.appid`/`secret`/模板 ID 均为空，`utils/config.js` 的 `ENGINE_BASE_URL` 也为空，故微信消息、openid 收集当前都不可用，目前只有邮件渠道生效。

3. **短信渠道未接入**：`channels/sms.js` 是占位实现，`sms.enabled=false`。

4. **提醒精度为小时级**：调度器每小时跑一次，提醒最多延迟 1 小时（对日程场景可接受）。

5. **README 曾过时**：本 README 已全面更新；但 `wechat-send.js`、`sweep.js` 等 CLI 的调用契约若有变化，需同步本文件。

---

## 潜在风险

1. **⚠️ 提醒功能依赖电脑/WorkBuddy 运行**：提醒的「查库 + 发信」依赖 WorkBuddy 的「日程提醒调度器」自动化，该自动化跑在用户电脑上。**电脑关机或 WorkBuddy 未运行时，提醒会停发**（小程序本身和数据不受影响，仍能正常使用）。要彻底 7×24 不依赖电脑，需将查库 + 发信整体迁移到可直连数据库的云端（如 Supabase），这是当前架构下唯一能根治的路径。

2. **邮箱授权码存于本地 .env**：`reminder-engine/.env` 存有 SMTP 客户端授权码（已 gitignore 保护）。若此文件泄露，他人可冒用该邮箱发信。授权码可在网易企业邮后台随时吊销重生成，建议定期轮换。

3. **接口鉴权默认关闭**：`server.js` 的 `/sweep`、`/api/wx/openid` 仅当设置 `AUTH_TOKEN` 时才有鉴权。若部署到公网且不设 `AUTH_TOKEN`，任何能访问该端口的人都能触发发信/换 openid。内网自用风险低，公网部署务必设置 `AUTH_TOKEN`。

4. **LLM 输出不稳定**：智能解析依赖大模型，极端情况下可能解析错误（如时间、报名语义）。已通过 `temperature:0`、日期上下文注入、`normalizeIso` 兜底等手段降低概率，但无法 100% 消除，用户需在保存前核对表单。

5. **公众号链接解析能力有限**：小程序无法直接抓取外链正文，公众号链接解析依赖 LLM 对链接的「了解」，成功率不稳定，失败时会提示用户复制正文。

---

## 后续维护建议

### 代码维护

1. **新增时间相关逻辑时，一律走 `utils/datetime.js`**，禁止在页面里直接 `new Date(iso)` 解析时间（会导致无时区串误当 UTC）。
2. **新增 LLM 调用时，一律复用 `utils/parser.js` 的 `callLLM`**，不要自己再写「列模型 + 流式收集」，确保日期上下文与 `temperature:0` 一致生效。
3. **修改提醒规则时**，同步检查三处：`utils/reminder.js`（时间计算）、`reminder-engine/lib/message.js`（文案）、`utils/format.js`（类型标签）。
4. **改动 `.env` 字段时**，同步更新 `.env.example`，保持模板与实现一致。

### 功能演进方向

1. **接通微信订阅消息**：申请订阅消息模板，填入 `wechat.appid`/`secret`/模板 ID，配置 `ENGINE_BASE_URL`，即可让提醒直接弹到用户微信（无需邮箱，体验更好）。
2. **接入短信渠道**：实现 `channels/sms.js` 的 `sendSms`，填入短信服务商密钥。
3. **彻底云端化（可选）**：若要去掉「依赖电脑」的约束，可将 reminders 查库 + 发信迁移到可直连的数据库（如 Supabase），让提醒引擎常驻云端独立运行。
4. **提升提醒精度**：把调度器从「每小时」改为「每分钟」（自托管 crontab 或云函数定时触发），可达分钟级精度。

### 测试与验证

- 运行时间工具单测：`node utils/datetime.test.js`（应 10 项全过）。
- 验证 SMTP：在 `reminder-engine` 下用 nodemailer 发测试邮件确认连通。
- 冒烟测试常驻服务：起 `server.js` 后 curl `/health`、`/sweep`、`/api/wx/openid` 三接口。

---

## 快速上手清单（给后续接手者）

1. 读「整体架构」和「核心数据流」两张图，理解三组件关系。
2. 读「功能说明」了解能力边界（哪些渠道已通、哪些未配置）。
3. 读「潜在风险」第一条，理解「提醒依赖电脑」这一核心约束。
4. 改代码前先看「目录结构」和「后续维护建议」的 4 条硬规则。
5. 配置邮件发信：按「部署方式 D」填 `.env`。
