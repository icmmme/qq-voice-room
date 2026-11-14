# QQ Voice Room

一个正在开发的 QQ 群聊实验：让两个有独立人设的 AI 角色成为群友。群成员可以 @ 一个角色，也可以同时 @ 两个，让它们按顺序回复。默认用文字，接入 Fish Audio 后也可以发语音。

这是开发中的源码快照。QQ 接入和配置目前主要用于作者自己的测试环境，还在调整。想先看看现在的效果，可以从离线演示开始。

## 先试离线演示

需要 Node.js 24 或更高版本。在仓库根目录运行：

```sh
npm ci
npm run demo
npm test
```

Windows PowerShell 如拦截 `npm.ps1`，使用 `npm.cmd`。演示向两个虚构角色发出一个双 @ 请求，使用 V2 的请求队列和投递流程；模型和消息回执均为本地模拟，不需要 Key、QQ 账号或 TTS。

## QQ 测试群接入参考

1. 复制 `.env.example` 为 `.env`，将 `examples/voice-room/` 复制到 `local/voice-room/`。把 `ROOM_CONFIG` 改为 `local/voice-room/room.example.json`，在该 JSON 里填入你自己的群 ID、房主 ID、两个角色各自的 QQ ID，并将 `dataDir` 改为相对于 JSON 的独立目录，例如 `./data`。公开人设文件也相对于该 JSON。
2. 填写模型 API 基址、模型标识、Key 和两组不同的 OneBot 连接 Token。两个 NapCat 账号使用 OneBot v11 Universal 反向 WebSocket、array 消息格式，默认应分别连到 `ws://127.0.0.1:3011/room/account-a` 和 `ws://127.0.0.1:3011/room/account-b`。连接 Bearer Token 需与各自 `.env` 设置匹配。
3. 在仓库根目录运行 `npm run room:doctor` 检查配置，再运行 `npm run room:qq`。两个账号连接后，在群里 @ 角色，先验证文字回复。
4. 需要语音时，填写 `FISH_*` 配置和两套有权使用的参考音色，把 JSON 的 `deliveryMode` 改为 `both`，重新检查后启动。

预览重点是显式 @、请求排队和文字／语音投递。自然接话、话题图和房间长期记忆尚未完成。房间数据库和配置存放在本地独立目录；启用在线模型或 TTS 时，处理消息会调用相应服务。

## 项目起源

QQ Voice Room 源自 PA 的 Voice Room 实验，可以独立运行，使用自己的角色文件、配置和 SQLite 数据库。首次公开快照来自内部 V2 源码基线 `95e3b1e`。
