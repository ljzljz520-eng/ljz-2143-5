# 会议室门牌应用

一个从空仓库实现的会议室预约、改期、签到与门牌显示样例：

- **服务端**：Node.js + SQLite 关系库；所有房间、会议、授权、设备、离线签到裁决和事件均落库。
- **Web**：登录后预约、改期、延长、撤销、签到、设置隐私，并显示 UTC 预约事实、版本号和设备显示新鲜度。
- **C 门牌端**：`client/door_client.c` 使用公司背景模板，在线拉取门牌快照与背景；断线时使用本地缓存，按设备策略决定能否生成离线签到。

## 快速开始

```bash
npm install
make client
npm start
# 打开 http://localhost:3000
```

示例账号：

| 角色 | 邮箱 | 密码 |
| --- | --- | --- |
| 用户 | alice@example.com | password123 |
| 用户 | bob@example.com | password123 |
| 管理员 | admin@example.com | password123 |
| 模板编辑者 | editor@example.com | editor123 |

C 门牌端需要先由管理员在 Web 页面注册设备并复制令牌：

```bash
make client
./client/door_client -h 127.0.0.1 -p 3000 -t '<device-token>' -c /tmp/boardroom-cache.json
# 模拟断线：
./client/door_client -h 127.0.0.1 -p 3999 -t '<device-token>' -c /tmp/boardroom-cache.json -s
```

## 验收测试

```bash
npm test
```

覆盖 20 项：重叠/相邻预约竞争、改期版本冲突、延长与下一场检查、在线签到竞争、DST 重复时刻和春令时间隙、撤销后的旧离线确认、时钟漂移、两种离线策略、隐私与模板编辑者隔离、权限回收、HTTP 集成等。

## 关键规则

### 1. 时间边界和跨时区

会议事实以 **UTC epoch milliseconds** 存储和比较：

```text
[startUtc, endUtc)
```

- 开始时刻包含；结束时刻不包含。
- `[10:00,11:00)` 与 `[11:00,12:00)` 相邻，不冲突。
- 只要一个区间满足 `existing.start < new.end && existing.end > new.start` 即冲突。
- API 同时保存房间 IANA 时区、本地墙钟字符串、起止 UTC offset。
- 秋季重复小时必须提交 `dstOccurrence: first | second`；春季不存在的墙钟时间返回 `LOCAL_TIME_GAP` 和建议时间，不静默猜测。

### 2. 原子冲突检查

创建、改期、延长和签到都在 SQLite `BEGIN IMMEDIATE` 事务内完成“读取当前事实 → 检查 → 写入 → 追加事件”。两个并发请求由数据库写锁串行化：

1. 第一个提交者成功，会议版本递增；
2. 第二个看到已提交行并收到 `409 ROOM_BUSY`；
3. 前端可携带 `expectedVersion`，旧页面的改期/签到会收到 `VERSION_CONFLICT`。

延长会议只允许改变结束时间，并重新查询下一场会议；门牌倒计时变化不是事实来源。

### 3. 离线门牌策略

设备级策略二选一：

- `cache_view_only`：断线时只显示最后快照和缓存年龄，不生成签到写入。
- `offline_checkin_allowed`：可保存离线确认，重连后上传，由服务端重新裁决。

服务端不信任设备时钟。离线确认必须带：会议 ID、设备时钟、最后一次已知服务器时钟、设备估算漂移和去重确认串。服务端只接受时钟不确定区间与签到窗口相交、同步时间足够新、会议仍存在且在该设备最后授权缓存中的请求。预约撤销、设备/权限回收、重复确认或漂移超窗都会落库为拒绝记录。

断线跨过会议结束边界时，C 端把状态标记为 `UNKNOWN/STALE`，不会把旧会议倒计时续算成下一场会议。

### 4. 隐私与模板权限

会议隐私可取：

- `inherit`：跟随房间默认；
- `full_subject`：门牌显示完整主题；
- `busy_only`：门牌只显示 `Busy` 和时间。

门牌快照按隐私投影后返回。模板编辑者只有 `template_editor` 授权时能更新背景 URL，但该角色不授予会议列表、主题或状态读取权限；模板接口响应显式为 `meetingDetailsAccessible: false`。

### 5. 推送乱序和新鲜度

会议变化追加到全局递增事件表，事件含会议内序号、全局 ID 和 UTC 时间。客户端重连后以全局 cursor 补拉；UI 只应用更新的会议版本，旧推送丢弃。权限被回收后，隐藏事件不再下发，cursor 仍按全局日志前进。

Web 门牌预览和 C 端显示：

- `serverTimeUtc/generatedAtUtc`：服务端快照时间；
- `expiresAtUtc/staleAfterUtc`：新鲜期限；
- 缓存年龄、在线/离线状态和策略；
- 背景图加载失败仅隐藏背景，不遮挡当前/下一场状态层。

## 目录

```text
src/db.js       关系库 schema、密码和种子数据
src/time.js     IANA 时区、DST gap/repeated time、UTC 表示
src/service.js  授权、原子事务、冲突、签到、离线裁决、隐私投影
src/server.js   HTTP API 与静态资源
web/            预约管理页面
client/         C 门牌客户端
test/           单元与 HTTP 验收测试
assets/         公司背景模板
docs/           API、设计与验收说明
```
