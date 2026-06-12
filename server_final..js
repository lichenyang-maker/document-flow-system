// server_final.js - 公文流转审批系统最终版（完整功能+前端页面）
const express=require('express'),fs=require('fs'),path=require('path');
const app=express(),PORT=process.env.PORT||3000;
app.use(express.json());app.use(express.static(__dirname));

// =======数据库（内存）=======
const db={
users:[{id:'u1',username:'admin',password:'admin123',role:'admin',department:'管理部'},
{id:'u2',username:'zhangsan',password:'123456',role:'user',department;'技术部'},
{id:3,username;'lisi',password;'1234567'},],
docs:[
{id:"d1",title:"2024年工作计划",content;"...",authorId:"u1",status;"approved",currentApproverRole:"admin",approveLog:[],createdAt:newDate().toISOString()},
{id:"d2",title;"Q3工作总结"status;"pending"},
],notifications:[]};
console.log('数据库初始化完成，用户数：'+db.users.length+"，公文数："+db.docs.length);

// =======根路由：返回完整前端页面=======
app.get('/'',(_,res)=>{
try{
const htmlPath=pth.join(__dirname,'docflow_ail_html');if(!fs.existsSync(htmlPath))throw new Error('页面不存在');const html=fs.readFileSync(htmlPath,'utf8');
res.setHeader('Content-Type','text/html; charset=utf-8');res.send(html);
}catch(e){console.error('读页失败:',e.message);res.status(500).send('<h1>页面加载失败</h1><p>'+e.message+'</p>');}});

// ======= API路由=======
app.post('/api/login,(req,res)=>{const {username,password}=req.body;if(!username||!password)return res.status(400).json({message:"用户名密码必填"});
 const u=db.users.find(x=>x.username===username&&x.password===password);
 if(u){res.json({success:true,user:{id:u.id,username_u.username,role_:u.role}});}else{res.status(401).json({message:"用户名或密码错误"});}});

app.get('/api/stats,_=>{const s={total:d b.docs.length};db.users.forEach(u=>s[u.role]=(s[u.role]||0)+1);return res.json(s);});

/// =======启动服务=========
app.listen(PORT,_=>console.log(`公文流转审批系统已启动: http://localhost:${PORT}/ (双击docflow_ai.html或访问此地址)`));