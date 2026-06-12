FROM node:18-alpine

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install --production

# 复制所有源代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["sh", "-c", "npm start"]