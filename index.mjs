import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { DWClient } from "dingtalk-stream-sdk-nodejs";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 使用绝对路径加载 .env 文件
dotenv.config({ path: join(__dirname, '.env') });

// ============ 配置和初始化 ============
console.error("🚀 启动 DingTalk MCP Server...");

if (!process.env.DINGTALK_CLIENT_ID || !process.env.DINGTALK_CLIENT_SECRET) {
  console.error("❌ 错误：请设置 DINGTALK_CLIENT_ID 和 DINGTALK_CLIENT_SECRET");
  process.exit(1);
}

const opencodeClient = createOpencodeClient({
  baseUrl: process.env.OPENCODE_SERVER_URL || "http://localhost:4096",
});

const dingtalkClient = new DWClient({
  clientId: process.env.DINGTALK_CLIENT_ID,
  clientSecret: process.env.DINGTALK_CLIENT_SECRET,
});

// ============ 核心类 ============

class SessionWebhookManager {
  constructor() {
    this.webhooks = new Map();
  }

  getWebhook(conversationId) {
    const webhook = this.webhooks.get(conversationId);
    if (!webhook) return null;
    if (Date.now() > webhook.expiredTime) {
      console.error(`⚠️  SessionWebhook 已过期: ${conversationId}`);
      this.webhooks.delete(conversationId);
      return null;
    }
    return webhook.url;
  }

  setWebhook(conversationId, url, expiredTime) {
    this.webhooks.set(conversationId, { url, expiredTime });
    console.error(`💾 保存 SessionWebhook: ${conversationId}`);
  }

  getStats() {
    return {
      total: this.webhooks.size,
      active: Array.from(this.webhooks.values()).filter(w => Date.now() <= w.expiredTime).length
    };
  }
}

class MessageQueue {
  constructor() {
    this.lastSendTime = 0;
    this.sendCount = 0;
    this.MAX_MESSAGES_PER_MINUTE = 20;
    this.MAX_MESSAGE_SIZE = 20 * 1024;
  }

  async send(webhook, message) {
    if (message.length > this.MAX_MESSAGE_SIZE) {
      console.error(`📏 消息过大 (${message.length} bytes)，需要分片`);
      await this.sendLongMessage(webhook, message);
      return;
    }
    await this.waitForRateLimit();
    await this.sendMessage(webhook, message);
    this.sendCount++;
    this.lastSendTime = Date.now();
  }

  async sendMessage(webhook, message) {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: message },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
  }

  async sendLongMessage(webhook, message) {
    const chunks = [];
    for (let i = 0; i < message.length; i += this.MAX_MESSAGE_SIZE) {
      chunks.push(message.slice(i, i + this.MAX_MESSAGE_SIZE));
    }
    console.error(`📦 分成 ${chunks.length} 个片段`);
    for (let i = 0; i < chunks.length; i++) {
      console.error(`📤 发送片段 ${i + 1}/${chunks.length}`);
      await this.sendMessage(webhook, chunks[i]);
      if (i < chunks.length - 1) await this.sleep(1000);
    }
  }

  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;
    if (this.sendCount >= this.MAX_MESSAGES_PER_MINUTE && timeSinceLastSend < 60000) {
      const waitTime = 60000 - timeSinceLastSend;
      console.error(`⏳ 达到频率限制，等待 ${Math.ceil(waitTime / 1000)} 秒`);
      await this.sleep(waitTime);
      this.sendCount = 0;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      sendCount: this.sendCount,
      lastSendTime: this.lastSendTime
    };
  }
}

// ============ 全局状态 ============
const sessions = new Map();
const processedMessages = new Map();
const webhookManager = new SessionWebhookManager();
const messageQueue = new MessageQueue();

// ============ 消息处理函数 ============

function isMessageProcessed(msgId) {
  const processed = processedMessages.get(msgId);
  if (processed) {
    const timeSinceProcessed = Date.now() - processed;
    if (timeSinceProcessed < 5 * 60 * 1000) {
      console.error(`⚠️  检测到重复消息 (msgId: ${msgId})`);
      return true;
    } else {
      processedMessages.delete(msgId);
      return false;
    }
  }
  return false;
}

function markMessageProcessed(msgId) {
  processedMessages.set(msgId, Date.now());
}

async function handleDingTalkMessage(res) {
  console.error("\n📨 收到钉钉消息");
  try {
    const { messageId } = res.headers;
    const data = JSON.parse(res.data);
    const { text, senderStaffId, sessionWebhook, sessionWebhookExpiredTime, conversationId, msgId } = data;

    if (isMessageProcessed(msgId)) {
      console.error("🔄 忽略重复消息");
      return;
    }
    markMessageProcessed(msgId);

    let content = "";
    if (typeof text === 'string') {
      content = text;
    } else if (text && typeof text === 'object') {
      content = text.content || "";
    }

    const finalConversationId = conversationId || sessionWebhook || senderStaffId || messageId;
    console.error(`💬 会话ID: ${finalConversationId}`);
    console.error(`📝 消息内容: ${content}`);

    if (sessionWebhook && sessionWebhookExpiredTime) {
      webhookManager.setWebhook(finalConversationId, sessionWebhook, sessionWebhookExpiredTime);
    }

    if (!content) return;

    // 发送到 OpenCode 处理
    let sessionId = sessions.get(finalConversationId);
    if (!sessionId) {
      console.error("🆕 创建新会话...");
      const session = await opencodeClient.session.create({
        body: { title: `钉钉会话-${finalConversationId}` },
      });
      sessionId = session.data?.id;
      if (sessionId) {
        sessions.set(finalConversationId, sessionId);
        console.error(`✅ 会话创建成功: ${sessionId}`);
      }
    } else {
      console.error(`🔄 使用现有会话: ${sessionId}`);
    }

    console.error("📤 发送消息到 OpenCode...");
    const result = await opencodeClient.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: content }] },
    });

    const reply = result.data?.parts
      ?.filter(p => p.type === "text")
      ?.map(p => p.text)
      ?.join("\n") || "没有收到回复";

    console.error(`💬 回复内容: ${reply}`);

    // 发送回复到钉钉
    const webhook = webhookManager.getWebhook(finalConversationId);
    if (webhook) {
      await messageQueue.send(webhook, reply);
      console.error("✅ 回复已发送到钉钉");
    }

  } catch (error) {
    console.error("❌ 处理消息失败:", error.message);
  }
}

// ============ MCP 服务器设置 ============

const server = new Server(
  {
    name: 'dingtalk-mcp-server',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'dingtalk_send_message',
        description: '发送文本消息到钉钉',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: '会话ID（从收到的消息中获取）',
            },
            content: {
              type: 'string',
              description: '消息内容',
            },
          },
          required: ['conversationId', 'content'],
        },
      },
      {
        name: 'dingtalk_get_stats',
        description: '获取 DingTalk MCP 服务器统计信息',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'dingtalk_list_conversations',
        description: '列出当前活跃的会话',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'dingtalk_send_message': {
        const { conversationId, content } = args;
        const webhook = webhookManager.getWebhook(conversationId);
        
        if (!webhook) {
          return {
            content: [{ type: 'text', text: `❌ 错误：没有找到有效的 sessionWebhook，会话ID: ${conversationId}\n\n💡 提示：需要先收到该会话的消息，才能获取 sessionWebhook 并发送回复。` }],
            isError: true,
          };
        }

        await messageQueue.send(webhook, content);
        return {
          content: [{ type: 'text', text: `✅ 消息发送成功到会话 ${conversationId}` }],
        };
      }

      case 'dingtalk_get_stats': {
        const stats = {
          server: {
            version: '2.0.0',
            connected: true,
          },
          sessions: {
            total: sessions.size,
            ids: Array.from(sessions.keys()),
          },
          messages: {
            processed: processedMessages.size,
            queue: messageQueue.getStats(),
          },
          webhooks: webhookManager.getStats(),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
        };
      }

      case 'dingtalk_list_conversations': {
        const conversationList = Array.from(sessions.entries()).map(([id, sessionId]) => ({
          conversationId: id,
          sessionId: sessionId,
          hasWebhook: !!webhookManager.getWebhook(id),
        }));
        
        return {
          content: [{ 
            type: 'text', 
            text: conversationList.length > 0 
              ? JSON.stringify(conversationList, null, 2)
              : '暂无活跃会话。请在钉钉中发送消息以创建会话。'
          }],
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    console.error(`工具调用失败 (${name}):`, error.message);
    return {
      content: [{ type: 'text', text: `❌ 错误: ${error.message}` }],
      isError: true,
    };
  }
});

// ============ 启动 ============

async function main() {
  // 启动 MCP 服务器
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ DingTalk MCP Server 已启动');

  // 连接钉钉 Stream（后台运行）
  console.error("🔌 连接钉钉 Stream 服务器...");
  dingtalkClient
    .registerCallbackListener("/v1.0/im/bot/messages/get", async (res) => {
      await handleDingTalkMessage(res);
    })
    .connect();
  console.error("✅ 钉钉 Stream 连接成功");
  console.error("📱 现在可以在钉钉中给机器人发送消息了");
}

main().catch((error) => {
  console.error('❌ 服务器启动失败:', error);
  process.exit(1);
});
