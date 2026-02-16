# DingTalk MCP Server for OpenCode

钉钉 MCP 服务器 - 让 OpenCode 与钉钉机器人无缝集成

## 🌟 项目简介

DingTalk MCP Server 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的服务器，它将钉钉机器人与 OpenCode AI 助手连接起来，实现双向消息通信。

### 核心功能

- ✅ **实时消息接收** - 通过钉钉 Stream 模式实时接收消息
- ✅ **AI 自动回复** - 将消息转发给 OpenCode 处理并自动回复
- ✅ **手动发送消息** - 通过 MCP 工具手动发送消息到钉钉
- ✅ **消息去重** - 防止重复处理同一消息
- ✅ **频率限制** - 遵守钉钉 API 限制（20条/分钟）
- ✅ **长消息分片** - 自动处理超过 20KB 的长消息

## 🏗️ 架构设计

### 系统架构图

```
┌─────────────┐      WebSocket       ┌──────────────────┐
│   钉钉用户   │ ◄──────────────────► │  DingTalk Stream  │
└─────────────┘                      │     (钉钉云端)    │
                                     └────────┬─────────┘
                                              │
                                     WebSocket│Stream
                                              │
                                     ┌────────▼─────────┐
                                     │  DingTalk MCP    │
                                     │     Server       │
                                     │  (本服务器)       │
                                     └────────┬─────────┘
                                              │
                                     MCP Stdio│Protocol
                                              │
                                     ┌────────▼─────────┐
                                     │     OpenCode     │
                                     │   (AI 助手)      │
                                     └──────────────────┘
```

### 数据流

1. **接收消息流程**
   ```
   钉钉用户发送消息
         ↓
   钉钉 Stream 服务器
         ↓
   DingTalk MCP Server (通过 WebSocket 接收)
         ↓
   消息处理（去重、解析）
         ↓
   转发到 OpenCode (通过 MCP)
         ↓
   OpenCode AI 处理
         ↓
   获取 AI 回复
         ↓
   通过 sessionWebhook 发送回钉钉
   ```

2. **发送消息流程**
   ```
   OpenCode 调用 MCP 工具
         ↓
   dingtalk_send_message
         ↓
   查找 sessionWebhook
         ↓
   发送到钉钉
   ```

## 🔑 关键节点说明

### 1. 连接管理

#### DingTalk Stream 连接
- **技术**: 使用 `dingtalk-stream-sdk-nodejs` 建立 WebSocket 连接
- **模式**: Stream 模式（非 Webhook）
- **优势**: 
  - 实时双向通信
  - 无需公网 IP
  - 自动重连

```javascript
const dingtalkClient = new DWClient({
  clientId: process.env.DINGTALK_CLIENT_ID,
  clientSecret: process.env.DINGTALK_CLIENT_SECRET,
});

dingtalkClient
  .registerCallbackListener("/v1.0/im/bot/messages/get", handleMessage)
  .connect();
```

#### MCP 服务器连接
- **传输层**: STDIO (Standard Input/Output)
- **协议**: JSON-RPC 2.0
- **优势**: 
  - 简单可靠
  - 无需网络端口
  - 适合本地集成

```javascript
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 2. 核心类设计

#### SessionWebhookManager
管理钉钉会话的 Webhook 地址，用于发送回复。

```javascript
class SessionWebhookManager {
  // 保存 Webhook
  setWebhook(conversationId, url, expiredTime)
  
  // 获取 Webhook（自动检查过期）
  getWebhook(conversationId)
  
  // 统计信息
  getStats()
}
```

**关键点**:
- Webhook 有过期时间（通常几小时）
- 需要定期清理过期 Webhook
- 首次收到消息时获取 Webhook

#### MessageQueue
管理消息发送队列，处理频率限制和消息分片。

```javascript
class MessageQueue {
  // 发送消息（自动处理频率限制）
  async send(webhook, message)
  
  // 频率限制：20条/分钟
  MAX_MESSAGES_PER_MINUTE = 20
  
  // 消息大小限制：20KB
  MAX_MESSAGE_SIZE = 20 * 1024
  
  // 长消息自动分片
  async sendLongMessage(webhook, message)
}
```

**关键点**:
- 钉钉限制：每分钟最多 20 条消息
- 单条消息最大 20KB
- 超出限制自动等待和分片

### 3. 消息处理流程

#### 消息去重机制
- **方法**: 基于 msgId 的内存缓存
- **窗口**: 5 分钟
- **实现**:

```javascript
const processedMessages = new Map();

function isMessageProcessed(msgId) {
  const processed = processedMessages.get(msgId);
  if (processed) {
    const timeSince = Date.now() - processed;
    if (timeSince < 5 * 60 * 1000) {
      return true; // 重复消息
    }
  }
  return false;
}
```

#### 消息解析
钉钉消息格式：
```json
{
  "msgId": "...",
  "conversationId": "...",
  "senderStaffId": "...",
  "text": {
    "content": "消息内容"
  },
  "sessionWebhook": "https://...",
  "sessionWebhookExpiredTime": 1234567890
}
```

### 4. OpenCode 集成

#### 会话管理
- 每个钉钉会话对应一个 OpenCode 会话
- 会话 ID 存储在内存中
- 重启后需要重新创建会话

```javascript
const sessions = new Map(); // conversationId -> sessionId

// 创建或获取会话
let sessionId = sessions.get(conversationId);
if (!sessionId) {
  const session = await opencodeClient.session.create({
    body: { title: `钉钉会话-${conversationId}` }
  });
  sessionId = session.data.id;
  sessions.set(conversationId, sessionId);
}
```

#### 消息转发
```javascript
const result = await opencodeClient.session.prompt({
  path: { id: sessionId },
  body: { 
    parts: [{ type: "text", text: content }] 
  },
});

const reply = result.data.parts
  .filter(p => p.type === "text")
  .map(p => p.text)
  .join("\n");
```

### 5. MCP 工具设计

#### 工具列表

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `dingtalk_send_message` | 发送文本消息 | `conversationId`, `content` |
| `dingtalk_get_stats` | 获取统计信息 | 无 |
| `dingtalk_list_conversations` | 列出会话 | 无 |

#### 工具注册
```javascript
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'dingtalk_send_message',
        description: '发送文本消息到钉钉',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['conversationId', 'content']
        }
      }
      // ... 其他工具
    ]
  };
});
```

## 🚀 快速开始

### 1. 获取钉钉应用凭证

1. 访问 [钉钉开放平台](https://open.dingtalk.com/)
2. 创建企业内部应用
3. 获取 **Client ID** 和 **Client Secret**

### 2. 安装依赖

```bash
cd dingtalk-mcp-server
npm install
```

### 3. 配置环境变量

复制 `.env.example` 到 `.env` 并填写你的凭证：

```bash
cp .env.example .env
# 编辑 .env 文件
```

```env
DINGTALK_CLIENT_ID=your_client_id
DINGTALK_CLIENT_SECRET=your_client_secret
OPENCODE_SERVER_URL=http://127.0.0.1:4096
```

### 4. 启动服务器

```bash
npm start
```

### 5. 配置 OpenCode

在 OpenCode 配置文件（`~/.config/opencode/opencode.json`）中添加：

```json
{
  "mcp": {
    "dingtalk": {
      "type": "local",
      "command": [
        "node",
        "/path/to/dingtalk-mcp-server/index.mjs"
      ],
      "enabled": true
    }
  }
}
```

### 6. 测试

在钉钉中给机器人发送消息，观察终端输出。

## 📖 使用方式

### 方式 1：直接运行

```bash
npm start
```

服务器会：
- 连接到钉钉 Stream
- 接收消息并转发给 OpenCode
- 自动将 OpenCode 回复发送回钉钉

### 方式 2：在 OpenCode 中使用 MCP 工具

启动 OpenCode 后，可以使用以下命令：

#### 获取统计信息
```
使用 dingtalk 工具获取统计信息
```

#### 发送消息
```
使用 dingtalk 工具发送消息 "你好" 到会话 [conversationId]
```

#### 列出会话
```
使用 dingtalk 工具列出会话
```

### 方式 3：获取 Conversation ID

1. 启动服务器
2. 在钉钉中发送消息
3. 查看终端输出，复制 `会话ID`
4. 使用该 ID 发送消息

## 🔧 高级配置

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 必填 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 必填 |
| `OPENCODE_SERVER_URL` | OpenCode 服务器地址 | http://127.0.0.1:4096 |
| `LOG_LEVEL` | 日志级别 | info |

### 频率限制配置

在代码中修改 `MessageQueue` 类：

```javascript
class MessageQueue {
  constructor() {
    this.MAX_MESSAGES_PER_MINUTE = 20;  // 每分钟最大消息数
    this.MAX_MESSAGE_SIZE = 20 * 1024;  // 最大消息大小（字节）
  }
}
```

### 消息去重窗口

```javascript
// 修改去重窗口（默认 5 分钟）
const DEDUPLICATION_WINDOW = 5 * 60 * 1000; // 毫秒
```

## 🐛 故障排除

### 问题 1：连接失败

**现象**: `连接钉钉 Stream 失败`

**解决**:
1. 检查 Client ID 和 Client Secret
2. 确认钉钉应用已启用
3. 检查网络连接

### 问题 2：无法发送消息

**现象**: `没有找到有效的 sessionWebhook`

**解决**:
1. 先在钉钉中发送一条消息
2. 检查会话 ID 是否正确
3. 确认 sessionWebhook 未过期

### 问题 3：OpenCode 中看不到工具

**解决**:
1. 检查 OpenCode 配置
2. 重启 OpenCode
3. 运行 `opencode mcp list` 查看状态

## 📝 项目结构

```
dingtalk-mcp-server/
├── index.mjs           # 主程序
├── package.json        # 项目配置
├── .env.example        # 环境变量示例
├── .env               # 环境变量（不提交）
└── README.md          # 项目文档
```

## 🤝 贡献

欢迎提交 Issue 和 PR！

## 📄 许可证

MIT License

## 🔗 相关链接

- [钉钉开放平台](https://open.dingtalk.com/)
- [钉钉 Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- [OpenCode](https://opencode.ai/)
- [MCP 协议](https://modelcontextprotocol.io/)

---

**祝您使用愉快！** 🎉
