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
import { LRUCache } from 'lru-cache';
import PQueue from 'p-queue';
import got from 'got';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 使用绝对路径加载 .env 文件
dotenv.config({ path: join(__dirname, '.env') });

// ============ 性能优化配置 ============
const CONFIG = {
  // LRU 缓存配置
  CACHE: {
    PROCESSED_MESSAGES_MAX: 1000,        // 最多缓存1000条消息
    PROCESSED_MESSAGES_TTL: 1000 * 60 * 5, // 5分钟TTL
    SESSIONS_MAX: 100,                    // 最多100个会话
    SESSIONS_TTL: 1000 * 60 * 30,        // 30分钟TTL
    WEBHOOKS_MAX: 100,                    // 最多100个webhook
  },
  // 队列配置
  QUEUE: {
    CONCURRENCY: 3,                       // 并发处理数
    INTERVAL: 10,                         // 队列检查间隔(ms)
    INTERVAL_CAP: 100,                    // 最大队列长度
  },
  // HTTP连接池配置
  HTTP: {
    TIMEOUT: 10000,                       // 10秒超时
    RETRY: 2,                            // 重试2次
    KEEP_ALIVE: true,                    // 启用keep-alive
    MAX_SOCKETS: 10,                     // 最大连接数
  },
  // 清理配置
  CLEANUP: {
    INTERVAL: 60000,                     // 每分钟清理一次
  }
};

// ============ 性能监控 ============
class PerformanceMetrics {
  constructor() {
    this.messageCount = 0;
    this.processTimes = [];
    this.errorCount = 0;
    this.queueSize = 0;
    this.startTime = Date.now();
  }

  recordMessage(processTime) {
    this.messageCount++;
    this.processTimes.push(processTime);
    // 只保留最近100条记录
    if (this.processTimes.length > 100) {
      this.processTimes.shift();
    }
  }

  recordError() {
    this.errorCount++;
  }

  updateQueueSize(size) {
    this.queueSize = size;
  }

  getStats() {
    const avgTime = this.processTimes.length > 0
      ? this.processTimes.reduce((a, b) => a + b, 0) / this.processTimes.length
      : 0;
    
    const memory = process.memoryUsage();
    
    return {
      runtime: {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        memoryMB: {
          heapUsed: Math.floor(memory.heapUsed / 1024 / 1024),
          heapTotal: Math.floor(memory.heapTotal / 1024 / 1024),
          rss: Math.floor(memory.rss / 1024 / 1024),
        }
      },
      messages: {
        total: this.messageCount,
        avgProcessTime: Math.floor(avgTime),
        errorRate: this.messageCount > 0 
          ? (this.errorCount / this.messageCount * 100).toFixed(2) + '%'
          : '0%',
      },
      queue: {
        currentSize: this.queueSize,
        concurrency: CONFIG.QUEUE.CONCURRENCY,
      }
    };
  }
}

const metrics = new PerformanceMetrics();

// ============ 配置和初始化 ============
console.error("🚀 启动 DingTalk MCP Server (性能优化版)...");
console.error(`📊 性能配置: 并发=${CONFIG.QUEUE.CONCURRENCY}, 缓存=${CONFIG.CACHE.PROCESSED_MESSAGES_MAX}`);

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

// ============ HTTP 连接池 ============
const httpAgent = new https.Agent({
  keepAlive: CONFIG.HTTP.KEEP_ALIVE,
  maxSockets: CONFIG.HTTP.MAX_SOCKETS,
});

const httpClient = got.extend({
  timeout: { request: CONFIG.HTTP.TIMEOUT },
  retry: { limit: CONFIG.HTTP.RETRY },
  agent: { https: httpAgent },
});

// ============ 异步消息队列 ============
const messageQueue = new PQueue({
  concurrency: CONFIG.QUEUE.CONCURRENCY,
  interval: CONFIG.QUEUE.INTERVAL,
  intervalCap: CONFIG.QUEUE.INTERVAL_CAP,
});

messageQueue.on('active', () => {
  metrics.updateQueueSize(messageQueue.size);
  if (messageQueue.size > 10) {
    console.error(`⚠️  队列堆积: ${messageQueue.size} 条消息待处理`);
  }
});

// ============ LRU 缓存 ============

// 消息去重缓存
const processedMessages = new LRUCache({
  max: CONFIG.CACHE.PROCESSED_MESSAGES_MAX,
  ttl: CONFIG.CACHE.PROCESSED_MESSAGES_TTL,
  updateAgeOnGet: true,
  allowStale: false,
  dispose: (value, key) => {
    console.error(`🗑️  清理过期消息: ${key}`);
  },
});

// 会话缓存
const sessions = new LRUCache({
  max: CONFIG.CACHE.SESSIONS_MAX,
  ttl: CONFIG.CACHE.SESSIONS_TTL,
  updateAgeOnGet: true,
  dispose: (value, key) => {
    console.error(`🗑️  清理过期会话: ${key}`);
  },
});

// ============ 核心类 ============

class SessionWebhookManager {
  constructor() {
    // 使用 LRU 缓存替代普通 Map
    this.webhooks = new LRUCache({
      max: CONFIG.CACHE.WEBHOOKS_MAX,
      ttl: 1000 * 60 * 60 * 2, // 2小时TTL
      dispose: (value, key) => {
        console.error(`🗑️  清理过期 Webhook: ${key}`);
      },
    });
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
    console.error(`💾 保存 SessionWebhook: ${conversationId} (过期: ${new Date(expiredTime).toLocaleString()})`);
  }

  getStats() {
    return {
      total: this.webhooks.size,
      active: Array.from(this.webhooks.values()).filter(w => Date.now() <= w.expiredTime).length
    };
  }
}

class MessageQueueManager {
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
    try {
      const startTime = Date.now();
      await httpClient.post(webhook, {
        json: {
          msgtype: "text",
          text: { content: message },
        },
      });
      const duration = Date.now() - startTime;
      console.error(`✅ 消息发送成功 (${duration}ms)`);
    } catch (error) {
      console.error(`❌ 发送失败: ${error.message}`);
      throw error;
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
const webhookManager = new SessionWebhookManager();
const messageQueueManager = new MessageQueueManager();

// ============ 消息处理函数 ============

function isMessageProcessed(msgId) {
  return processedMessages.has(msgId);
}

function markMessageProcessed(msgId) {
  processedMessages.set(msgId, Date.now());
}

async function handleDingTalkMessage(res) {
  const startTime = Date.now();
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
    console.error(`📝 消息内容: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);

    if (sessionWebhook && sessionWebhookExpiredTime) {
      webhookManager.setWebhook(finalConversationId, sessionWebhook, sessionWebhookExpiredTime);
    }

    if (!content) {
      console.error("⚠️  消息内容为空，跳过处理");
      return;
    }

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
    const aiStartTime = Date.now();
    const result = await opencodeClient.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: content }] },
    });
    const aiDuration = Date.now() - aiStartTime;

    const reply = result.data?.parts
      ?.filter(p => p.type === "text")
      ?.map(p => p.text)
      ?.join("\n") || "没有收到回复";

    console.error(`💬 回复内容 (${aiDuration}ms): ${reply.substring(0, 100)}${reply.length > 100 ? '...' : ''}`);

    // 发送回复到钉钉
    const webhook = webhookManager.getWebhook(finalConversationId);
    if (webhook) {
      await messageQueueManager.send(webhook, reply);
      console.error("✅ 回复已发送到钉钉");
    } else {
      console.error("⚠️  没有找到有效的 sessionWebhook，无法发送回复");
    }

    // 记录性能指标
    const processTime = Date.now() - startTime;
    metrics.recordMessage(processTime);
    console.error(`⏱️  总处理时间: ${processTime}ms`);

  } catch (error) {
    console.error("❌ 处理消息失败:", error.message);
    metrics.recordError();
  }
}

// ============ MCP 服务器设置 ============

const server = new Server(
  {
    name: 'dingtalk-mcp-server',
    version: '2.1.0',
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
        description: '获取 DingTalk MCP 服务器统计信息（包含性能指标）',
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
      {
        name: 'dingtalk_get_performance',
        description: '获取详细的性能监控数据',
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

        const startTime = Date.now();
        await messageQueueManager.send(webhook, content);
        const duration = Date.now() - startTime;
        
        return {
          content: [{ type: 'text', text: `✅ 消息发送成功到会话 ${conversationId} (耗时: ${duration}ms)` }],
        };
      }

      case 'dingtalk_get_stats': {
        const stats = {
          server: {
            version: '2.1.0',
            connected: true,
          },
          sessions: {
            total: sessions.size,
            ids: Array.from(sessions.keys()),
          },
          messages: {
            processed: processedMessages.size,
            queue: messageQueueManager.getStats(),
          },
          webhooks: webhookManager.getStats(),
          performance: metrics.getStats(),
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

      case 'dingtalk_get_performance': {
        const perfStats = metrics.getStats();
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(perfStats, null, 2)
          }],
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    console.error(`工具调用失败 (${name}):`, error.message);
    metrics.recordError();
    return {
      content: [{ type: 'text', text: `❌ 错误: ${error.message}` }],
      isError: true,
    };
  }
});

// ============ 定期清理任务 ============
setInterval(() => {
  const stats = metrics.getStats();
  console.error('\n📊 定期性能报告:');
  console.error(`   运行时间: ${Math.floor(stats.runtime.uptime / 60)} 分钟`);
  console.error(`   内存使用: ${stats.runtime.memoryMB.heapUsed}MB / ${stats.runtime.memoryMB.heapTotal}MB`);
  console.error(`   处理消息: ${stats.messages.total} 条`);
  console.error(`   平均耗时: ${stats.messages.avgProcessTime}ms`);
  console.error(`   错误率: ${stats.messages.errorRate}`);
  console.error(`   队列大小: ${stats.queue.currentSize}`);
  console.error(`   缓存状态: 消息=${processedMessages.size}, 会话=${sessions.size}, Webhook=${webhookManager.webhooks.size}`);
}, CONFIG.CLEANUP.INTERVAL);

// ============ 启动 ============

async function main() {
  // 启动 MCP 服务器
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ DingTalk MCP Server 已启动 (性能优化版 v2.1.0)');

  // 连接钉钉 Stream（后台运行）
  console.error("🔌 连接钉钉 Stream 服务器...");
  dingtalkClient
    .registerCallbackListener("/v1.0/im/bot/messages/get", async (res) => {
      // 使用队列处理消息，实现并发控制
      messageQueue.add(() => handleDingTalkMessage(res));
    })
    .connect();
  console.error("✅ 钉钉 Stream 连接成功");
  console.error("📱 现在可以在钉钉中给机器人发送消息了");
  console.error(`⚡ 性能模式: 并发=${CONFIG.QUEUE.CONCURRENCY}, 连接池=${CONFIG.HTTP.MAX_SOCKETS}`);
}

main().catch((error) => {
  console.error('❌ 服务器启动失败:', error);
  process.exit(1);
});
