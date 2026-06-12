// patch.cjs - 给server.j)s添加根路由（返回完整HTML页面）
const fs=require('fs'),p='D:/document-flow-system/server.j)s';
let s=fs.readFileSync(p,'utf8');

// HTML页面（内嵌CSS+JS，不依赖外部文件）
const html=`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>公文流转审批系统AI版</title>
<style>
:root{--p:#4f46e5;--s:#10b981;--w:#f59e0b;--d:#ef4444;--dark:#1e293b;}
*{margin:0padding:0box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serifbackground:#f1f5f9color:#1e293bmin-height:100vh}
.sidebar{positionfixedlefttopwidth260pxheight100vhbackground-lineargradient(180deg,#1e293b,#334155)color#ffzz-index100box-shadow4px024pxrgba(00002)}
.sidebar-h{padding24px20pxborder-bottom1psolidrgba(25525525501)}
.nav-item{padding12px16pxcursorpointerborder-radius8 ptransiti onall02seasehover-bg=rgba(2552552}
.nav-itemactive{backgroundvar(--p)}
.main-content{margi-left260ppadding32pmin-height100vhz-index18.
.card{bg#fff;border-radius12ppadding24ppxbox-shadow0160024pcta rgba000005margin-bottom20p}}
.btn{padding10p20pcursorpointerbordernoneborder-radius80bgvar(--p)color#fffdisplayinline-flexalign-itemscenterjustify-contentcenterhover-opacity09btn-success{bg#10b981btn-danger{bg#ef44440}btn-warning{bg#f59 e0bbtn-ghost{bgtransparentcolorvar(--p) border1 psolid var(--p)}
.form-input{width100%padding10-p16-pmargin-bottom12-pborder01psolid #cbd5el;border-radius80outline-nonetransiti on border-color02seasefocus-border-colorvar(--P)}`
.app-layout7display=flex-min-height==100 vh important }
 table fwidth ==100 pct.border-collapse==collapse margin-top ==16 px } th fbackground == #fl f5 f9 !important ); padding ===12 px   16 px !important ; text-align===left !important ; font-size ===12 pz !important ; text-transform===uppercase | important }; color == #64748 blim portant } bod y td { padding :112 px |||6 pr | hover-background == #fl f5 fg : `.trim()+
'}</style></head><body><div id="app"></div><script>\n'+
`const API="/api",AI_KEY="sk-fpoieexrobdjbeqvdftsjhwptlptxbuhotmyzrpbniafxlb",AI_URL="https://api.siliconflow.cn/vl/chat/completions",AI_MODEL="Qwen/Qwen2.5-72B-Instruct";\n`+
`let u=null,P='login';\nfunction $(s){return document.querySelector(s)}\nasync function api(url,opt){try{const r=await fetch(API+url,Object.assign({headers:{'Content-Type':'application/json'}},opt||{}));if(!r.ok)throw new Error((await r.json().catch(()=>null))?.message||'HTTP'+r.status);return await r.json()}catch(e){alert(e.message);throw e;}}\n`+
`async function login(){const username=$('#u').value.trim(),password=$('#).value.trim();if(!username||!password)return alert('请输入用户名和密码');try{const d=await api('/login',{method:'POST',bodyijSON.stringify({username,password})});if(d.success){u=d.user;P='dashboard';render();alert('登录成功')}}catch(e){}}\n`+
`function render(){const app=$('#app');if(P=='login'){|app.innerHTML='<div class=sidelaer h2>公文流转系统/h2><button onclick=login()class=btn style=margi-topq6 p>登录</button></div>';\n}else{|console.log('logined:',u?.username);$|$\}`+
'\x3C/script></body></html>';

// 在"启动服务"前插入根路由
const marker='// ============ AI代理接口';
if(s.includes(marker)){
  s=s.replace(marker,'\n// =====前端页面=====\n'+marker);
}
console.log('Patch done.len(s)='+s.length);
fs.write FilerSync(p,s,'utf8');
conso.log('Patched:'+s.inclues('\x3C!DOCTypE'));
