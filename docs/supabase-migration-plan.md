# 日程管理助手 · Supabase 迁移方案（施工蓝图）

> 目标：把「查库 + 发信」从本机 WorkBuddy 自动化迁移到云端，实现 **7×24 不依赖电脑** 的提醒。
> 硬性需求（用户已确认）：
> 1. **必须保留智能解析（LLM）**
> 2. **仍然由微信小程序登录**

---

## 0. 现状与目标对照

| 能力 | 现状（WorkBuddy 云服务） | 迁移后（Supabase） |
|---|---|---|
| 数据库 | PostgreSQL + RLS | PostgreSQL + RLS（同构，直接搬） |
| 微信登录 | `signInWithWechat` | 自建 Edge Function 换 openid → 自签 JWT |
| 智能解析 LLM | 免密钥 `cloud.llm` | Edge Function 代理第三方 LLM API |
| 对象存储 | `cloud.storage` | Supabase Storage |
| 发信 | 本地 `sweep.js` | Supabase Edge Function（原样搬 dispatch/message） |
| 定时调度 | 本机 WorkBuddy 自动化 | Supabase `pg_cron` + Edge Function |

**核心收益**：提醒调度从"电脑上每小时跑一次"变成"数据库内定时任务触发云函数"，彻底摆脱电脑。

---

## 1. 架构总览

```
微信小程序（前端，改 SDK 调用）
      │ HTTPS
      ▼
Supabase Edge Functions（云端）
   ├─ auth-wechat   ：code → openid → 自签 JWT
   ├─ parse         ：代理 LLM（文字/图片/链接解析）
   ├─ sweep         ：查库 pending → 发信 → 标记 sent → daily 续期
   └─ (可选) openid-collect
      │
      ▼
Supabase 数据库（PostgreSQL + RLS）
   ├─ events / reminders / user_settings
   └─ pg_cron 定时触发 sweep
```

---

## 2. 分阶段实施清单

### 阶段 A：Supabase 项目与数据库

1. 注册 Supabase，创建免费项目（区域建议 `ap-southeast-1` 新加坡，对国内延迟较低）。
2. 用 SQL 建三张表（字段与现有 WorkBuddy 表完全一致，见 §5）。
3. 开 RLS：三张表均 `owner_id = auth.uid()` 隔离，四条策略（select/insert/update/delete）。
4. 迁移数据：从 WorkBuddy 库导出 → 导入 Supabase（需先统一 owner_id 到 Supabase auth uid）。
5. 开 `pg_cron` 扩展，创建定时任务。

### 阶段 B：认证桥接（保留微信登录）

- 新增 Edge Function `auth-wechat`：
  1. 收 `wx.login` 的 `code` + `appid`
  2. 调微信 `code2session` 换 `openid`
  3. 以 `openid` 作为 stable identifier，调 Supabase Auth admin API **签发自定义 JWT**
  4. 前端 `supabase.auth.setSession` 落地会话
- 前端 `utils/auth.js` 的 `loginWithWechat` 改为调 `auth-wechat`。

### 阶段 C：智能解析（保留 LLM）

- 新增 Edge Function `parse`：代理第三方 LLM（OpenAI / DeepSeek / 通义 / Moonshot 等，用你已有的 key）。
- 把 `utils/parser.js` 的三个 system prompt + `nowContext()` 原样搬进云函数。
- 图片解析：图片上传 Supabase Storage 后，把临时 URL 传给 LLM 多模态接口。
- 前端 `utils/parser.js` 的 `callLLM` 改为调 `parse` 云函数（不再直接 `cloud.llm`）。

### 阶段 D：发信引擎上云

- 新增 Edge Function `sweep`：
  1. 连库查 `status='pending' AND trigger_at <= now()`
  2. 复用现有 `dispatch.js` + `message.js` + `channels/*`（邮件/微信/短信）逻辑
  3. 成功渠道 → `UPDATE ... SET status='sent'`
  4. `task_daily` → 续期插入下一天
- SMTP 授权码等密钥放进 Supabase `Edge Function Secrets`（等价于现在的 `.env`）。

### 阶段 E：定时调度（迁移核心）

- 用 `pg_cron` 每 5 分钟跑一次（比现在的"每小时"精度高很多）：
  `SELECT cron.schedule('sweep-reminders', '*/5 * * * *', $$SELECT net.http_post(...sweep...)$$)`
- 或退而求其次：`cron.schedule(..., '* * * * *')` 每分钟。

### 阶段 F：前端改造

- `utils/cloud.js`：把 `workbuddy-cloud-sdk` 换成 `@supabase/supabase-js`，初始化 supabase client。
- `utils/auth.js` / `utils/event.js` / `utils/parser.js`：替换调用。
- 6 个页面里所有 `cloud.database.from(...)` 调用 → supabase 语法（`.select/.insert/.update/.delete/.eq` 语法高度相似，改动可控）。
- 对象存储：`cloud.storage.upload` → `supabase.storage.from(...).upload(...)`。

### 阶段 G：联调与切换

1. 小程序用开发者工具验证全流程（登录 → 解析 → 建日程 → 收提醒邮件）。
2. 验证定时任务：造一条 5 分钟内到期的提醒，确认云端自动发信。
3. 确认无误后，停止本机 WorkBuddy 自动化，切换到 Supabase 正式运行。

---

## 3. 待你确认/提供的配置项

| 项 | 说明 | 状态 |
|---|---|---|
| 第三方 LLM API key | OpenAI / DeepSeek / 通义 / Moonshot 等，任选其一 | 待提供 |
| 微信小程序 AppID/AppSecret | `auth-wechat` 换 openid 需要（AppID 已知 `wx39711f6c3bd2ca20`） | AppSecret 待提供 |
| SMTP 授权码 | 现有 `reminder-engine/.env` 里的 `EMAIL_PASS`，迁移到 Supabase Secrets | 已有，需搬 |
| Supabase 免费账号 | 需注册一个项目 | 待创建 |

---

## 4. 免费额度评估

| 资源 | Supabase 免费层 | 本项目用量 | 是否够 |
|---|---|---|---|
| 数据库 | 500 MB | 个人日程，几 MB | ✅ |
| Edge Function 调用 | 50 万次/月 | 定时 sweep 每月约 9000 次 | ✅ |
| Storage | 1 GB | 少量截图 | ✅ |
| Auth | 5 万 MAU | 个人 | ✅ |
| pg_cron | 免费可用 | 每 5 分钟 | ✅ |
| LLM API | 第三方按量付费 | 极低（每次解析几分钱以内） | ⚠️ 非零 |

> 结论：**Supabase 侧完全免费**；唯一非零成本是第三方 LLM API（按量、极低）。

---

## 5. 三张表结构（PostgreSQL DDL，与现有对齐）

```sql
-- events 表
create table public.events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  event_type text not null default 'activity',      -- activity | task
  location text default '',
  note text default '',
  start_time timestamptz not null,
  end_time timestamptz,
  task_content text,
  task_ddl timestamptz,
  is_recurring boolean default false,
  recurrence_rule text,                              -- once | daily | null
  reminder_time timestamptz,
  pinned boolean default false,
  has_registration boolean default false,
  registration_start_time timestamptz,
  registration_deadline timestamptz,
  registration_confirmed boolean default false,
  status text default 'active',                      -- active | completed
  completed_at timestamptz,
  completed_date text,
  terminated boolean default false,
  source_type text,
  raw_text text,
  created_at timestamptz default now()
);

-- reminders 表
create table public.reminders (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.events(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  trigger_at timestamptz not null,
  status text not null default 'pending',            -- pending | sent
  sent_at timestamptz
);

-- user_settings 表
create table public.user_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  wechat_openid text
);

-- 索引（定时查询关键）
create index idx_reminders_pending on public.reminders (status, trigger_at)
  where status = 'pending';
```

> RLS 策略（三张表均启用）：
> `alter table ... enable row level security;`
> 四策略均 `using (owner_id = auth.uid())` / `with check (owner_id = auth.uid())`。
> `reminders` 与 `events` 的 `owner_id` 由应用层在 insert 时写入（或触发器从父事件继承）。

---

## 6. 风险与注意点

1. **owner_id 迁移是最大坑**：WorkBuddy 的 `owner_id` 是 WorkBuddy 的 user uuid，Supabase 的 `auth.uid()` 是另一套 uuid。迁移时需做**身份映射**（按 openid 对齐），否则老数据归属错乱。
2. **多 openid 历史问题**（README 已知问题 #7）：换到 Supabase 后若用 `openid` 作为 stable id，同样要保证同一用户在不同环境 openid 一致，否则邮箱配置错位会重演。
3. **微信 AppSecret 泄露风险**：`auth-wechat` 云函数里 AppSecret 必须放 Supabase Secrets，绝不能进前端代码。
4. **LLM key 泄露风险**：LLM 调用必须在 `parse` 云函数里，key 放 Secrets，前端只传文本/图片 URL。
5. **国内访问延迟**：Supabase 免费项目托管在海外，小程序端请求可能比 WorkBuddy（腾讯云）略慢；可选自托管或选就近区域缓解。
6. **pg_cron 触发 HTTP 需 `pg_net` 扩展**：`net.http_post` 依赖 `pg_net`，需一并开启。
7. **冷启动**：Edge Function 冷启动约 100-300ms，定时任务场景无感。

---

## 7. 下一步

按阶段 A→G 顺序实施。**建议先做阶段 A+B+D+E（数据库+登录+发信+定时），跑通"关掉电脑也能收提醒"这条主线，再补 C（LLM 解析）和 F（前端全量切换）**——这样核心诉求（不依赖电脑）最快落地，风险可控。

> 前置依赖：需要你先提供 **第三方 LLM key**、**微信 AppSecret**、并**注册一个 Supabase 免费项目**，我才能开始落地。三者可并行准备。
