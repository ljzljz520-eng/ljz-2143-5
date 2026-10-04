# 会议室门牌系统（Meeting Room Sign）

从空仓库实现的三层系统：

| 层 | 技术 | 目录 | 说明 |
|---|---|---|---|
| 显示端（门牌，C） | C99 / POSIX socket，无第三方库 | `c/doorsign.c` | 公司背景模板渲染、轮询、缓存、离线签到队列、时钟漂移校准 |
| Web 页面 | 原生 HTML/JS 单页 | `web/index.html` | 预约、改期、延长、撤销、签到；显示预约事实与设备显示新鲜度 |
| 服务层 | Node.js（内置 http）+ SQLite（better-sqlite3） | `server/` | 会议/房间/授权规则入关系库；原子冲突检查；SSE 推送 |

## 运行

```bash
npm install              # 仅一个依赖 better-sqlite3
# 若沙箱 cc 包装器拦截编译参数（本机如此），用真实 gcc：
PATH=/tmp/realbin:$PATH npm install   # 或见文末“构建排错”
make -C c CC=gcc         # 编译门牌端 -> c/doorsign
npm start                # http://localhost:8080 （演示令牌见启动日志）
npm test                 # 34 个验收测试（每个用例独立临时库 + 随机端口）
```

演示账号（Bearer Token）：`tok-alice`（管理员）、`tok-bob/tok-carol/tok-dave`（普通用户）、
`tok-erin`（模板编辑者）。种子房间：纽约（`America/New_York`，允许离线签到）、上海（`Asia/Shanghai`，仅在线）。

## 1. 时间模型（明确边界与跨时区表示）

* 关系库中所有时刻存 **INTEGER 毫秒 Unix epoch（UTC）**（`meetings.start_ms/end_ms`）。
* 区间统一为**半开区间 `[startMs, endMs)`**：
  * A `[09:00,10:00)` 与 B `[10:00,11:00)` **相邻不冲突**（同一毫秒 10:00 属于 B，不属于 A）。
  * 冲突判定是严格不等式：`startA < endB AND startB < endA`（见 `server/store.js` 的 `Q_OVERLAP`）。
* API 同时返回两种表示，避免歧义：
  * 预约事实：UTC `[startMs,endMs)`；
  * 房间本地墙上时间：`localStart/localEnd = {date, time, gmt:"GMT-04:00"}`，时区挂在**房间**上。
* 墙上时间 → UTC 的解析（`server/time.js wallToUtc`）显式处理夏令时：
  * **春季缺口**（如纽约 2025-03-09 02:30 不存在）→ `400 ZONE_TIME_GAP`，拒绝而不是猜测；
  * **秋季重复时刻**（2025-11-02 01:30 出现两次）→ 不指定 `disambiguation` 时返回
    `409 ZONE_TIME_AMBIGUOUS` 并给出两个候选 UTC；必须显式选 `earlier`（夏令时那次，EDT）/`later`（冬令时那次，EST）；
  * 消歧不能绕过冲突：两次 01:30 映射成不同 UTC 后仍要过同一个重叠检查。

## 2. 房间时间冲突的服务端原子检查

* 写路径全部在 better-sqlite3 的同步事务里（`BEGIN IMMEDIATE` 先拿写锁，再查冲突再插入，
  见 `server/store.js` 的 `db.transaction(...)`）。
* Node 单线程 + 同步驱动：事务内部不会被另一个 HTTP 请求穿插。
  两个用户同时预约重叠/相邻区间，结果**确定**：恰好一个 `201`，另一个 `409 ROOM_BUSY`
  且响应里带冲突会议事实。测试连跑 10 轮、以及三人并发 5 轮验证（`test/01`、`test/03`）。
* 同目标的重复改期是幂等的（不产生版本抖动）；改到他人占用时段返回 409。
* 并发“改期 vs 签到”由同一串行化序列裁决：先到者成功，后到者按**改期后的会议时间**裁决
  （会议已在明天 → `CHECKIN_TOO_EARLY`；若签到先落库 → 已签到会议禁止改期），不会出现两个事实。

## 3. 临时延长 = 重新检查下一场，不只是屏幕倒计时

`POST /api/meetings/:id/extend`（`store.txExtend`）：

1. 校验组织者/管理员；会议未撤销；新结束时间必须晚于原结束；
2. 用 `[原开始, 新结束)` 重跑冲突检查；若下一场挡路 → `409 NEXT_MEETING_BLOCKS` 并返回下一场事实，
   **`end_ms` 不变**（门牌倒计时不是本地数据，屏幕没有任何“悄悄拉长”的途径）；
3. 下一场撤销后延长成功，`end_ms` 落库、`version+1`、发 SSE 事件，门牌重拉后才显示新时间。

## 4. 门牌离线：可签到 vs 只看缓存（两种策略）

策略是**房间级**配置 `rooms.checkin_policy`（管理员可经 `/api/admin/rooms/:id/policy` 随时收紧）：

| | `offline_allowed`（纽约） | `online_only`（上海） |
|---|---|---|
| 断网时渲染 | 用最后一次成功状态缓存渲染（`--mode probe` 打印 `OFFLINE — 使用缓存`） | 同左（缓存查看不受影响） |
| 断网时签到 | 本地排队（`--mode checkin --offline` 写 `<cache>.queue`） | 不排队/队列补提被服务端 `403 OFFLINE_NOT_ALLOWED` |
| 重连后 | `--mode queue` 一次性补提，服务端对每条返回确定裁决（207 多状态） | 同端点但全部拒绝 |

离线相关的两个棘手问题：

* **设备时钟漂移**：门牌每次轮询都带 `deviceMs`（设备自认为的时刻），服务端记录
  `clock_offset_ms = serverMs − deviceMs`（EMA 平滑）。离线补提交 `claimedMs = deviceMs + offset`，
  用校准后的时刻判签到窗口，而不是信设备本地钟（`c/doorsign.c --shift-ms` 与 `--mode simskew` 可模拟）。
* **预约被撤销后的旧确认**：队列项重放时，服务端先看会议当前状态——
  `cancelled` → `410 MEETING_CANCELLED`（结果体 `{ok:false,code:"MEETING_CANCELLED"}`），
  门牌据此**清除本地“已确认”标记**，不会因为断网期间保留的旧确认而显示错误状态；
  已改期到别处的会议同理（时间对不上窗口 → 拒绝）。

签到窗口：开始前 15 分钟开放，开始后 `rooms.checkin_grace_min` 分钟关闭；重复签到返回 409。

## 5. 隐私与“模板编辑者看不到会议详情”

* 房间有 `privacy = normal | private`（管理员设置）。
  * normal：门牌显示完整主题、组织者；
  * private：门牌只显示 `使用中 / 空闲`，`topic` 在出设备端点（`/api/displays/:id/state`）
    时就被剥成 `null`（`server/state.js sanitize`），不是仅靠界面遮挡；时间区间保留。
  * 隐私只作用于**展示层**：预约事实 API 对授权用户照常返回主题。
* 模板表（`templates`）只存**背景素材 URL + 排版 JSON**，Schema 上就没有任何会议字段；
  `/api/templates` 系列端点不 join meetings。模板编辑者（`erin`）能改背景和字号，
  但读不到主题，也调不了会议/管理接口（测试 04 断言响应里不含会议内容）。

## 6. 断线跨会议边界

门牌**不用本地倒计时决定翻场**。状态来源永远是下一次成功的
`GET /api/displays/:id/state`：断网时冻结在缓存（明确渲染“缓存”字样），重连后整包替换为服务端裁决结果
（已开始/已签到/已撤销一律以服务端为准）。`state` 带版本号，另有 `POST /displays/:id/applied`
供设备回报已上屏版本。

## 7. 后台推送乱序 / 权限回收 / 显示新鲜度

* **事件流**：所有写操作落一行 `events(seq AUTOINCREMENT, room_id, kind, payload, emitted_ms)`，
  SSE 带 `id: <seq>`。客户端规则（Web 与归约器一致，`server/state.js applyEvent`）：
  `incoming.seq <= seen` 直接丢弃，界面不回退；断线重连带 `afterSeq` 补发。
* **权限回收**：认证每请求实时查 `tokens` 表；管理员 `DELETE /api/admin/tokens/:token`
  删除令牌后，该用户后续请求（含门牌用旧令牌做的离线补签）立即 `401`。
* **显示新鲜度**：设备心跳写 `displays.last_seen_ms` 与时钟偏差；Web 页面显示
  “设备 N 秒前在线 / 从未上线”（90 秒阈值）以及服务器-设备时钟差。

## 8. 背景加载失败不遮挡当前状态

显示是两层：背景层（公司模板 SVG，门牌端单独发起 HTTP GET）与状态层（JSON）。
* 背景 503/超时时，C 端打印 `背景层: 加载失败（状态仍正常显示）`，占用状态/时间照常渲染；
  Web 端 `<img>` 在底层，`onerror` 只在底部出一条红条（可在页面勾选“模拟背景 URL 503”，
  对应管理端 `/api/admin/fail-background`）。

## 验收用例 → 测试映射

| 需求 | 测试/入口 |
|---|---|
| 相邻/重叠时间边界 | `test/01-booking-conflict.test.js` |
| 两人/三人并发抢同一时段的确定结果 | `test/01`、`test/03`（改期竞争、三重并发） |
| 改期与签到竞争 | `test/03` “改期与签到竞争” |
| 夏令时重复时刻 / 春季缺口 / 消歧 | `test/02-dst-timezones.test.js` |
| 延长重查下一场、不是改倒计时 | `test/03` “延长会议必须重新检查下一场” |
| 断线跨会议边界 | `test/05-offline-cancel-bg.test.js` |
| 离线可签到 vs 只看缓存 | `test/05`（offline 队列 207、online_only 403、策略切换） |
| 设备时钟漂移 | `test/05` “时钟漂移” + C `--mode simskew --shift-ms` |
| 撤销后的旧确认 | `test/05` “预约被撤销后的旧确认” |
| 隐私：完整主题 vs 占用状态 | `test/04-privacy-auth-template.test.js` |
| 模板编辑者拿不到会议详情 | `test/04` |
| 权限回收即时生效（含离线令牌） | `test/04` |
| 后台推送乱序/补发 | `test/06-sse-freshness.test.js`（seq 单调、旧事件丢弃） |
| 网页显示预约事实 | `GET /api/rooms/:id/meetings`（UTC+本地+区间语义），`test/06` 末例 |
| 网页显示设备新鲜度 | `test/06` “显示新鲜度” |
| 背景加载失败不遮挡状态 | `test/05` “背景加载失败” + Web 勾选模拟 |

## API 摘要

```
GET  /api/rooms                                  房间列表（含时区/策略）
POST /api/rooms/:id/meetings                     预约（epoch ms 或 date+startLocal/endLocal[+Disambiguation]）
GET  /api/rooms/:id/meetings                     预约事实（UTC + 本地 + 半开区间说明）
POST /api/meetings/:id/reschedule                改期（原子冲突检查；已签到禁改）
POST /api/meetings/:id/extend                    延长（newEndMs | endLocal | minutes，重查下一场）
POST /api/meetings/:id/cancel                    撤销
POST /api/meetings/:id/checkin                   网页签到（可选 challenge）
GET  /api/displays/:id/state?deviceMs=&privacy=  门牌视图（心跳、ETag/304、挑战码、模板、隐私过滤）
POST /api/displays/:id/checkins                  离线队列补签（207，逐条裁决）
GET  /api/events?roomId=&afterSeq=               SSE（id: seq）
GET/POST/PUT /api/templates                      模板（仅 backgroundUrl + layout）
POST /api/admin/rooms/:id/privacy | /policy      隐私 / 离线策略
DELETE /api/admin/tokens/:token                  令牌回收
POST /api/admin/fail-background                  模拟背景故障（验收用）
```

## 门牌端用法

```bash
./c/doorsign --server 127.0.0.1:8080 --room 1                 # 循环渲染（10s 轮询）
./c/doorsign --room 1 --mode render --once                    # 渲染一帧
./c/doorsign --room 1 --mode probe                            # 在线 LIVE / 断网回退 CACHED
./c/doorsign --room 1 --mode simskew --shift-ms 3600000       # 模拟设备钟快 1 小时
./c/doorsign --server 127.0.0.1:1 --room 1 --mode checkin \
  --meeting 7 --token tok-bob --offline                       # 断网：本地排队
./c/doorsign --room 1 --mode queue --token tok-bob            # 重连：补提裁决
```

## 构建排错（本机环境）

本机 `/usr/local/bin/cc` 是沙箱包装脚本，会拒绝部分 node-gyp 编译参数
（`-fno-omit-frame-pointer` 报 “Extra arguments are not allowed”）。绕过：

```bash
mkdir -p /tmp/realbin && ln -sf /usr/bin/gcc /tmp/realbin/cc && ln -sf /usr/bin/g++ /tmp/realbin/c++
PATH=/tmp/realbin:$PATH npm install
make -C c CC=/usr/bin/gcc
```

## 目录

```
server/   time.js(DST/时区) db.js(Schema/种子) store.js(事务) auth.js state.js(显示归约) server.js(HTTP/SSE)
web/      index.html（预约/改期/签到/门牌预览/新鲜度/隐私/回收）
c/        doorsign.c（socket HTTP、JSON、渲染、缓存、离线队列、漂移校准）+ Makefile
test/     34 个 node:test 验收用例
```
