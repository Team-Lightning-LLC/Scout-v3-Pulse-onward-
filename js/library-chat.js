// Library Chat Manager - FIXED VERSION
// Chat with entire document library or specific collections

class LibraryChatManager {
  constructor(app) {
    this.app = app;
    this.messages = [];
    this.chatHistory = [];
    this.currentChatId = null;
    this.selectedCollections = new Set();
    this.isStreaming = false;
    this.streamAbortController = null;
    
    this.STORAGE_KEY = 'library_chat_history';
    this.MAX_HISTORY = 50;
    
    this.init();
  }

  init() {
    this.loadChatHistory();
    this.renderChatHistory();
    this.renderWelcome();
    this.renderCollectionBar();
    this.bindEvents();
    console.log('Library Chat Manager initialized');
  }

  // ===== EVENT BINDING =====
  bindEvents() {
    // New chat button
    document.getElementById('newChatBtn')?.addEventListener('click', () => this.startNewChat());

    // Save chat button
    document.getElementById('saveChatBtn')?.addEventListener('click', () => this.saveCurrentChat());

    // Send message
    document.getElementById('libraryChatSend')?.addEventListener('click', () => this.sendMessage());
    
    const input = document.getElementById('libraryChatInput');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea
    input?.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // Collection selector button
    document.getElementById('collectionSelectorBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = document.getElementById('collectionSelectorPopup');
      popup?.classList.toggle('open');
      if (popup?.classList.contains('open')) {
        this.renderCollectionOptions();
      }
    });

    // Close popup on outside click
    document.addEventListener('click', (e) => {
      const popup = document.getElementById('collectionSelectorPopup');
      if (popup?.classList.contains('open') && 
          !e.target.closest('#collectionSelectorPopup') && 
          !e.target.closest('#collectionSelectorBtn')) {
        popup.classList.remove('open');
      }
    });

    // Close popup button
    document.getElementById('closeCollectionPopup')?.addEventListener('click', () => {
      document.getElementById('collectionSelectorPopup')?.classList.remove('open');
    });

    // Chat history clicks
    document.getElementById('chatHistoryList')?.addEventListener('click', (e) => {
      const item = e.target.closest('.chat-history-item');
      const starBtn = e.target.closest('.chat-history-star');
      
      if (starBtn && item) {
        e.stopPropagation();
        this.toggleStarChat(item.dataset.chatId);
      } else if (item) {
        this.loadChat(item.dataset.chatId);
      }
    });

    // Collection option clicks
    document.getElementById('collectionSelectorList')?.addEventListener('click', (e) => {
      const option = e.target.closest('.collection-option');
      if (!option) return;

      const collectionId = option.dataset.collectionId;
      
      if (collectionId === 'all') {
        this.selectedCollections.clear();
      } else {
        if (this.selectedCollections.has(collectionId)) {
          this.selectedCollections.delete(collectionId);
        } else {
          this.selectedCollections.add(collectionId);
        }
      }

      this.renderCollectionOptions();
      this.renderCollectionBar();
    });

    // Remove collection tag
    document.getElementById('chatCollectionBar')?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.collection-tag-remove');
      if (removeBtn) {
        const collectionId = removeBtn.dataset.collectionId;
        this.selectedCollections.delete(collectionId);
        this.renderCollectionOptions();
        this.renderCollectionBar();
      }
    });
  }

  // ===== CHAT OPERATIONS =====
  startNewChat() {
    if (this.messages.length > 0 && !this.currentChatId) {
      this.saveCurrentChat();
    }

    this.currentChatId = null;
    this.messages = [];
    this.selectedCollections.clear();

    this.renderWelcome();
    this.renderCollectionBar();
    this.renderChatHistory();

    document.getElementById('libraryChatInput')?.focus();
  }

  async sendMessage() {
    const input = document.getElementById('libraryChatInput');
    const message = input?.value?.trim();
    
    if (!message || this.isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    // Add user message
    this.addMessage('user', message);

    // Show thinking indicator
    this.showThinking();
    this.setInputEnabled(false);

    try {
      const task = this.buildTaskPrompt(message);
      console.log('Sending chat:', task);

      const response = await this.executeChat(task);
      
      if (response.runId && response.workflowId) {
        await this.streamResponse(response.workflowId, response.runId);
      } else {
        throw new Error('Invalid response');
      }

    } catch (error) {
      console.error('Chat error:', error);
      this.hideThinking();
      this.addMessage('ai', 'Sorry, there was an error. Please try again.');
    } finally {
      this.setInputEnabled(true);
    }
  }

  buildTaskPrompt(question) {
    let task = '';

    if (this.selectedCollections.size > 0) {
      const collectionNames = Array.from(this.selectedCollections)
        .map(id => {
          const col = this.app.collectionsManager?.collections.find(c => c.id === id);
          return col ? col.name : id;
        })
        .filter(Boolean);

      task += `IMPORTANT: Only search documents from these collections: ${collectionNames.join(', ')}.\n`;
      task += `Collection IDs: ${Array.from(this.selectedCollections).join(', ')}\n\n`;
    } else {
      task += `Search across ALL documents in the library.\n\n`;
    }

    if (this.messages.length > 1) {
      const historyStr = this.messages
        .slice(-10)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n');
      task += `Previous conversation:\n${historyStr}\n\n`;
    }

    task += `Current question: ${question}`;
    return task;
  }

  async executeChat(task) {
    const response = await fetch(`${CONFIG.VERTESIA_API_BASE}/execute/async`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.VERTESIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'conversation',
        interaction: 'GeneralChat',
        data: { task },
        config: {
          environment: CONFIG.ENVIRONMENT_ID,
          model: CONFIG.MODEL
        },
        interactive: true,
        max_iterations: 100
      })
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return await response.json();
  }

  async streamResponse(workflowId, runId) {
    this.isStreaming = true;
    this.streamAbortController = new AbortController();

    const url = `${CONFIG.VERTESIA_API_BASE}/workflows/runs/${workflowId}/${runId}/stream?since=${Date.now()}&access_token=${CONFIG.VERTESIA_API_KEY}`;

    try {
      const response = await fetch(url, { signal: this.streamAbortController.signal });
      if (!response.ok) throw new Error(`Stream error: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasReceivedAnswer = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;

          try {
            const data = JSON.parse(line.slice(5).trim());

            if (data.type === 'answer' && data.message && !hasReceivedAnswer) {
              const cleanAnswer = this.extractAnswer(data.message);
              
              if (cleanAnswer && cleanAnswer.trim().length > 10) {
                hasReceivedAnswer = true;
                this.hideThinking();
                this.addMessage('ai', cleanAnswer);
              }
            }

            if (data.type === 'finish' || data.finish_reason === 'stop') {
              return;
            }
          } catch (e) {}
        }
      }

      if (!hasReceivedAnswer) {
        this.hideThinking();
        this.addMessage('ai', 'I processed your request but couldn\'t generate a response. Please try rephrasing.');
      }

    } catch (error) {
      if (error.name === 'AbortError') return;
      throw error;
    } finally {
      this.isStreaming = false;
      this.streamAbortController = null;
    }
  }

  extractAnswer(fullMessage) {
    if (!fullMessage) return '';

    const match = fullMessage.match(/\*\*3\.\s*Agent Answer:\*\*\s*([\s\S]*?)(?=\*\*\d+\.|$)/i);
    if (match) return match[1].trim();

    const altMatch = fullMessage.match(/Agent Answer[:\s]*([\s\S]*?)(?=User Query|Resources Search|$)/i);
    if (altMatch) return altMatch[1].trim();

    return fullMessage;
  }

  // ===== RENDERING =====
  addMessage(role, content) {
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    });

    this.messages.push({ role, content, timestamp, id: Date.now() });
    this.renderMessages();
  }

  renderWelcome() {
    const container = document.getElementById('chatMessagesArea');
    if (!container) return;

    container.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <h3>Chat with Your Research Library</h3>
        <p>Ask questions about your documents. Select collections below to focus your search.</p>
      </div>
    `;
  }

  renderMessages() {
    const container = document.getElementById('chatMessagesArea');
    if (!container) return;

    if (this.messages.length === 0) {
      this.renderWelcome();
      return;
    }

    container.innerHTML = this.messages.map(msg => `
      <div class="chat-msg ${msg.role}">
        <div class="chat-msg-avatar">${msg.role === 'user' ? 'U' : 'AI'}</div>
        <div class="chat-msg-content">
          <div class="chat-msg-bubble">${msg.role === 'ai' ? this.formatAIMessage(msg.content) : this.escapeHtml(msg.content)}</div>
          <div class="chat-msg-time">${msg.timestamp}</div>
        </div>
      </div>
    `).join('');
    
    container.scrollTop = container.scrollHeight;
  }

  formatAIMessage(content) {
    if (!content) return '';

    let formatted = this.escapeHtml(content);
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/^[•\-]\s+(.+)$/gm, '<li>$1</li>');
    formatted = formatted.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    const paragraphs = formatted.split('\n\n').filter(p => p.trim());
    formatted = paragraphs.map(p => {
      if (p.startsWith('<ul>')) return p;
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    return formatted;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showThinking() {
    const container = document.getElementById('chatMessagesArea');
    if (!container) return;

    container.insertAdjacentHTML('beforeend', `
      <div class="chat-msg ai thinking" id="thinkingIndicator">
        <div class="chat-msg-avatar">AI</div>
        <div class="chat-msg-content">
          <div class="chat-msg-bubble">
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
          </div>
        </div>
      </div>
    `);
    container.scrollTop = container.scrollHeight;
  }

  hideThinking() {
    document.getElementById('thinkingIndicator')?.remove();
  }

  setInputEnabled(enabled) {
    const input = document.getElementById('libraryChatInput');
    const sendBtn = document.getElementById('libraryChatSend');
    if (input) input.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled;
  }

  // ===== COLLECTION SELECTOR =====
  renderCollectionBar() {
    const bar = document.getElementById('chatCollectionBar');
    if (!bar) return;

    if (this.selectedCollections.size === 0) {
      bar.innerHTML = `
        <span class="collection-indicator-label">Searching:</span>
        <span class="collection-tag all-docs">All Documents</span>
        <button class="collection-selector-btn" id="collectionSelectorBtn" title="Select collections">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      `;
    } else {
      const collections = this.app.collectionsManager?.collections || [];
      const selectedNames = Array.from(this.selectedCollections).map(id => {
        const col = collections.find(c => c.id === id);
        return col ? { id: col.id, name: col.name } : null;
      }).filter(Boolean);

      let html = `<span class="collection-indicator-label">Searching:</span>`;
      html += selectedNames.map(col => `
        <span class="collection-tag">
          ${this.escapeHtml(col.name)}
          <button class="collection-tag-remove" data-collection-id="${col.id}" title="Remove">×</button>
        </span>
      `).join('');
      html += `
        <button class="collection-selector-btn" id="collectionSelectorBtn" title="Add collections">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      `;
      bar.innerHTML = html;
    }

    // Rebind the button event
    document.getElementById('collectionSelectorBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = document.getElementById('collectionSelectorPopup');
      popup?.classList.toggle('open');
      if (popup?.classList.contains('open')) {
        this.renderCollectionOptions();
      }
    });
  }

  renderCollectionOptions() {
    const list = document.getElementById('collectionSelectorList');
    if (!list) return;

    const collections = this.app.collectionsManager?.collections || [];
    const allSelected = this.selectedCollections.size === 0;
    const totalDocs = this.app.documents?.length || 0;

    let html = `
      <div class="collection-option all-docs-option ${allSelected ? 'selected' : ''}" data-collection-id="all">
        <input type="checkbox" ${allSelected ? 'checked' : ''} readonly>
        <span class="collection-option-name">All Documents</span>
        <span class="collection-option-count">${totalDocs}</span>
      </div>
    `;

    html += collections.map(col => {
      const isSelected = this.selectedCollections.has(col.id);
      const count = this.app.collectionsManager?.getDocumentCount?.(col.id) || 0;
      
      return `
        <div class="collection-option ${isSelected ? 'selected' : ''}" data-collection-id="${col.id}">
          <input type="checkbox" ${isSelected ? 'checked' : ''} readonly>
          <span class="collection-option-name">${this.escapeHtml(col.name)}</span>
          <span class="collection-option-count">${count}</span>
        </div>
      `;
    }).join('');

    list.innerHTML = html;
  }

  // ===== CHAT HISTORY =====
  loadChatHistory() {
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      this.chatHistory = saved ? JSON.parse(saved) : [];
    } catch (error) {
      console.error('Failed to load chat history:', error);
      this.chatHistory = [];
    }
  }

  saveChatHistory() {
    try {
      const toSave = this.chatHistory.slice(0, this.MAX_HISTORY);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(toSave));
    } catch (error) {
      console.error('Failed to save chat history:', error);
    }
  }

  saveCurrentChat() {
    if (this.messages.length === 0) return;

    const firstUserMsg = this.messages.find(m => m.role === 'user');
    const title = firstUserMsg 
      ? firstUserMsg.content.slice(0, 40) + (firstUserMsg.content.length > 40 ? '...' : '')
      : 'Untitled Chat';

    const chatData = {
      id: this.currentChatId || `chat_${Date.now()}`,
      title,
      messages: [...this.messages],
      collections: Array.from(this.selectedCollections),
      starred: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const existingIndex = this.chatHistory.findIndex(c => c.id === chatData.id);
    if (existingIndex >= 0) {
      chatData.starred = this.chatHistory[existingIndex].starred;
      this.chatHistory[existingIndex] = chatData;
    } else {
      this.chatHistory.unshift(chatData);
    }

    this.currentChatId = chatData.id;
    this.saveChatHistory();
    this.renderChatHistory();
  }

  loadChat(chatId) {
    const chat = this.chatHistory.find(c => c.id === chatId);
    if (!chat) return;

    if (this.messages.length > 0 && this.currentChatId !== chatId) {
      this.saveCurrentChat();
    }

    this.currentChatId = chat.id;
    this.messages = [...chat.messages];
    this.selectedCollections = new Set(chat.collections || []);

    this.renderMessages();
    this.renderCollectionBar();
    this.renderChatHistory();
  }

  toggleStarChat(chatId) {
    const chat = this.chatHistory.find(c => c.id === chatId);
    if (!chat) return;

    chat.starred = !chat.starred;
    this.saveChatHistory();
    this.renderChatHistory();
  }

  renderChatHistory() {
    const list = document.getElementById('chatHistoryList');
    if (!list) return;

    const starred = this.chatHistory.filter(c => c.starred);
    const recent = this.chatHistory.filter(c => !c.starred).slice(0, 10);

    let html = '';

    if (starred.length > 0) {
      html += `<div class="chat-history-section-title">Starred</div>`;
      html += starred.map(chat => this.getChatHistoryItemHTML(chat)).join('');
    }

    if (recent.length > 0) {
      if (starred.length > 0) {
        html += `<div class="chat-history-section-title" style="margin-top: 12px;">Recent</div>`;
      }
      html += recent.map(chat => this.getChatHistoryItemHTML(chat)).join('');
    }

    if (this.chatHistory.length === 0) {
      html = `<div class="chat-history-empty">No chat history yet</div>`;
    }

    list.innerHTML = html;
  }

  getChatHistoryItemHTML(chat) {
    const isActive = chat.id === this.currentChatId;
    const date = new Date(chat.updatedAt || chat.createdAt);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    return `
      <div class="chat-history-item ${isActive ? 'active' : ''}" data-chat-id="${chat.id}">
        <div class="chat-history-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="chat-history-info">
          <div class="chat-history-name">${this.escapeHtml(chat.title)}</div>
          <div class="chat-history-meta">${dateStr}</div>
        </div>
        <div class="chat-history-star ${chat.starred ? 'starred' : ''}" title="${chat.starred ? 'Unstar' : 'Star'}">★</div>
      </div>
    `;
  }

  // ===== VIEW ACTIVATION =====
  activate() {
    this.renderWelcome();
    this.renderCollectionBar();
    this.renderChatHistory();
    if (this.messages.length > 0) {
      this.renderMessages();
    }
  }

  deactivate() {
    if (this.streamAbortController) {
      this.streamAbortController.abort();
    }
  }
}

window.LibraryChatManager = LibraryChatManager;
