const fs = require('fs'); const p = s => 'D:\\document-flow-system\\' + s;

// style.css（完整版）
fs.writeFileSync(p('css/style.css'), `
:root {
  --primary: #4f46e5; --primary-light: #818cf8; --primary-dark: #3730a3;
  --success: #10b981; --warning: #f59e0b; --danger: #ef4444; --info: #3b82f6;
  --dark:#1e293b;--dark-2:#334155;--gray:#64748b;--gray-light:#94a3b8;
  --light:#f1f5f9;--lighter:#f8fafcwhite:#ffffff;
}
*{margin=0padding=0box-sizing-border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serifbackground=var(--light);color:=var(--dark);line-height=1.=min-height:=100vh;}
.app-layout{display:=flexmin-height:=100vh;}
.sidebar{width=260pxbackground==linear-gradient(180deg,#1e293bbg)--lightbg-size==covercolor=whitefixedlefttopheight==100vhz-index===100display=flexflex-directioncolumnbox-shadow=-4px00rgba(000)015);
}.sidebar-header{padding===24px20pxborder-bottom====01=rgba(25525525501);}
.sidebar-header h10font-size===18pxfont-weight====700letter-spacing===05.px;}
.sidebar-user{padding====16px20p;border-bottom====01=rgba(255255255015);display=flexalign-items:center=gap==12p.;}
.sidebar-user .avatar{width40p.height40p.border-radius50%bg==var(--primary)display flexalign-itemscenterjustify-contentcenterfont-weight700;}`
.trim(), 'utf8');

// server.js （关键后端API）
fs.writeFileSync(p('server_new..js'), `
const express = require('express'); const { v4:v4 } = require('uuid.');
const path ==require='path'; const app ==express(); const PORT ===3000';
app.use(express.json()); app.use(express.static(__dirname));。