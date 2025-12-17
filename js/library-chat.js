// Library Chat Manager - Chat with entire document library or specific collections
// Integrates with Vertesia DocumentChat interaction and existing collections system

class LibraryChatManager {
  constructor(app) {
    this.app = app;
    this.messages = [];
    this.chatHistory = [];  // Saved chat sessions
    this.currentChatId = null;
    this.selectedCollections = new Set();  // Empty = all documents
    this.isStreaming = false;
    this.streamAbortController = null;
    
    this.STORAGE_KEY = 'library_chat_history';
    this.MAX_HISTORY = 50;
    
    this.init();
  }

  init() {
    this.loadChatHistory();
    this.bindEvents();
    this.renderChatHistory();
    console.log('Library Chat Manager initialized');
  }

  // ===== EVENT BINDING =====

  bindEvents() {
    // New chat button
    const newChatBtn = document.getElementById('newChatBtn');
    newChatBtn?.addEventListener('click', () => this.startNewChat());

    // Save chat button
    const saveChatBtn = document.getElementById('saveChatBtn');
    saveChatBtn?.addEventListener('click', () => this.saveCurrentChat());

    // Send message
    const sendBtn = document.getElementById('libraryChatSend');
    const input = document.getElementById('libraryChatInput');
    
    sendBtn?.addEventListener('click', () => this.sendMessage());
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea
    input?.addEventListener('input', () => this.autoResizeInput(input));

    // Collection selector
    const collectionBtn = document.getElementById('collectionSelectorBtn');
    const collectionPopup = document.getElementById('collectionSelectorPopup');
    
    collectionBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      collectionPopup?.classList.toggle('open');
    });

    // Close popup on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.collection-selector-popup') && 
          !e.target.closest('#collectionSelectorBtn')) {
        collectionPopup?.classList.remove('open');
      }
    });

    // Close popup button
    const closePopupBtn = document.getElementById('closeCollectionPopup');
    closePopupBtn?.addEventListener('click', () => {
      collectionPopup?.classList.remove('open');
    });

    // Chat history item clicks (event delegation)
    const historyList = document.getElementById('chatHistoryList');
    historyList?.addEventListener('click', (e) => {
      const item = e.target.closest('.chat-history-item');
      const starBtn = e.target.closest('.chat-history-star');
      
      if (starBtn && item) {
        e.stopPropagation();
        this.toggleStarChat(item.dataset.chatId);
      } else if (item) {
        this.loadChat(item.dataset.chatId);
      }
    });

    // Collection selector popup - collection toggles
    const selectorList = document.getElementById('collectionSelectorList');
    selectorList?.addEventListener('click', (e) => {
      const option = e.target.closest('.collection-option');
      if (!option) return;

      const collectionId = option.dataset.collectionId;
      
      if (collectionId === 'all') {
        // "All Documents" option - clear all selections
        this.selectedCollections.clear();
      } else {
        // Toggle specific collection
        if (this.selectedCollections.has(collectionId)) {
          this.selectedCollections.delete(collectionId);
        } else {
          this.selectedCollections.add(collectionId);
        }
      }

      this.renderCollectionSelector();
      this.renderCollectionBar();
    });

    // Remove collection tag
    const collectionBar = document.getElementById('chatCollectionBar');
    collectionBar?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.collection-tag-remove');
      if (removeBtn) {
        const collectionId = removeBtn.dataset.collectionId;
        this.selectedCollections.delete(collectionId);
        this.renderCollectionSelector();
        this.renderCollectionBar();
      }
    });
  }

  autoResizeInput(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  }

  // ===== CHAT OPERATIONS =====

  startNewChat() {
    // Save current chat if it has messages
    if (this.messages.length > 0 && !this.currentChatId) {
      this.saveCurrentChat();
    }

    // Reset state
    this.currentChatId = null;
    this.messages = [];
    this.selectedCollections.clear();

    // Update UI
    this.renderMessages();
    this.renderCollectionSelector();
    this.renderCollectionBar();
    this.renderChatHistory();

    // Focus input
    document.getElementById('libraryChatInput')?.focus();
  }

  async sendMessage() {
    const input = document.getElementById('libraryChatInput');
    const message = input?.value?.trim();
    
    if (!message || this.isStreaming) return;

    // Clear input
    input.value = '';
    input.style.height = 'auto';

    // Add user message
    this.addMessage('user', message);

    // Add thinking indicator
    this.showThinking();

    // Disable input during streaming
    this.setInputEnabled(false);

    try {
      // Build the task prompt with collection filtering
      const task = this.buildTaskPrompt(message);
      
      console.log('Sending chat message with task:', task);

      // Start async execution
      const response = await this.executeChat(task);
      
      if (response.runId && response.workflowId) {
        // Stream the response
        await this.streamResponse(response.workflowId, response.runId);
      } else {
        throw new Error('Invalid response: missing runId or workflowId');
      }

    } catch (error) {
      console.error('Chat error:', error);
      this.hideThinking();
      this.addMessage('ai', 'Sorry, there was an error processing your question. Please try again.');
    } finally {
      this.setInputEnabled(true);
    }
  }

  buildTaskPrompt(question) {
    let task = '';

    // Add collection filtering instruction
    if (this.selectedCollections.size > 0) {
      const collectionNames = Array.from(this.selectedCollections)
        .map(id => {
          const col = this.app.collectionsManager?.collections.find(c => c.id === id);
          return col ? col.name : id;
        })
        .filter(Boolean);

      task += `IMPORTANT: Only search and reference documents from these collections: ${collectionNames.join(', ')}.\n\n`;
      
      // Include collection IDs for precise filtering
      task += `Collection IDs to search: ${Array.from(this.selectedCollections).join(', ')}\n\n`;
    } else {
      task += `Search across ALL documents in the library.\n\n`;
    }

    // Add conversation history if exists
    if (this.messages.length > 1) {
      const historyStr = this.messages
        .slice(-10) // Last 10 messages for context
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
        interaction: 'DocumentChat',
        data: { task: task },
        config: {
          environment: CONFIG.ENVIRONMENT_ID,
          model: CONFIG.MODEL
        },
        interactive: true,
        max_iterations: 100
      })
    });

    if (!response.ok) {
      throw new Error(`API call failed: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  async streamResponse(workflowId, runId) {
    this.isStreaming = true;
    this.streamAbortController = new AbortController();

    const url = `${CONFIG.VERTESIA_API_BASE}/workflows/runs/${workflowId}/${runId}/stream?since=${Date.now()}&access_token=${CONFIG.VERTESIA_API_KEY}`;

    try {
      const response = await fetch(url, {
        signal: this.streamAbortController.signal
      });

      if (!response.ok) {
        throw new Error(`Stream failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasReceivedAnswer = false;

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          console.log('Stream ended');
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;

          try {
            const data = JSON.parse(line.slice(5).trim());
            console.log('Stream event:', data.type);

            // Only process answer type
            if (data.type === 'answer' && data.message && !hasReceivedAnswer) {
              const cleanAnswer = this.extractAnswer(data.message);
              
              if (cleanAnswer && cleanAnswer.trim().length > 10) {
                hasReceivedAnswer = true;
                this.hideThinking();
                this.addMessage('ai', cleanAnswer);
                console.log('Received answer');
              }
            }

            // Check for stream end
            if (data.type === 'finish' || data.finish_reason === 'stop') {
              console.log('Stream finish signal received');
              return;
            }

          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      // If stream ended without answer, show fallback
      if (!hasReceivedAnswer) {
        this.hideThinking();
        this.addMessage('ai', 'I processed your request but couldn\'t generate a response. Please try rephrasing your question.');
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Stream aborted');
        return;
      }
      throw error;
    } finally {
      this.isStreaming = false;
      this.streamAbortController = null;
    }
  }

  extractAnswer(fullMessage) {
    if (!fullMessage) return '';

    // Try to extract "Agent Answer" section
    const match = fullMessage.match(/\*\*3\.\s*Agent Answer:\*\*\s*([\s\S]*?)(?=\*\*\d+\.|$)/i);
    if (match) return match[1].trim();

    // Fallback patterns
    const altMatch = fullMessage.match(/Agent Answer[:\s]*([\s\S]*?)(?=User Query|Resources Search|$)/i);
    if (altMatch) return altMatch[1].trim();

    return fullMessage;
  }

  // ===== MESSAGE RENDERING =====

  addMessage(role, content) {
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    });

    this.messages.push({ role, content, timestamp, id: Date.now() });
    this.renderMessages();
  }

  renderMessages() {
    const container = document.getElementById('chatMessagesArea');
    if (!container) return;

    if (this.messages.length === 0) {
      container.innerHTML = this.getWelcomeHTML();
      return;
    }

    container.innerHTML = this.messages.map(msg => this.getMessageHTML(msg)).join('');
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  getWelcomeHTML() {
    return `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <h3>Chat with Your Research Library</h3>
        <p>Ask questions about your documents. You can search across all documents or select specific collections to focus your queries.</p>
      </div>
    `;
  }

  getMessageHTML(msg) {
    const avatarContent = msg.role === 'user' ? 'U' : 'AI';
    const formattedContent = msg.role === 'ai' 
      ? this.formatAIMessage(msg.content)
      : this.escapeHtml(msg.content);

    return `
      <div class="chat-msg ${msg.role}">
        <div class="chat-msg-avatar">${avatarContent}</div>
        <div class="chat-msg-content">
          <div class="chat-msg-bubble">${formattedContent}</div>
          <div class="chat-msg-time">${msg.timestamp}</div>
        </div>
      </div>
    `;
  }

  formatAIMessage(content) {
    if (!content) return '';

    // Escape HTML first
    let formatted = this.escapeHtml(content);

    // Convert markdown-style formatting
    // Bold: **text**
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    
    // Bullet points
    formatted = formatted.replace(/^[•\-]\s+(.+)$/gm, '<li>$1</li>');
    
    // Wrap consecutive list items
    formatted = formatted.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Paragraphs (double line breaks)
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

    const thinkingHTML = `
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
    `;

    container.insertAdjacentHTML('beforeend', thinkingHTML);
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

  renderCollectionSelector() {
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
      const count = this.app.collectionsManager?.getDocumentCount(col.id) || 0;
      
      return `
        <div class="collection-option ${isSelected ? 'selected' : ''}" data-collection-id="${col.id}">
          <input type="checkbox" ${isSelected ? 'checked' : ''} readonly>
          <span class="collection-option-name">${col.name}</span>
          <span class="collection-option-count">${count}</span>
        </div>
      `;
    }).join('');

    list.innerHTML = html;
  }

  renderCollectionBar() {
    const bar = document.getElementById('chatCollectionBar');
    if (!bar) return;

    if (this.selectedCollections.size === 0) {
      bar.innerHTML = `
        <span class="collection-indicator-label">Searching:</span>
        <span class="collection-tag all-docs">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          All Documents
        </span>
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
          ${col.name}
          <button class="collection-tag-remove" data-collection-id="${col.id}" title="Remove">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </span>
      `).join('');

      html += `
        <button class="collection-selector-btn" id="collectionSelectorBtn" title="Add more collections">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      `;

      bar.innerHTML = html;
    }

    // Re-bind collection selector button
    const collectionBtn = document.getElementById('collectionSelectorBtn');
    const collectionPopup = document.getElementById('collectionSelectorPopup');
    
    collectionBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      collectionPopup?.classList.toggle('open');
    });
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
      // Keep only most recent chats
      const toSave = this.chatHistory.slice(0, this.MAX_HISTORY);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(toSave));
    } catch (error) {
      console.error('Failed to save chat history:', error);
    }
  }

  saveCurrentChat() {
    if (this.messages.length === 0) return;

    // Generate title from first user message
    const firstUserMsg = this.messages.find(m => m.role === 'user');
    const title = firstUserMsg 
      ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
      : 'Untitled Chat';

    const chatData = {
      id: this.currentChatId || `chat_${Date.now()}`,
      title: title,
      messages: [...this.messages],
      collections: Array.from(this.selectedCollections),
      starred: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Update or add to history
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

    console.log('Chat saved:', chatData.id);
  }

  loadChat(chatId) {
    const chat = this.chatHistory.find(c => c.id === chatId);
    if (!chat) return;

    // Save current chat first if needed
    if (this.messages.length > 0 && this.currentChatId !== chatId) {
      this.saveCurrentChat();
    }

    // Load the selected chat
    this.currentChatId = chat.id;
    this.messages = [...chat.messages];
    this.selectedCollections = new Set(chat.collections || []);

    // Update UI
    this.renderMessages();
    this.renderCollectionSelector();
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
    const starredSection = document.getElementById('starredChatsSection');
    const recentSection = document.getElementById('recentChatsSection');
    
    if (!list) return;

    const starred = this.chatHistory.filter(c => c.starred);
    const recent = this.chatHistory.filter(c => !c.starred).slice(0, 10);

    // Show/hide starred section
    if (starredSection) {
      starredSection.style.display = starred.length > 0 ? 'block' : 'none';
    }

    // Render all chats
    let html = '';

    // Starred chats
    if (starred.length > 0) {
      html += starred.map(chat => this.getChatHistoryItemHTML(chat)).join('');
    }

    // Recent divider if both sections have items
    if (starred.length > 0 && recent.length > 0) {
      html += `<div class="chat-history-section" style="padding-top: 12px;"><div class="chat-history-title">Recent</div></div>`;
    }

    // Recent chats
    if (recent.length > 0) {
      html += recent.map(chat => this.getChatHistoryItemHTML(chat)).join('');
    }

    // Empty state
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="chat-history-info">
          <div class="chat-history-name">${this.escapeHtml(chat.title)}</div>
          <div class="chat-history-meta">${dateStr}</div>
        </div>
        <div class="chat-history-star ${chat.starred ? 'starred' : ''}" title="${chat.starred ? 'Unstar' : 'Star'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${chat.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </div>
      </div>
    `;
  }

  // ===== VIEW MANAGEMENT =====

  activate() {
    const container = document.getElementById('chatContainer');
    if (container) {
      container.classList.add('active');
    }

    // Initialize collection selector
    this.renderCollectionSelector();
    this.renderCollectionBar();
    this.renderMessages();
    this.renderChatHistory();
  }

  deactivate() {
    const container = document.getElementById('chatContainer');
    if (container) {
      container.classList.remove('active');
    }

    // Stop any active stream
    if (this.streamAbortController) {
      this.streamAbortController.abort();
    }
  }
}

// Export for global access
window.LibraryChatManager = LibraryChatManager;
