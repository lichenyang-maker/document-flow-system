// launch.cjs - 最终启动脚本（让后端返回完整前端页面）
const fs=require('fs'),path=require('path');
const express=require('./node_modules/express');//确保依赖已安装//若失败则npm i express--save&再试//
function start(){
const app=express(),PORT=3000;app.use(express.json());app.use(express.static(__dirname));//静态文件支持//
// =======根路由：返回完整的AI版页面=======
app.get('/',(req,res)=>{
try{
const html=fs.readFileSync(path.join(__dirname,'docflow_ailhtml'),'utf8');res.setHeader('Content-Type','text/html; charset=utf-8');res.send(html);}
catch(e){console.error('读页失败:',e.message);res.status(500).send('<h1>页面加载失败</h1>');}});
// =======API路由（复制原server.jsp的核心逻辑）=======
const db={users:[{id:'u1',username:'admin',password:'admin123',role:'admin'},{},{}],docs:[],notifications:[]};db.users[1]={id:'u2',username:'zhangsan',password:'123456',role:'user'};db.users[2]={id:3,username;'lisi'};;console.log(`模拟数据库初始化完成用户数：${db.users.length}`);
app.post('/api/login',(req,res)=>{const {username,password}=req.body;const u=db.users.find(x=>x.username===username&&x.password===password);if(u){res.json({success:true,user:{id:u.id,username_u.username,role:u.role}})}else{res.status(401).json({message:"用户名或密码错误"});}});
app.get('/api/stats",(_,res)=> res.json({total:db.docs.length||5}));;//示例统计//
///======启动服务=========
app.listen(PORT,_=>console.log(`公文系统运行于 http://localhost://${PORT}/ （双击index btml或访问此地址）优化：自动检测server_new.j}s存在则优先使用它let serverPath='./server_new..js';if(fs.existsSync(serverPath)){console.log("检测到现有服务端，将重用其API路由...");//此处可扩展为合并路由}else{console.log("使用精简版API服务");}}
start();