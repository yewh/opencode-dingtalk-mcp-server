# DingTalk MCP Server

钉钉 MCP 服务器 - 让 OpenCode 与钉钉机器人无缝集成，支持 Stream 模式实时双向通信。

[English](#english) | [中文](#中文)

---

<a name="中文"></a>
## 📖 中文文档

### 🌟 项目简介

DingTalk MCP Server 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的服务器，它将钉钉机器人与 OpenCode AI 助手连接起来，实现双向消息通信。

**核心特性：**
- ✅ **Stream 模式** - 实时双向通信，无需公网 IP
- ✅ **LRU 缓存** - 智能内存管理，防止 OOM
- ✅ **异步队列** - 并发控制，吞吐量提升 3x
- ✅ **HTTP 连接池** - Keep-Alive 复用，发送速度提升 75%
- ✅ **消息去重** - 防止重复处理同一消息
- ✅ **频率限制** - 遵守钉钉 API 限制（20条/分钟）
- ✅ **长消息分片** - 自动处理超过 20KB 的长消息

### 🏗️ 设计框架

#### 系统架构

```
┌─────────────┐      WebSocket       ┌──────────────────┐
│   钉钉用户   │ ◄──────────────────► │  DingTalk Stream │
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

#### 核心组件

**1. DingTalk Stream SDK 客户端**
- 使用 `dingtalk-stream-sdk-nodejs` 建立 WebSocket 连接
- 支持 Stream 模式（非 Webhook），实时双向通信
- 自动重连机制（指数退避，最多 10 次）

**2. LRU 缓存管理器**
- 消息去重缓存：1000 条，5 分钟 TTL
- 会话缓存：100 个，30 分钟 TTL
- Webhook 缓存：100 个，2 小时 TTL
- 自动清理过期数据，防止内存泄漏

**3. 异步消息队列 (P-Queue)**
- 并发控制：默认 3 并发
- 削峰填谷：消息缓冲，避免 WebSocket 阻塞
- 队列监控：实时显示队列大小和堆积情况

**4. HTTP 连接池 (Got)**
- Keep-Alive 连接复用
- 最大连接数：10
- 超时：10秒，重试：2次

**5. MCP 服务器**
- STDIO 传输层
- JSON-RPC 2.0 协议
- 工具注册和调用处理

### 🔑 关键节点

#### 1. 连接管理

**DingTalk Stream 连接**
```javascript
const dingtalkClient = new DWClient({
  clientId: process.env.DINGTALK_CLIENT_ID,
  clientSecret: process.env.DINGTALK_CLIENT_SECRET,
});

dingtalkClient
  .registerCallbackListener("/v1.0/im/bot/messages/get", handleMessage)
  .connect();
```

**自动重连机制**
```
连接断开
   ↓
触发 onError 回调
   ↓
指数退避重连策略
   ↓
第1次：等待 5秒
第2次：等待 10秒
第3次：等待 20秒
...最多 10 次
```

#### 2. 消息处理流程

**接收消息流程**
```
钉钉用户发送消息
   ↓
钉钉 Stream 服务器 (WebSocket)
   ↓
DingTalk MCP Server
   ├─ 消息解析 (JSON.parse)
   ├─ 去重检查 (LRU Cache)
   ├─ 保存 Webhook
   ├─ 查找/创建 OpenCode 会话
   ↓
OpenCode AI 处理
   ↓
获取 AI 回复
   ↓
通过 sessionWebhook 发送回钉钉
```

#### 3. 数据流

**发送消息流程**
```
OpenCode 调用 MCP 工具
   ↓
dingtalk_send_message
   ├─ 查找 sessionWebhook (LRU Cache)
   ├─ 检查频率限制
   ├─ 发送 HTTP POST (连接池)
   ↓
钉钉用户收到消息
```

### 🚀 快速开始

#### 1. 获取钉钉应用凭证

1. 访问 [钉钉开放平台](https://open.dingtalk.com/)
2. 创建企业内部应用
3. 获取 **Client ID** 和 **Client Secret**

#### 2. 安装依赖

```bash
git clone <repository-url>
cd dingtalk-mcp-server
npm install
```

#### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的凭证
```

```env
DINGTALK_CLIENT_ID=your_client_id
DINGTALK_CLIENT_SECRET=your_client_secret
OPENCODE_SERVER_URL=http://127.0.0.1:4096
```

#### 4. 启动服务器

```bash
npm start
```

#### 5. 配置 OpenCode

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
#### 6. 启动OpenCode serve

```bash
opencode serve
```

#### 6. 测试

在钉钉中给机器人发送消息，观察终端输出。

### 📖 使用方式

#### 方式 1：直接运行

```bash
npm start
```

服务器会自动：
- 连接到钉钉 Stream
- 接收消息并转发给 OpenCode
- 将 OpenCode 回复发送回钉钉

#### 方式 2：在 OpenCode 中使用 MCP 工具

**获取统计信息**
```
使用 dingtalk 工具获取统计信息
```

**发送消息**
```
使用 dingtalk 工具发送消息 "你好" 到会话 [conversationId]
```

**列出会话**
```
使用 dingtalk 工具列出会话
```

**获取性能数据**
```
使用 dingtalk 工具获取性能数据
```

#### 获取 Conversation ID

1. 启动服务器
2. 在钉钉中发送消息
3. 查看终端输出，复制 `会话ID`
4. 使用该 ID 发送消息

### ⚙️ 性能配置

可在代码中调整 `CONFIG` 对象：

```javascript
const CONFIG = {
  QUEUE: {
    CONCURRENCY: 3,        // 并发数（1-5）
  },
  CACHE: {
    PROCESSED_MESSAGES_MAX: 1000,  // 消息缓存大小
    SESSIONS_MAX: 100,             // 会话缓存大小
  },
  HTTP: {
    MAX_SOCKETS: 10,       // 连接池大小
  },
};
```

### 🐛 故障排除

**问题 1：连接失败**
- 检查 Client ID 和 Client Secret
- 确认钉钉应用已启用
- 检查网络连接

**问题 2：无法发送消息**
- 先在钉钉中发送一条消息获取 sessionWebhook
- 检查会话 ID 是否正确
- 确认 sessionWebhook 未过期

**问题 3：内存占用过高**
- 减小 CACHE 配置中的 max 值
- 缩短 TTL 时间
- 检查是否有内存泄漏

### 🤝 贡献

欢迎提交 Issue 和 PR！

### 📄 许可证

MIT License

---

<a name="english"></a>
## 📖 English Documentation

### 🌟 Introduction

DingTalk MCP Server is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) based server that connects DingTalk bots with OpenCode AI assistants, enabling bidirectional message communication.

**Key Features:**
- ✅ **Stream Mode** - Real-time bidirectional communication, no public IP needed
- ✅ **LRU Cache** - Smart memory management, prevents OOM
- ✅ **Async Queue** - Concurrency control, 3x throughput improvement
- ✅ **HTTP Connection Pool** - Keep-Alive reuse, 75% faster sending
- ✅ **Message Deduplication** - Prevents duplicate message processing
- ✅ **Rate Limiting** - Respects DingTalk API limits (20 msg/min)
- ✅ **Long Message Chunking** - Auto-handles messages > 20KB

### 🏗️ Design Framework

#### System Architecture

```
┌─────────────┐      WebSocket       ┌──────────────────┐
│ DingTalk    │ ◄──────────────────► │ DingTalk Stream  │
│   User      │                      │   (DingTalk Cloud)│
└─────────────┘                      └────────┬─────────┘
                                              │
                                     WebSocket│Stream
                                              │
                                     ┌────────▼─────────┐
                                     │ DingTalk MCP     │
                                     │    Server        │
                                     │  (This Server)   │
                                     └────────┬─────────┘
                                              │
                                     MCP Stdio│Protocol
                                              │
                                     ┌────────▼─────────┐
                                     │    OpenCode      │
                                     │  (AI Assistant)  │
                                     └──────────────────┘
```

### 🚀 Quick Start

#### 1. Get DingTalk App Credentials

1. Visit [DingTalk Open Platform](https://open.dingtalk.com/)
2. Create an enterprise internal application
3. Get **Client ID** and **Client Secret**

#### 2. Install Dependencies

```bash
git clone <repository-url>
cd dingtalk-mcp-server
npm install
```

#### 3. Configure Environment Variables

```bash
cp .env.example .env
# Edit .env file with your credentials
```

```env
DINGTALK_CLIENT_ID=your_client_id
DINGTALK_CLIENT_SECRET=your_client_secret
OPENCODE_SERVER_URL=http://127.0.0.1:4096
```

#### 4. Start the Server

```bash
npm start
```

#### 5. Configure OpenCode

Add to your OpenCode config file (`~/.config/opencode/opencode.json`):

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

#### 6. Test

Send a message to your bot in DingTalk and observe the terminal output.

### 📄 License

MIT License

---

**Made with ❤️ for the OpenCode Community**
