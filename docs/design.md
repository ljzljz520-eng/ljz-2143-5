# 设计说明

## 关系模型

- `users`：用户与角色。
- `rooms`：房间、IANA 时区、默认隐私和背景模板 URL。
- `room_grants`：房间级 `booker`、`viewer`、`template_editor` 授权，回收以 `revoked_at` 保留审计事实。
- `meetings`：会议主事实。时间列包括 UTC、本地墙钟、offset、DST 歧义选择、状态和版本。
- `meeting_events`：会议生命周期事件，全局自增 ID，会议内 `seq` 从 1 开始。
- `devices`：门牌令牌哈希、离线策略、权限 epoch、最后已缓存会议 ID 列表和心跳。
- `device_cache_checkins`：所有离线确认及最终裁决，不删除被拒绝的旧确认。
- `background_assets/background_acl`：背景资产与“不能读会议详情”的显式 ACL 标记。

## 冲突判定

活动会议状态为 `booked` 或 `checked_in`。候选区间与已有活动区间冲突当且仅当：

```sql
existing.startUtc < candidate.endUtc
AND existing.endUtc > candidate.startUtc
```

这就是半开区间重叠条件；端点相等不冲突。

## 离线签到状态机

1. 设备在线拉取快照，服务端记录该设备已缓存的会议 ID。
2. 断线时只读设备不写；可写设备把本地确认追加到持久 JSONL 队列。
3. 上传时进入 `BEGIN IMMEDIATE`：
   - 设备撤销：`rejected_device_revoked`；
   - 会议不在最后授权缓存：`rejected_stale`；
   - 会议取消：`rejected_cancelled`；
   - 已有签到：`rejected_duplicate`；
   - 时钟不确定区间不交会签到窗口：`rejected_outside_window`；
   - 同步点过旧：`rejected_stale`；
   - 否则接受，并只追加一次 `checked_in` 事件。

## 故障优先级

门牌状态层永远独立于背景层：

1. 服务端会议事实；
2. 设备认证与策略；
3. 快照/缓存新鲜度；
4. 背景模板视觉。

因此背景 404、SVG 解码失败或缓存缺失不能让房间当前状态被遮罩或误报为空闲。
