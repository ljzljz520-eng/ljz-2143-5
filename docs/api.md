# HTTP API 摘要

认证使用 `Authorization: Bearer <session-token>`；门牌使用 `X-Device-Token`。

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/login` | 换取会话令牌 |
| `GET /api/rooms` | 当前用户可访问房间 |
| `GET /api/meetings?roomId=&fromUtc=&toUtc=` | 会议事实列表 |
| `POST /api/meetings` | 创建预约；服务端原子冲突检查 |
| `POST /api/meetings/reschedule` | 改期；支持 `expectedVersion` |
| `POST /api/meetings/extend` | 只延长结束时间并检查下一场 |
| `POST /api/meetings/cancel` | 撤销预约 |
| `POST /api/meetings/checkin` | 在线签到 |
| `POST /api/meetings/privacy` | 设置 `inherit/full_subject/busy_only` |
| `GET /api/events?after=<global-id>` | 全局有序事件；支持 `If-None-Match` |
| `GET /api/door` | 门牌投影快照与新鲜度元数据 |
| `POST /api/door/checkin` | 离线签到上传，服务端重新裁决 |
| `POST /api/template` | 模板编辑者更新背景 URL，不返回会议详情 |
| `POST /api/admin/devices` | 注册门牌及离线策略 |
| `POST /api/admin/devices/revoke` | 撤销门牌令牌并清空离线写缓存 |
| `POST /api/admin/grants/revoke` | 原子回收房间授权并失效设备缓存写权限 |

时间请求示例：

```json
{
  "roomId": 1,
  "subject": "Design review",
  "startLocal": "2026-11-01T01:30",
  "endLocal": "2026-11-01T02:30",
  "timezone": "America/New_York",
  "dstOccurrence": "first",
  "privacy": "busy_only"
}
```
