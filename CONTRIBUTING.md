# Contributing to DingTalk MCP Server

感谢您对 DingTalk MCP Server 的兴趣！我们欢迎所有形式的贡献。

## 如何贡献

### 报告问题

如果您发现了 bug 或有功能建议，请通过 GitHub Issues 提交：

1. 检查是否已有类似 issue
2. 创建新 issue，详细描述问题
3. 提供复现步骤（如果是 bug）

### 提交代码

1. Fork 本仓库
2. 创建您的功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### 代码规范

- 使用 ESLint 检查代码
- 保持代码简洁清晰
- 添加必要的注释
- 更新相关文档

### 测试

提交 PR 前请确保：
- 代码可以正常运行
- 通过所有测试
- 没有引入新的警告

## 开发流程

```bash
# 1. 克隆仓库
git clone <repository-url>
cd dingtalk-mcp-server

# 2. 安装依赖
npm install

# 3. 创建 .env 文件
cp .env.example .env
# 编辑 .env 填入测试凭证

# 4. 启动开发模式
npm run dev

# 5. 运行测试
npm test
```

## 联系我们

如有任何问题，欢迎通过 GitHub Issues 或 Discussions 交流。

感谢您的贡献！
