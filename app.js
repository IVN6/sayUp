/**
 * app.js - Orquestador PWA (API, IndexedDB y UI)
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwF3WTRVnPXfqjYm7Q8aExdvGNyK3SBNhvq-oZl2wjirSKZ6UtdprgZM1Vvz52nBTgj/exec'; // <-- ¡CAMBIA ESTO!

/**
 * APP ORQUESTADOR Y CHAT P2P
 */

const API = {
  async call(action, payload = {}) {
    payload.action = action;
    try {
      console.log(`[GAS] Ejecutando: ${action}...`);
      // Volvemos a tu fetch original: sin headers extraños ni redirect: "follow"
      const res = await fetch(GAS_URL, { 
        method: 'POST', 
        body: JSON.stringify(payload) 
      });
      return await res.json();
    } catch (err) {
      console.error("Error HTTP:", err.toString());
      return null;
    }
  }
};


const App = {
  myProfile: null,

  init() {
    const saved = localStorage.getItem('my_profile');
    if (saved) {
      this.myProfile = JSON.parse(saved);
      this.showView('rooms-view');
      this.loadRooms();
    }
  },

  notify(text) {
    const banner = document.getElementById('status-banner');
    banner.innerText = text;
    banner.style.display = 'block';
    setTimeout(() => { banner.style.display = 'none'; }, 3500);
  },

  async login() {
    const name = document.getElementById('username').value.trim();
    if (!name) return this.notify("Ingresa un nombre válido");

    this.myProfile = {
      id: 'user_' + Math.floor(Math.random() * 899999 + 100000),
      name: name
    };

    localStorage.setItem('my_profile', JSON.stringify(this.myProfile));
    this.showView('rooms-view');
    this.loadRooms();
  },

   async loadRooms() {
    this.notify("Buscando salas disponibles..."); // Letrero visual
    
    const res = await API.call('listRooms');
    const container = document.getElementById('rooms-list');
    container.innerHTML = '';

    // Verificamos si hay salas en la respuesta de GAS
    if (res && res.rooms && res.rooms.length > 0) {
      res.rooms.forEach(room => {
        const btn = document.createElement('button');
        btn.className = 'room-btn';
        // Aquí extraemos correctamente el ID que nos manda el servidor
        btn.innerHTML = `<b>Sala #${room.id}</b>`;
        
        // Nos unimos enviando el ID de la sala y el ID de su creador real
        btn.onclick = () => this.joinRoom(room.id, room.creatorId); 
        container.appendChild(btn);
      });
      this.notify("Salas actualizadas");
    } else {
      container.innerHTML = '<i>No hay salas activas. ¡Crea una!</i>';
    }
  },

  async createRoom() {
    this.notify("Creando sala pública..."); // Letrero visual
    
    // AHORA SÍ LE AVISAMOS A GAS QUE CREE LA SALA
    const res = await API.call('createRoom', { creatorId: this.myProfile.id });
    
    // Si GAS responde que todo salió bien y nos da el ID oficial:
    if (res && res.status === 'ok' && res.room) {
      this.joinRoom(res.room.id, this.myProfile.id);
    } else {
      this.notify("Error de red: No se pudo crear la sala en el servidor.");
    }
  },

  async joinRoom(roomId, hostId) {
    this.showView('active-room-view');
    document.getElementById('room-title').innerText = `Sala #${roomId}`;
    document.getElementById('peers-container').innerHTML = '';
    document.getElementById('chat-box').innerHTML = '';

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    await SwarmEngine.init(this.myProfile.id, stream);
    
    await API.call('joinRoom', { roomId: roomId, peerId: this.myProfile.id });
    SwarmEngine.joinRoom(roomId, hostId);

    this.renderUserCard(this.myProfile.id, "Tú");
  },

  leaveRoom() {
    SwarmEngine.stop();
    this.showView('rooms-view');
    this.loadRooms();
  },

  renderUserCard(peerId, label = "Participante") {
    const container = document.getElementById('peers-container');
    if (document.getElementById(`card_${peerId}`)) return;

    const card = document.createElement('div');
    card.id = `card_${peerId}`;
    card.className = 'peer-card';
    card.innerHTML = `<b>${label}</b><br><small>${peerId}</small>`;
    container.appendChild(card);
  },

  playAudio(peerId, stream) {
    let audio = document.getElementById(`audio_${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio_${peerId}`;
      audio.autoplay = true;
      document.getElementById('audio-tags').appendChild(audio);
    }
    audio.srcObject = stream;
    this.renderUserCard(peerId);
  },

  // --- CHAT P2P Y ARCHIVOS ---
  sendChatText() {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    if (!text) return;

    SwarmEngine.broadcastData({ type: 'chat_text', text: text });
    this.appendChatMessage("Yo", text);
    input.value = '';
  },

  sendChatFile() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return this.notify("Máximo 3 MB por archivo");

    const reader = new FileReader();
    reader.onload = (e) => {
      const fileData = e.target.result;
      SwarmEngine.broadcastData({
        type: 'chat_file',
        fileName: file.name,
        fileType: file.type,
        fileData: fileData
      });
      this.appendChatMessage("Yo (Archivo)", file.name, file.type, fileData);
      fileInput.value = '';
    };
    reader.readAsDataURL(file);
  },

  appendChatMessage(sender, text, mimeType = null, dataUrl = null) {
    const box = document.getElementById('chat-box');
    let html = `<div class="chat-msg"><b>${sender}:</b> ${text}`;
    if (dataUrl) {
      if (mimeType && mimeType.startsWith('image/')) {
        html += `<br><img src="${dataUrl}" class="chat-img">`;
      } else {
        html += `<br><a href="${dataUrl}" download="${text}" style="color:#58a6ff;">Descargar archivo</a>`;
      }
    }
    html += `</div>`;
    box.innerHTML += html;
    box.scrollTop = box.scrollHeight;
  },

  showView(viewId) {
    document.querySelectorAll('.view').forEach(el => el.style.display = 'none');
    document.getElementById(viewId).style.display = 'block';

    const nav = document.getElementById('bottom-nav');
    nav.style.display = (viewId === 'login-view' || viewId === 'active-room-view') ? 'none' : 'flex';
  },

  switchTab(viewId, btn) {
    this.showView(viewId);
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (viewId === 'rooms-view') this.loadRooms();
  }
};

window.onload = () => App.init();
    
