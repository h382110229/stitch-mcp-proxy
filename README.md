# stitch-mcp-proxy

[![Deploy to Cloudflare Workers](https://github.com/h382110229/stitch-mcp-proxy/actions/workflows/deploy.yml/badge.svg)](https://github.com/h382110229/stitch-mcp-proxy/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Cloudflare Workers](https://img.shields.io/badge/Runtime-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com/)

基于 Cloudflare Workers 构建的 **Google Stitch MCP** 高性能、安全加固级反向代理中转网关。

解决特定网络环境下直连 `https://stitch.googleapis.com` 延迟高、易断连或受阻问题，告别本地不稳定代理端口，提供全球 Anycast 边缘加速、全路径透传、CORS 跨域预检、Server-Sent Events (SSE) 流式传输支持及可选的网关访问防护盾。

---

## 🌟 核心特性与架构规范

- **源站透明透传**：完美反向代理至 `https://stitch.googleapis.com`，完整保留所有 Path 与 Query 字符串。
- **Host 无损重写**：自动将 `Host` 头部重写为 `stitch.googleapis.com`，清洗多余内部头，杜绝目标逃逸。
- **方案 A 认证模式（零凭据存储）**：客户端通过 `X-Goog-Api-Key` 携带密钥，Worker 纯管道透明透传，无任何密钥落地或存储，彻底杜绝泄密风险。
- **网关防盗刷防护盾（GATEWAY_TOKEN）**：支持可选的自定义访问令牌。启用后未授权访问直接在 Cloudflare 边缘抛出 403 阻断，保护您的 Worker 免费额度。
- **流式传输与 SSE 兼容**：原生 `ReadableStream` 双向流式转发，配合 `duplex: 'half'` 零内存整包缓冲，完美兼容 MCP 远程 SSE 长连接。
- **智能超时与熔断保护**：对普通单次 RPC 请求施加 60 秒主动超时保护，防止僵尸连接；对 SSE 长连接智能豁免超时限制。
- **全量 CORS 预检支持**：原生处理 `OPTIONS` 跨域预检请求，注入标准的 `Access-Control-Allow-*` 头部。
- **多平台 Agent 开箱即用**：支持 Google Antigravity、Claude Desktop、Cursor、VS Code (Cline / Roo Code)、Windsurf 等全部主流 Agent 客户端。

---

## 📐 架构工作流

```
[Agent 客户端] (Antigravity / Claude / Cursor)
      │
      │ 1. HTTPS 请求 (携带 X-Goog-Api-Key & 可选 X-Gateway-Token)
      ▼
[Cloudflare Edge Worker]
      │
      ├─► 2. OPTIONS 预检 ──► 立即返回 204 No Content
      ├─► 3. 校验 X-Gateway-Token (若开启) ──► 不匹配则 403 边缘阻断
      ├─► 4. 重写 Host: stitch.googleapis.com & 剥离边缘隐私头
      ├─► 5. 挂载 60s 超时熔断 (SSE 长流智能豁免)
      │
      │ 6. 零内存缓冲双向流式转发 (duplex: 'half')
      ▼
[Google Stitch API 源站] (stitch.googleapis.com/mcp)
```

---

## 📁 目录结构

```tree
stitch-mcp-proxy/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions 自动化部署流水线
├── src/
│   └── index.ts                # Cloudflare Worker 反代核心逻辑（加固版）
├── .gitignore                  # Git 忽略配置（已屏蔽本地敏感文档）
├── package.json                # 项目依赖与 Scripts
├── tsconfig.json               # TypeScript 严格模式配置
├── wrangler.jsonc              # Cloudflare Wrangler 配置文件
├── LICENSE                     # MIT 开源许可证
└── README.md                   # 项目工程与部署文档
```

---

## 🚀 快速上手

### 1. 本地安装与开发

```bash
# 克隆仓库
git clone https://github.com/h382110229/stitch-mcp-proxy.git
cd stitch-mcp-proxy

# 安装依赖
npm install

# 类型检查
npm run type-check

# 启动本地开发模拟服务
npm run dev
```

### 2. 部署到 Cloudflare Workers

确保本地已登录 Cloudflare Wrangler CLI：
```bash
npx wrangler login
```

执行极速部署：
```bash
npm run deploy
```

---

## 🌐 绑定自定义域名

在 `wrangler.jsonc` 中配置您的专属自定义域名：
```jsonc
"routes": [
  {
    "pattern": "stitch.your-domain.com",
    "custom_domain": true
  }
]
```
执行 `npm run deploy` 时，Cloudflare 将自动在 DNS 区域内创建该子域名的 DNS 记录并自动签发 SSL 证书。

---

## 🔒 （可选）激活网关防盗刷防护盾

若您的域名为公开解析，为防止他人扫描并消耗您的 Cloudflare 免费配额，可一键开启访问控制：

1. 在终端设置防护密码：
   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   # 输入您的自定义私有密码，例如：my-secret-token-2026
   ```
2. 开启后，未附带 `X-Gateway-Token` 的外部请求将在边缘直接被拦截（HTTP 403）。

---

## 🧪 验证与测试命令

### 1. 健康状态探针
```bash
curl -i https://<your-worker-domain>/health
```
**期望返回 (200 OK)**：
```json
{
  "service": "stitch-mcp-proxy",
  "status": "ok",
  "upstream": "https://stitch.googleapis.com",
  "endpoints": ["/mcp", "/*"],
  "mode": "transparent-forwarding",
  "auth_shield_enabled": false,
  "timestamp": "2026-10-14T..."
}
```

### 2. 真实 Stitch MCP 工具获取测试
```bash
curl -i -X POST "https://<your-worker-domain>/mcp" \
  -H "Content-Type: application/json" \
  -H "X-Goog-Api-Key: YOUR_API_KEY_HERE" \
  -H "X-Gateway-Token: YOUR_GATEWAY_TOKEN" \
  -d '{"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1}'
```

---

## 💻 常见 Agent 客户端对接模板

### 1. Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "stitch": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-worker-domain>/mcp",
        "--header",
        "X-Goog-Api-Key: YOUR_API_KEY_HERE",
        "--header",
        "X-Gateway-Token: YOUR_GATEWAY_TOKEN"
      ]
    }
  }
}
```

### 2. Cursor (`~/.cursor/mcp.json` 或 UI 配置)
```json
{
  "mcpServers": {
    "stitch": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-worker-domain>/mcp",
        "--header",
        "X-Goog-Api-Key: YOUR_API_KEY_HERE",
        "--header",
        "X-Gateway-Token: YOUR_GATEWAY_TOKEN"
      ]
    }
  }
}
```

### 3. VS Code 插件 (Cline / Roo Code)
```json
{
  "mcpServers": {
    "stitch": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-worker-domain>/mcp",
        "--header",
        "X-Goog-Api-Key: YOUR_API_KEY_HERE",
        "--header",
        "X-Gateway-Token: YOUR_GATEWAY_TOKEN"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

---

## 🤖 GitHub Actions 自动持续交付

推送代码至 `main` 分支时触发自动构建与发布。请在 GitHub 仓库 **Settings** ➔ **Secrets and variables** ➔ **Actions** 中添加：

| Secret 名称 | 描述 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 具有 `Worker:Edit` 权限的 Cloudflare API 令牌 |
| `CLOUDFLARE_ACCOUNT_ID` | 您的 Cloudflare 账户 ID |

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权许可。
