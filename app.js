/**
 * app.js - Orquestador PWA (API, IndexedDB y UI)
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwF3WTRVnPXfqjYm7Q8aExdvGNyK3SBNhvq-oZl2wjirSKZ6UtdprgZM1Vvz52nBTgj/exec'; // <-- ¡CAMBIA ESTO!

// ==========================================
// 1. COMUNICACIÓN BACKEND (GAS)
// ==========================================
const API = {
  async call(action, payload = {}) {
    payload.action = action;
    try {
      const res = await fetch(GAS_URL, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' } // Evita error CORS
      });
      return await res.json();
    } catch (e) {
      console.error("API Error:", e);
      return null;
    }
  }
};

// ==========================================
// 2. BASE DE DATOS LOCAL (IndexedDB)
// ==========================================
const LocalDB = {
  db: null,
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('P2P_Lang_DB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('profiles')) {
          db.createObjectStore('profiles', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = (e) => reject(e.target.error);
    });
  },
  async getProfile(id) {
    return new Promise((resolve) => {
      const req = this.db.transaction(['profiles']).objectStore('profiles').get(id);
      req.onsuccess = () => resolve(req.result);
    });
  },
  async saveProfile(profile) {
    return new Promise((resolve) => {
      const tx = this.db.transaction(['profiles'], 'readwrite');
      tx.objectStore('profiles').put(profile);
      tx.oncomplete = () => resolve();
    });
  }
};

// ==========================================
// 3. LÓGICA DE LA APLICACIÓN (UI)
// ==========================================
const App = {
  myProfile: null,

  async init() {
    await LocalDB.init();
    
    // Auto-login simple (Si ya hay perfil local, entra directo)
    const savedProfile = localStorage.getItem('my_profile');
    if (savedProfile) {
      this.myProfile = JSON.parse(savedProfile);
      this.showView('rooms-view');
      this.loadRooms();
    }
  },

  // --- LOGIN ---
  async login() {
    const name = document.getElementById('username').value;
    const native = document.getElementById('nativeLang').value;
    const learning = document.getElementById('learningLang').value;
    
    if (!name) return alert("Pon un nombre");

    this.myProfile = {
      id: 'user_' + Math.random().toString(36).substr(2, 9),
      name, nativeLang: native, learningLang: learning, bio: 'Estudiante'
    };

    localStorage.setItem('my_profile', JSON.stringify(this.myProfile));
    
    // Guardar en backend (GAS)
    await API.call('saveProfile', { profile: this.myProfile });
    
    this.showView('rooms-view');
    this.loadRooms();
  },

  // --- LISTAR SALAS ---
  async loadRooms() {
    const res = await API.call('listRooms');
    const container = document.getElementById('rooms-list');
    container.innerHTML = '';

    if (res && res.rooms) {
      res.rooms.forEach(room => {
        const btn = document.createElement('button');
        btn.className = 'room-card';
        btn.innerHTML = `<b>${room.title}</b><br>ID: ${room.id}`;
        btn.onclick = () => this.joinRoom(room.id, room.creatorId);
        container.appendChild(btn);
      });
    }
  },

  // --- CREAR SALA ---
  async createRoom() {
    const title = prompt("Nombre de la sala:");
    if (!title) return;

    const res = await API.call('createRoom', { title: title, creatorId: this.myProfile.id });
    if (res && res.status === 'ok') {
      this.joinRoom(res.room.id, this.myProfile.id);
    }
  },

  // --- ENTRAR A LA SALA ---
  async joinRoom(roomId, hostId) {
    this.showView('active-room-view');
    document.getElementById('room-title').innerText = "Conectando a la sala...";
    document.getElementById('peers-container').innerHTML = '';

    // 1. Inicializar Audio local (Micrófono)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    await SwarmEngine.init(this.myProfile.id, stream);
    
    // 2. Avisar al Backend que entramos
    const res = await API.call('joinRoom', { roomId, peerId: this.myProfile.id });
    
    if (res && res.roomEnded) {
      alert("La sala ha terminado.");
      this.showView('rooms-view');
      this.loadRooms();
      return;
    }

    document.getElementById('room-title').innerText = `Sala: ${roomId}`;

    // 3. Arrancar el motor P2P
    SwarmEngine.joinRoom(roomId, hostId);

    // Renderizar al host y a mí mismo (Visual)
    this.renderUserCard(this.myProfile.id);
  },

  // --- UI: DIBUJAR USUARIO (IndexedDB + Backend) ---
  async renderUserCard(peerId) {
    let container = document.getElementById('peers-container');
    if (document.getElementById(`card_${peerId}`)) return; // Ya existe

    let profile = await LocalDB.getProfile(peerId);
    if (!profile) {
      // Magia: Si no está en IndexedDB, lo pedimos a GAS y lo guardamos
      const res = await API.call('getProfile', { userId: peerId });
      if (res && res.profile) {
        profile = res.profile;
        await LocalDB.saveProfile(profile);
      } else {
        profile = { id: peerId, name: 'Anónimo' };
      }
    }

    const card = document.createElement('div');
    card.id = `card_${peerId}`;
    card.className = 'peer-card';
    card.innerHTML = `<b>${profile.name}</b><br><small>${peerId === SwarmEngine.hostId ? '👑 Host' : 'Participante'}</small>`;
    container.appendChild(card);
  },

  // --- UI: REPRODUCIR AUDIO (Llamado por SwarmEngine) ---
  playAudio(peerId, stream) {
    let audio = document.getElementById(`audio_${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio_${peerId}`;
      audio.autoplay = true;
      document.getElementById('audio-tags').appendChild(audio);
    }
    audio.srcObject = stream;
    
    // Dibujar tarjeta visual del usuario cuando el audio llegue
    this.renderUserCard(peerId);
  },

  // --- UTILIDADES ---
  showView(viewId) {
    document.querySelectorAll('.view').forEach(el => el.style.display = 'none');
    document.getElementById(viewId).style.display = 'block';
  }
};

window.onload = () => App.init();
                            
