
  let token = localStorage.getItem('token');
  let currentAgent = 'general';
  let currentMode = 'single';
  let selectedAgents = new Set(['general']);
  let conversationIds = {};
  let agentsData = [];
  let messageCount = 0;

  const modeLabels = {
    single: { badge: '鍗曟櫤鑳戒綋妯″紡', hint: '閫夋嫨涓€涓櫤鑳戒綋杩涜瀵硅瘽', desc: '閫夋嫨涓€涓櫤鑳戒綋杩涜瀵硅瘽' },
    sequential: { badge: '搴忓垪鍗忎綔妯″紡', hint: '澶氫釜鏅鸿兘浣撴寜搴忔帴鍔?, desc: '澶氫釜鏅鸿兘浣撴寜椤哄簭鎺ュ姏澶勭悊浠诲姟' },
    parallel: { badge: '骞惰鍒嗘瀽妯″紡', hint: '澶氭櫤鑳戒綋鍚屾椂鍒嗘瀽', desc: '澶氫釜鏅鸿兘浣撲粠涓嶅悓瑙掑害鍚屾椂鍒嗘瀽' }
  };

  const quickPrompts = {
    general: ['浠嬬粛涓€涓嬬郴缁熷姛鑳?, '濡備綍浣跨敤璇峰亣鍔熻兘锛?, '浠婂ぉ鏈変粈涔堥渶瑕佹敞鎰忕殑锛?],
    coder: ['鍐欎竴涓暟鎹鐞嗚剼鏈?, '濡備綍浼樺寲 SQL 鏌ヨ锛?, 'REST API 鏈€浣冲疄璺?],
    document: ['甯垜鍐欎竴浠戒細璁€氱煡', '鎾板啓瀛ｅ害宸ヤ綔鎬荤粨', '浼樺寲鍏枃琛ㄨ揪鏂瑰紡'],
    approval: ['鍒嗘瀽杩欎唤璇峰亣鐢宠', '甯垜鍐欏鎵瑰洖澶?, '鍚堢悊鐨勮鍋囨祦绋嬪缓璁?],
    data: ['鍒嗘瀽鏈€杩戣鍋囨暟鎹?, '鐢熸垚鏁版嵁缁熻鎶ュ憡', '鏁版嵁閲囬泦浼樺寲寤鸿'],
    reasoning: ['绯荤粺鍔熻兘鏀硅繘鏂瑰悜', '瀵规瘮涓ょ鏂规浼樺姡', '娣卞害鍒嗘瀽涓氬姟闂'],
    meeting: ['甯垜鍐欎竴浠戒細璁邯瑕?, '璁捐涓€娆￠」鐩瘎瀹′細璁▼', '鏁寸悊浼氳鍐宠鍜岃鍔ㄩ」'],
    email: ['甯垜鍐欎竴灏佸伐浣滄眹鎶ラ偖浠?, '鍥炲涓婄骇鐨勮闂偖浠?, '鍐欎竴灏佽法閮ㄩ棬鍗忚皟閭欢']
  };

  function escapeHTML(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatMarkdown(text) {
    if (!text) return '';
    let html = escapeHTML(text);

    html = html.replace(/\`\`\`([\s\S]*?)\`\`\`/g, function(m, code) {
      return '<div class="md-codeblock"><code>' + code.trim() + '</code></div>';
    });
    html = html.replace(/\`([^\`]+)\`/g, '<code class="md-inline-code">$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    const lines = html.split('\n');
    let result = [];
    let inList = false;
    let listType = null;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      let headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      let olMatch = line.match(/^(\d+)\.\s+(.+)$/);
      let ulMatch = line.match(/^[-*+]\s+(.+)$/);
      let quoteMatch = line.match(/^>\s?(.+)$/);

      if (headingMatch) {
        if (inList) { result.push('</' + listType + '>'); inList = false; listType = null; }
        const level = headingMatch[1].length;
        result.push('<h' + level + ' class="md-h' + level + '">' + headingMatch[2] + '</h' + level + '>');
      } else if (olMatch) {
        if (!inList || listType !== 'ol') { if (inList) result.push('</' + listType + '>');
        result.push('<ol class="md-list md-ol">'); inList = true; listType = 'ol';
        result.push('<li>' + olMatch[2] + '</li>');
      } else if (ulMatch) {
        if (!inList || listType !== 'ul') { if (inList) result.push('</' + listType + '>');
        result.push('<ul class="md-list md-ul">'); inList = true; listType = 'ul';
        result.push('<li>' + ulMatch[1] + '</li>');
      } else if (quoteMatch) {
        if (inList) { result.push('</' + listType + '>'); inList = false; listType = null; }
        result.push('<blockquote class="md-quote">' + quoteMatch[1] + '</blockquote>');
      } else if (line.trim() === '') {
        if (inList) { result.push('</' + listType + '>'); inList = false; listType = null; }
        result.push('<br><br>');
      } else {
        if (inList) { result.push('</' + listType + '>'); inList = false; listType = null; }
        result.push('<span>' + line + '</span>');
      }
    }
    if (inList) result.push('</' + listType + '>');
    return result.join('\n');
  }

  function checkAuth() {
    if (!token) {
      document.getElementById('chatMessages').innerHTML = `
        <div style="padding:60px 40px;text-align:center;max-width:500px;margin:0 auto;">
          <div style="font-size:48px;margin-bottom:16px;">馃攼</div>
          <h4 style="color:#0f172a;margin-bottom:8px;font-size:20px;">璇峰厛鐧诲綍</h4>
          <p style="color:#64748b;margin-bottom:24px;font-size:14px;line-height:1.6;">璇疯繑鍥為椤靛畬鎴愮櫥褰曞悗鍐嶄娇鐢?AI 鍔╂墜</p>
          <button onclick="window.location.href='/'" style="padding:10px 28px;background:#2563eb;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;">杩斿洖棣栭〉鐧诲綍</button>
        </div>`;
      return false;
    }
    return true;
  }

  async function loadAgents() {
    try {
      const res = await fetch('/api/agents');
      const data = await res.json();
      if (!data.success || !data.agents || data.agents.length === 0) {
        throw new Error('鏅鸿兘浣撳垪琛ㄤ负绌?);
      }
      agentsData = data.agents || [];
      renderAgents();
      updateHeaderInfo();
      renderQuickButtons();
    } catch (e) {
      console.error('鍔犺浇鏅鸿兘浣撳け璐?', e);
      document.getElementById('agentList').innerHTML = `
        <div style="padding:20px;text-align:center;color:#64748b;font-size:13px;">
          鈿?鏅鸿兘浣撳垪琛ㄥ姞杞藉け璐?br>
          <small style="font-size:12px;">璇峰埛鏂伴〉闈㈤噸璇?/small>
        </div>`;
    }
  }

  function renderAgents() {
    const list = document.getElementById('agentList');
    if (currentMode === 'single') {
      list.innerHTML = agentsData.map(a => `
        <div class="agent-card ${currentAgent === a.id ? 'active' : ''}" data-agent="${a.id}" onclick="selectAgent('${a.id}')">
          <div class="agent-icon">${getAgentEmoji(a.id)}</div>
          <div class="agent-info">
            <div class="agent-name">${a.name.split(' ').pop() || a.name}</div>
            <div class="agent-desc">${a.description}</div>
          </div>
        </div>
      `).join('');
    } else {
      list.innerHTML = agentsData.map(a => `
        <div class="agent-checkbox ${selectedAgents.has(a.id) ? 'selected' : ''}" data-agent="${a.id}" onclick="toggleAgentSelect('${a.id}')">
          <div class="checkbox-box">${selectedAgents.has(a.id) ? '鉁? : ''}</div>
          <div class="agent-icon">${getAgentEmoji(a.id)}</div>
          <div class="agent-info">
            <div class="agent-name">${a.name.split(' ').pop() || a.name}</div>
            <div class="agent-desc">${a.description}</div>
          </div>
        </div>
      `).join('');
    }
  }

  function getAgentEmoji(id) {
    const map = { general:'馃', coder:'馃捇', document:'馃搫', approval:'鉁?, data:'馃搳', reasoning:'馃', meeting:'馃摑', email:'鉁夛笍' };
    return map[id] || '鉁?;
  }

  function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.mode === mode);
    });
    const info = modeLabels[mode];
    document.getElementById('modeBadge').textContent = info.badge;
    document.getElementById('modeDescription').textContent = info.desc;

    if (mode === 'single') {
      if (!selectedAgents.has(currentAgent)) {
        currentAgent = Array.from(selectedAgents)[0] || 'general';
      }
      selectedAgents.clear();
      selectedAgents.add(currentAgent);
    } else {
      if (selectedAgents.size === 0) selectedAgents.add('general');
    }

    updateHeaderInfo();
    renderAgents();
    renderQuickButtons();
  }

  function toggleAgentSelect(agentId) {
    if (currentMode === 'single') {
      currentAgent = agentId;
      selectedAgents.clear();
      selectedAgents.add(agentId);
    } else {
      if (selectedAgents.has(agentId)) {
        if (selectedAgents.size > 1) selectedAgents.delete(agentId);
      } else {
        selectedAgents.add(agentId);
      }
    }
    updateHeaderInfo();
    renderAgents();
    renderQuickButtons();
  }

  function selectAgent(agentId) {
    currentAgent = agentId;
    selectedAgents.clear();
    selectedAgents.add(agentId);
    const agent = agentsData.find(a => a.id === agentId);
    if (!agent) return;

    updateHeaderInfo();
    renderAgents();
    renderQuickButtons();

    if (!conversationIds[agentId]) {
      conversationIds[agentId] = agentId + '_' + Date.now();
    }
  }

  function updateHeaderInfo() {
    if (currentMode === 'single') {
      const agent = agentsData.find(a => a.id === currentAgent);
      if (agent) {
        document.getElementById('currentAgentName').textContent = agent.name.split(' ').pop() || agent.name;
        document.getElementById('currentAgentDesc').textContent = agent.description;
        document.getElementById('modelInfo').textContent = agent.model || '';
      }
    } else {
      const selected = Array.from(selectedAgents);
      const names = selected.map(id => {
        const a = agentsData.find(x => x.id === id);
        return a ? (a.name.split(' ').pop() || a.name) : id;
      });
      document.getElementById('currentAgentName').textContent = names.join(' 路 ');
      document.getElementById('currentAgentDesc').textContent = selected.length + ' 涓櫤鑳戒綋鍗忓悓宸ヤ綔';
      document.getElementById('modelInfo').textContent = '';
    }
  }

  function renderQuickButtons() {
    const btns = document.getElementById('quickButtons');
    if (currentMode === 'single') {
      const prompts = quickPrompts[currentAgent] || [];
      btns.innerHTML = prompts.map(p => `<span class="quick-btn" onclick="quickSend('${p}')">${p}</span>`).join('');
    } else {
      btns.innerHTML = [
        '浼樺寲浼佷笟鍏枃瀹℃壒娴佺▼',
        '鎾板啓涓€浠藉畬鏁寸殑椤圭洰鏂规',
        '鍒嗘瀽绯荤粺鍔熻兘鐨勬敼杩涙柟鍚?,
        '缁煎悎璇勪及璇峰亣鐢宠'
      ].map(p => `<span class="quick-btn" onclick="quickSend('${p}')">${p}</span>`).join('');
    }
  }

  function quickSend(text) {
    document.getElementById('messageInput').value = text;
    sendMessage();
  }

  function createMessage(role, avatar, text) {
    const div = document.createElement('div');
    div.className = 'message ' + role;
    const avatarChar = role === 'user' ? '鎴? : avatar;
    div.innerHTML = `
      <div class="message-avatar">${avatarChar}</div>
      <div class="message-content">
        <div class="message-bubble">${formatMarkdown(text)}</div>
        <div class="msg-meta">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `;
    return div;
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function sendMessage() {
    if (!checkAuth()) return;
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text) return;
    if (currentMode !== 'single' && selectedAgents.size < 1) {
      alert('璇疯嚦灏戦€夋嫨 1 涓櫤鑳戒綋鍙備笌鍗忎綔');
      return;
    }

    input.value = '';
    const msgs = document.getElementById('chatMessages');
    messageCount++;

    const userMsg = createMessage('user', '鎴?, text);
    msgs.appendChild(userMsg);
    msgs.scrollTop = msgs.scrollHeight;

    const waitingMsg = document.createElement('div');
    waitingMsg.className = 'message assistant';
    if (currentMode === 'single') {
      const agent = agentsData.find(a => a.id === currentAgent);
      const avatarName = agent ? getAgentEmoji(currentAgent) : '馃';
      waitingMsg.innerHTML = `<div class="message-avatar">${avatarName}</div><div class="message-content"><div class="message-bubble"><span class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span> 姝ｅ湪鎬濊€?..</span></div></div>`;
    } else {
      const agentNames = Array.from(selectedAgents).map(id => {
        const a = agentsData.find(x => x.id === id);
        return a ? (a.name.split(' ').pop() || a.name) : id;
      }).join('銆?);
      waitingMsg.innerHTML = `<div class="message-avatar">馃懃</div><div class="message-content">
        <div class="message-bubble">
          <div style="font-weight:500;margin-bottom:4px;color:#2563eb;">馃尃 鍗忎綔澶勭悊涓?/div>
          <div style="font-size:12px;color:#64748b;">鍙備笌: ${agentNames}</div>
          <div class="typing-indicator" style="margin-top:8px;"><span class="typing-dots"><span></span><span></span><span></span></span> 鏅鸿兘浣撴鍦ㄥ崗鍚屽伐浣?..</div>
        </div>
      </div>`;
    }
    msgs.appendChild(waitingMsg);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      let result;
      if (currentMode === 'single') {
        const res = await fetch('/api/agents/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ agentId: currentAgent, message: text, conversationId: conversationIds[currentAgent] })
        });
        if (res.status === 401 || res.status === 403) {
          waitingMsg.remove();
          localStorage.removeItem('token');
          localStorage.removeItem('currentUser');
          document.getElementById('chatMessages').innerHTML = '<div style="padding:40px;text-align:center"><h4 style="color:#0f172a;margin-bottom:8px;">鐧诲綍宸茶繃鏈?/h4><p style="color:#64748b;">璇疯繑鍥為椤甸噸鏂扮櫥褰?/p><button onclick="window.location.href=\'/\'" style="padding:8px 20px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;">杩斿洖棣栭〉鐧诲綍</button></div>';
          return;
        }
        result = await res.json();
        waitingMsg.remove();
        if (result.success) {
          const agent = agentsData.find(a => a.id === currentAgent);
          const avatarName = agent ? getAgentEmoji(currentAgent) : '馃';
          const botMsg = createMessage('assistant', avatarName, result.content);
          const meta = botMsg.querySelector('.msg-meta');
          if (meta) meta.innerHTML += ` 路 <span style="color:#2563eb;">${result.tokens} tokens 路 ${result.elapsed}ms</span>`;
          msgs.appendChild(botMsg);
        } else {
          const errMsg = createMessage('assistant', '鈿?, '鎶辨瓑锛屽彂鐢熶簡閿欒锛? + (result.error || '鏈煡閿欒'));
          msgs.appendChild(errMsg);
        }
      } else {
        const apiMode = currentMode === 'sequential' ? 'sequential' : 'parallel';
        const res = await fetch('/api/agents/collaboration/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            message: text,
            mode: apiMode,
            agents: Array.from(selectedAgents),
            sessionId: 'collab_' + Date.now()
          })
        });
        if (res.status === 401 || res.status === 403) {
          waitingMsg.remove();
          localStorage.removeItem('token');
          localStorage.removeItem('currentUser');
          document.getElementById('chatMessages').innerHTML = '<div style="padding:40px;text-align:center"><h4 style="color:#0f172a;margin-bottom:8px;">鐧诲綍宸茶繃鏈?/h4><p style="color:#64748b;">璇疯繑鍥為椤甸噸鏂扮櫥褰?/p><button onclick="window.location.href=\'/\'" style="padding:8px 20px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;">杩斿洖棣栭〉鐧诲綍</button></div>';
          return;
        }
        result = await res.json();
        waitingMsg.remove();

        if (result.success) {
          const collabContainer = document.createElement('div');
          collabContainer.className = 'message assistant';
          collabContainer.style.display = 'block';
          collabContainer.style.width = '100%';

          let stepHtml = '';

          if (result.plan) {
            stepHtml += `<div class="collaboration-panel">
              <div class="collab-panel-title">鍗忎綔鏂规</div>
              <div class="collab-panel-desc">${result.plan.rationale || (result.mode === 'sequential' ? '鏅鸿兘浣撴寜椤哄簭渚濇澶勭悊' : '澶氫釜鏅鸿兘浣撲粠涓嶅悓瑙掑害鍚屾椂鍒嗘瀽')}</div>
            </div>`;
          }

          result.steps.forEach((step, idx) => {
            const stepNum = idx + 1;
            const modeLabel = result.mode === 'sequential' ? `姝ラ ${stepNum}` : `鏂规 ${stepNum}`;
            const arrowIcon = (idx < result.steps.length - 1 && result.mode === 'sequential') ? '<div class="flow-arrow">鈻?/div>' : '';
            stepHtml += `
              <div class="collab-result-card">
                <div class="collab-result-header">
                  <div class="collab-result-left">
                    <span class="step-badge">${modeLabel}</span>
                    <span style="font-size:13px;font-weight:500;color:#0f172a;">${step.agentName || step.agent}</span>
                  </div>
                  <div style="font-size:11px;color:#94a3b8;">${step.tokens || 0} t 路 ${step.elapsed || 0}ms</div>
                </div>
                <div class="collab-result-body">${formatMarkdown(step.content || '鏃犲唴瀹?)}</div>
              </div>
              ${arrowIcon}
            `;
          });

          if (result.summary && result.summary.success) {
            stepHtml += `
              <div class="collab-summary-card">
                <div class="collab-summary-title">馃拵 缁煎悎姹囨€?/div>
                <div style="line-height:1.7;font-size:14px;color:#1e3a8a;">${formatMarkdown(result.summary.content || '')}</div>
                <div class="collab-meta">
                  鈴?鎬昏€楁椂 ${result.totalElapsed || 0}ms 路 馃捇 ${result.totalTokens || 0} tokens
                </div>
              </div>
            `;
          }

          collabContainer.innerHTML = `<div class="message-avatar">馃懃</div><div class="message-content"><div class="message-bubble" style="padding:0;background:transparent;border:none;box-shadow:none;">${stepHtml}</div><div class="msg-meta">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div></div>`;
          msgs.appendChild(collabContainer);
        } else {
          const errMsg = createMessage('assistant', '鈿?, '鍗忎綔澶辫触锛? + (result.error || '鏈煡閿欒'));
          msgs.appendChild(errMsg);
        }
      }
    } catch (e) {
      waitingMsg.remove();
      const errMsg = createMessage('assistant', '鈿?, '缃戠粶閿欒锛? + e.message);
      msgs.appendChild(errMsg);
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  function clearChat() {
    if (!confirm('纭娓呯┖褰撳墠瀵硅瘽锛?)) return;
    conversationIds = {};
    const welcomeHtml = `<div class="welcome-card">
      <div class="welcome-title"><span style="color:#2563eb;">鉁?/span> 娆㈣繋浣跨敤鏅鸿兘鍔╂墜</div>
      <div class="welcome-subtitle">涓轰紒涓氬叕鏂囧満鏅彁渚涚殑澶氭櫤鑳戒綋鍗忓悓宸ヤ綔骞冲彴</div>
      <div class="feature-grid">
        <div class="feature-item">馃挰 閫氱敤瀵硅瘽</div>
        <div class="feature-item">馃搫 鍏枃鎾板啓</div>
        <div class="feature-item">鉁?瀹℃壒鍒嗘瀽</div>
        <div class="feature-item">馃搳 鏁版嵁娲炲療</div>
        <div class="feature-item">鈱笍 浠ｇ爜鏀寔</div>
        <div class="feature-item">馃挕 娣卞害鎺ㄧ悊</div>
      </div>
    </div>`;
    document.getElementById('chatMessages').innerHTML = welcomeHtml;
    messageCount = 0;
  }

  // 鍚姩娴佺▼锛氬厛妫€鏌ョ櫥褰曪紝鍐嶅姞杞芥櫤鑳戒綋鍒楄〃
  (async function init() {
    if (!checkAuth()) return;
    await loadAgents();
  })();

