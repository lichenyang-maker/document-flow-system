# 公文流转与请假管理系统（SQLite 版本）

基于 Node.js + Express + SQLite 的智能办公系统，支持飞书集成。

## 功能特性

- 📄 公文流转管理（创建、审批、追踪）
- 📅 请假申请与审批
- 👥 基于角色的权限控制（ADMIN/EMPLOYEE）
- 🤖 AI 智能解析微信/飞书消息自动提交请假
- 📊 数据统计与可视化
- 🔔 Server酱微信推送通知
- 📱 飞书应用集成（长连接模式）

## 本地运行

### 环境要求
- Node.js >= 18.0.0
- SQLite3（自动安装）

### 安装依赖
```bash
npm install
```

### 初始化数据库
```bash
node init-db-sqlite.js
```

### 启动服务
```bash
npm start
```

访问：http://localhost:3000

## 部署到 Render.com（免费）

### 一键部署
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### 手动部署
1. Fork 此仓库到你的 GitHub
2. 在 Render.com 创建新的 Web Service
3. 连接 GitHub 仓库：`lichenyang-maker/document-flow-system`
4. 使用以下配置：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
   - **Plan**: Free

### 环境变量（自动配置）
- `NODE_ENV`: `production`
- `PORT`: `3000`（自动分配）
- `DATABASE_PATH`: `./document_flow.db`（SQLite 数据库文件）
- `FEISHU_APP_ID`: `cli_aaa152828fb95bda`
- `FEISHU_APP_SECRET`: `CSyWDYc75HnNz7k0MLn6EciZ5ajjwNvZ`

## 配置飞书应用

### 1. 创建飞书应用
访问 [飞书开放平台](https://open.feishu.cn/)，创建企业自建应用

### 2. 配置应用信息
- **应用名称**: 公文流转系统
- **应用描述**: 智能办公公文流转与请假管理

### 3. 配置应用主页
在「应用功能」→「网页」中配置：
- **网页配置**: 配置为网页应用
- **主页地址**: `https://document-flow-system.onrender.com`（替换为你的 Render.com 地址）
- **移动端首页**: 同上

### 4. 配置权限
在「权限管理」中开启以下权限：
- `contact:contact:readonly`（获取通讯录信息）
- `im:message:send`（发送消息）
- `approval:approval`（审批权限）

### 5. 配置事件订阅（长连接模式）
在「事件订阅」中：
- **订阅方式**: 选择「长连接」
- 无需配置公网域名或加密策略
- 使用飞书官方 SDK 启动长连接客户端

### 6. 启用应用
在「版本管理与发布」中：
1. 创建版本
2. 提交审核
3. 审核通过后启用应用

## 默认账号

- **管理员**: admin / admin123
- **普通用户**: 张三 / 123456

## API 文档

### 认证
所有 API 需要在请求头中携带 Token：
```
Authorization: Bearer <token>
```

### 主要接口

#### 用户登录
```
POST /api/public/login
Body: { "username": "admin", "password": "admin123" }
```

#### 获取公文列表
```
GET /api/docs?status=pending
Headers: Authorization: Bearer <token>
```

#### 创建公文
```
POST /api/docs
Headers: Authorization: Bearer <token>
Body: { "title": "公文标题", "content": "公文内容", ... }
```

#### 请假申请
```
POST /api/leave
Headers: Authorization: Bearer <token>
Body: { "type": "年假", "startDate": "2024-01-01", ... }
```

## 技术栈

- **后端**: Node.js + Express
- **数据库**: SQLite3（生产环境）/ MySQL（本地开发可选）
- **前端**: HTML5 + CSS3 + Vanilla JavaScript
- **UI 框架**: 自定义（玻璃拟态风格）
- **集成**: 飞书开放平台 SDK（长连接模式）

## 目录结构

```
document-flow-system/
├── server-merged.js         # 后端服务（合并版，支持 SQLite/MySQL）
├── server-sqlite.js         # 后端服务（SQLite 专用版本）
├── init-db-sqlite.js       # SQLite 数据库初始化脚本
├── index.html               # 前端页面
├── package.json             # 项目配置
├── render.yaml              # Render.com 部署配置
├── README.md                # 项目文档
└── .gitignore              # Git 忽略文件
```

## 数据库切换

### SQLite（推荐，免费部署）
- 默认使用 SQLite
- 数据库文件：`document_flow.db`
- 无需配置，开箱即用

### MySQL（本地开发）
如需使用 MySQL，修改 `server-merged.js` 中的数据库配置：
```javascript
const useSQLite = false; // 改为 false 使用 MySQL
```

## 常见问题

### 1. 数据库连接失败
检查 SQLite 数据库文件是否存在，或 MySQL 服务是否启动

### 2. 飞书事件接收失败
确认已选择「长连接」模式，并确保长连接客户端已成功启动

### 3. 权限不足
检查飞书应用的权限配置，确保已开启所需权限

### 4. Render.com 部署失败
检查 `package.json` 中的 `start` 脚本是否正确

## 许可证

MIT License

## 支持

如有问题，请提交 Issue 或联系系统管理员。

## 更新日志

### v1.1.0 (2026-06-12)
- ✅ 添加 SQLite 支持（免费部署到 Render.com）
- ✅ 集成飞书 SDK（长连接模式）
- ✅ 优化数据库初始化脚本
- ✅ 更新 README 文档

### v1.0.0 (2026-06-04)
- ✅ 初始版本
- ✅ 公文流转管理
- ✅ 请假申请与审批
- ✅ 基于角色的权限控制
- ✅ AI 智能解析消息
- ✅ Server酱微信推送


## 部署状态
- Sealos: https://dmtrgpkjqvjw.cloud.sealos.io
- 最新构建: 2026-06-13 19:21