# 公文流转与请假管理系统

基于 Node.js + Express + MySQL 的智能办公系统，支持飞书集成。

## 功能特性

- 📄 公文流转管理（创建、审批、追踪）
- 📅 请假申请与审批
- 👥 基于角色的权限控制（ADMIN/EMPLOYEE）
- 🤖 AI 智能解析微信/飞书消息自动提交请假
- 📊 数据统计与可视化
- 🔔 Server酱微信推送通知

## 本地运行

### 环境要求
- Node.js >= 18.0.0
- MySQL >= 8.0

### 安装依赖
```bash
npm install
```

### 配置数据库
1. 创建 MySQL 数据库 `document_flow` 和 `leave_system`
2. 修改 `server-merged.js` 中的数据库配置

### 启动服务
```bash
npm start
```

访问：http://localhost:3000

## 部署到 Render.com

### 一键部署
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### 手动部署
1. Fork 此仓库到你的 GitHub
2. 在 Render.com 创建新的 Web Service
3. 连接 GitHub 仓库
4. 使用以下配置：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**:
     - `DB_HOST`: 你的数据库地址
     - `DB_USER`: 数据库用户名
     - `DB_PASSWORD`: 数据库密码
     - `DB_NAME`: 数据库名
     - `PORT`: 3000

## 配置飞书应用

### 1. 创建飞书应用
访问 [飞书开放平台](https://open.feishu.cn/)，创建企业自建应用

### 2. 配置应用信息
- **应用名称**: 公文流转系统
- **应用描述**: 智能办公公文流转与请假管理
- **应用图标**: 上传自定义图标

### 3. 配置应用主页
在「应用功能」→「网页」中配置：
- **网页配置**: 配置为网页应用
- **主页地址**: `https://your-app.onrender.com`（替换为你的 Render.com 地址）
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

### 6. 获取凭证
在「凭证与基础信息」中获取：
- **App ID**: `cli_xxx...`
- **App Secret**: `xxx...`

### 7. 修改后端配置
在 `server-merged.js` 中配置飞书凭证：
```javascript
const FEISHU_CONFIG = {
  APP_ID: 'cli_aaa152828fb95bda',
  APP_SECRET: 'CSyWDYc75HnNz7k0MLn6EciZ5ajjwNvZ',
  // ... 其他配置
};
```

### 8. 启用应用
在「版本管理与发布」中：
1. 创建版本
2. 提交审核
3. 审核通过后启用应用

## 默认账号

- **管理员**: admin / admin123
- **普通用户**: 张三 / 123456

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DB_HOST` | MySQL 主机地址 | localhost |
| `DB_USER` | MySQL 用户名 | root |
| `DB_PASSWORD` | MySQL 密码 | - |
| `DB_NAME` | 数据库名 | document_flow |
| `PORT` | 服务端口 | 3000 |
| `FEISHU_APP_ID` | 飞书应用 ID | - |
| `FEISHU_APP_SECRET` | 飞书应用 Secret | - |

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
- **数据库**: MySQL
- **前端**: HTML5 + CSS3 + Vanilla JavaScript
- **UI 框架**: 自定义（玻璃拟态风格）
- **集成**: 飞书开放平台 SDK

## 目录结构

```
document-flow-system/
├── server-merged.js      # 后端服务（合并版）
├── index.html            # 前端页面
├── package.json          # 项目配置
├── README.md             # 项目文档
└── .gitignore           # Git 忽略文件
```

## 常见问题

### 1. 数据库连接失败
检查 MySQL 服务是否启动，以及数据库配置是否正确

### 2. 飞书事件接收失败
确认已选择「长连接」模式，并确保长连接客户端已成功启动

### 3. 权限不足
检查飞书应用的权限配置，确保已开启所需权限

## 许可证

MIT License

## 支持

如有问题，请提交 Issue 或联系系统管理员。
