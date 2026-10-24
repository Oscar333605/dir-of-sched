# 日程管理助手 · 提醒引擎

提醒引擎是独立于小程序的「服务端组件」，负责在到达提醒时间时，通过**邮件 + 微信订阅消息 + 短信**三种渠道同时发送提醒。

## 组件说明

| 文件 | 作用 |
|---|---|
| `sweep.js` | 提醒执行器：接收一批待发提醒，逐条并发走三渠道，输出各渠道结果 |
| `channels/wechat.js` | 微信订阅消息：获取 access_token、发送订阅消息、jscode2session 换 openid |
| `channels/email.js` | 邮件渠道（SMTP，依赖 nodemailer） |
| `channels/sms.js` | 短信渠道（暂不接入，留接口占位） |
| `lib/message.js` | 按提醒类型生成各渠道消息文案 |
| `openid-server.js` | 轻量 HTTP 服务，供小程序收集 openid（`POST /api/wx/openid`） |
| `wechat-send.js` | 单条微信订阅消息发送 CLI（供自动化逐条调用） |
| `config.js` | 所有密钥配置（AppID/AppSecret、模板 ID、SMTP、短信） |

## 提醒时间规则（与小程序 `utils/reminder.js` 一致）

1. **报名截止提醒**：含报名环节时，在报名截止前 `REGISTRATION_LEAD_HOURS`（默认 24）小时发送，并提示用户确认是否已完成报名。
2. **活动前三天**：活动开始日期往前 3 天，当天 20:00 发送。
3. **活动前一天**：活动开始日期往前 1 天，当天 20:00 发送。
4. **活动当天**：距开始 2 小时发送。

## 配置密钥（config.js）

- **微信渠道**：填 `wechat.appid`、`wechat.secret` 以及四个 `templates` 模板 ID。模板在微信公众平台「功能 → 订阅消息」创建。
  注意：订阅消息模板的字段（如 `thing1`、`time2`）需与 `lib/message.js` 中 `wechatData` 的字段名一一对应，否则发送会报 `47003` 模板参数错误。
- **邮件渠道**：填 `email.enabled=true` 及 SMTP 主机/账号/授权码。
- **短信渠道**：暂不接入，填 `sms.enabled=true` 并按 `channels/sms.js` 内注释接入服务商。

未填写的渠道会自动跳过，不影响其他渠道。

## 运行方式

### 方式 A：由 WorkBuddy 自动化定时驱动（推荐，无需部署服务器）

已创建一个「每小时执行」的自动化任务，它会：查询到期提醒 → 用 Agent Mail 发邮件 → 调用 `wechat-send.js` 发微信 → 标记已发送。邮件渠道无需任何 SMTP 配置即可生效。

### 方式 B：常驻在线服务（server.js，进程守护 + 优雅关闭 + 并发控制）

`server.js` 把发送逻辑与 openid 收集合并为一个常驻 HTTP 服务，可独立部署：

```bash
cd reminder-engine
npm install
PORT=8787 node server.js      # 监听 0.0.0.0:8787
```

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回 uptime/status |
| POST | `/sweep` | 接收待发提醒 JSON 数组并发送（并发上限 `MAX_CONCURRENT`，默认 5） |
| POST | `/api/wx/openid` | 收集微信 openid（jscode2session） |

关键设计点：

- **进程守护**：捕获 `uncaughtException` / `unhandledRejection`，记录日志而不崩溃退出；配合外部进程管理器（如 pm2/systemd 的 Restart=always）可实现自动重启。
- **异常自恢复**：每个请求独立 try-catch；单条发送失败不影响其他条。
- **并发与资源管理**：信号量限制同时发送条数（`MAX_CONCURRENT`），防止瞬时打爆邮件/微信接口。
- **优雅关闭**：监听 `SIGTERM`/`SIGINT`，停止接收新请求、等待在途请求完成后再退出，10 秒兜底强制退出。

> 说明：云数据库目前**不提供对外直连能力**（查询只能通过 WorkBuddy 的数据库工具），因此本服务不直接查库，而是由 WorkBuddy 调度器查库后把到期提醒 POST 到 `/sweep`。发送动作由本服务稳定执行。

### 方式 C：自托管定时执行

```bash
cd reminder-engine
npm install        # 仅邮件渠道需要 nodemailer

# 单次执行：把待发提醒 JSON 传入
echo '[{"reminder_id":1,"type":"before_1d","event_name":"示例活动","start_time":"2026-10-25T14:00:00+08:00","location":"北京","email":"you@example.com"}]' | node sweep.js
```

配合 crontab / 定时任务每分钟执行一次，即可达到分钟级精度。到期提醒由数据库查询得到（见自动化中的 SQL），把结果 JSON 传入 `sweep.js` 即可。

## 收集微信 openid（发微信订阅消息的前置条件）

微信订阅消息按 openid 发送，openid 通过小程序 `wx.login` 的 code 换取：

1. 启动 `node openid-server.js`，并把它暴露为小程序可访问的 HTTPS 地址。
2. 在小程序 `utils/config.js` 的 `ENGINE_BASE_URL` 填入该地址。
3. 小程序保存活动时会自动调用 `/api/wx/openid` 换取 openid 并写入 `user_settings`。

## 数据流

```
用户在小程序粘贴/截图 → LLM 解析 → 写入 events 表 + 计算提醒写入 reminders 表
        ↓
调度器（自动化 / 自托管定时）查询 reminders 中 trigger_at <= now 且 status='pending' 的记录
        ↓
sweep.js 逐条发送：邮件(SMTP/AgentMail) + 微信订阅消息 + 短信
        ↓
标记 reminders.status='sent'
```
