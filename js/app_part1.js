// app.js - 公文流转审批系统前端逻辑（完整版）
const API = '/api';
const AI_API_KEY = 'sk-fpooieexrobdjbeqvdftsjhwptlptxbuhotmyzrpbniafxlb';
const AI_API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const AI_MODEL = 'Qwen/Qwen2.5-72B-Instruct';

let currentUser = null;
let currentPage = 'dashboard';
let docsCache = [];

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// ===== Toast通知 =====
function toast(msg, type) {
  type = type || 'info';
  const ctn = $('#toast-container') || (function() {
    const d = document.createElement('div'); d.id='toast-container'; d.className='toast-container';document.body.appendChild(d);return d;
  })();
  const el=document.createElement('div');el.className='toast '+type;
  el.innerHTML='<span>'+{success:'✓',error:'✕',info:'ℹ',warning:'⚠'}[type]+'</span><span>'+msg+'</span>';
  ctn.appendChild(el);
  setTimeout(function(){el.style.opacity='0';setTimeout(function(){el.remove()},300)},3000);
}

// ===== API调用 =====
async function api(url, opts) {
  opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
   try{
     const res=await fetch(API+url,opts);if(!res.ok){const e=await res.json().catch(()=>{});throw new Error(e&&e.message?'HTTP '+res.status:e?'HTTP '+res.status:res.status)}return await res.json();
   }catch(e){toast('请求失败：'+e.message,'error');throw e;}
}
async function callAI(prompt, maxTokens){
   maxTokens=maxTokens||2000;
   const res=await fetch(AI_API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+AI_API_KEY},body:JSON.stringify({model:AI_MODEL,messages:[{role:'user',content:prompt}],max_tokens:maxTokens,temperature:.7})});
   if(!res.ok)throw new Error('AI调用失败：'+res.status);
   const data=await res.json();return data.choices[0].message.content;}