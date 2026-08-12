/**
 * P2P SWARM ENGINE - Arquitectura Indestructible
 * Cero dependencia de servidor una vez conectado.
 */

const SwarmEngine = {
  myId: null,
  myRole: 'listener', // 'host', 'speaker', 'listener'
  hostId: null,
  roomId: null,
  
  peers: {},          // Conexiones WebRTC activas
  dataChannels: {},   // Canales de texto de ultra-baja latencia
  
  localStream: null,
  
  // Variables de resiliencia
  isPolling: false,
  pollTimer: null,
  connectedPeersList: [], // Para saber quién hereda si el Host muere

  config: { 
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] 
  },

  // ---------------------------------------------------------
  // 1. INICIO Y ENTRADA A LA SALA
  // ---------------------------------------------------------
  
  async init(myUserId, stream = null) {
    this.myId = myUserId;
    this.localStream = stream; // Puede ser null si entra como oyente puro
  },

  async joinRoom(roomId, initialHostId) {
    this.roomId = roomId;
    this.hostId = initialHostId;

    if (this.myId === this.hostId) {
      // SOY EL CREADOR: Empiezo a vigilar la puerta (GAS)
      this.myRole = 'host';
      this.connectedPeersList.push(this.myId);
      this.startHostPolling();
      console.log("👑 Soy el Host. Vigilando la entrada...");
    } else {
      // SOY INVITADO: Toco la puerta del Host por GAS una única vez
      console.log(`🚪 Tocando la puerta del Host (${this.hostId})...`);
      await this.createPeerConnection(this.hostId, true, 'gas');
    }
  },

  // ---------------------------------------------------------
  // 2. FÁBRICA DE CONEXIONES Y CANALES DE DATOS
  // ---------------------------------------------------------

  async createPeerConnection(peerId, isInitiator, signalingRoute = 'in-band') {
    const pc = new RTCPeerConnection(this.config);
    this.peers[peerId] = pc;
    
    // Mantenemos una lista ordenada para el Handover (Resiliencia)
    if (!this.connectedPeersList.includes(peerId)) {
      this.connectedPeersList.push(peerId);
      this.connectedPeersList.sort(); // Orden alfabético simple para determinismo
    }

    // --- MAGIA: DATA CHANNELS (El túnel secreto) ---
    if (isInitiator) {
      const dc = pc.createDataChannel("swarm-signaling");
      this.setupDataChannel(peerId, dc);
    } else {
      pc.ondatachannel = (event) => this.setupDataChannel(peerId, event.channel);
    }

    // Enviar ICE Candidates por la ruta adecuada
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.routeSignal(peerId, { type: 'ice', candidate: event.candidate }, signalingRoute);
      }
    };

    // Recibir Audio y Retransmitir (CASCADA / ÁRBOL)
    pc.ontrack = (event) => {
      console.log(`🔊 Audio recibido de ${peerId}`);
      App.playAudio(peerId, event.streams[0]);

      // Si soy un nodo del árbol con "hijos" asignados, les retransmito este track
      this.forwardStreamToChildren(event.streams[0]);
    };

    // Monitoreo de latidos (Caídas de red)
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this.handlePeerDrop(peerId);
      }
    };

    // Si inyectamos audio propio
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    // Crear oferta si somos los que iniciamos
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.routeSignal(peerId, { type: 'offer', sdp: pc.localDescription }, signalingRoute);
    }

    return pc;
  },

  setupDataChannel(peerId, dc) {
    this.dataChannels[peerId] = dc;
    dc.onopen = () => console.log(`⚡ DataChannel abierto con ${peerId}`);
    
    dc.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      
      // Señalización WebRTC que no pasa por GAS
      if (['offer', 'answer', 'ice'].includes(msg.type)) {
        await this.handleWebRTCSignal(peerId, msg);
      }
      // El Host nos ordena conectarnos con alguien nuevo
      else if (msg.type === 'connect_to') {
        console.log(`🔗 El Host me ordenó conectarme a ${msg.targetId}`);
        this.createPeerConnection(msg.targetId, true, 'in-band');
      }
      // Sincronización del estado de la sala
      else if (msg.type === 'swarm_state') {
        this.connectedPeersList = msg.peersList;
      }
    };
  },

  // ---------------------------------------------------------
  // 3. ENRUTADOR DE SEÑALES (GAS vs IN-BAND)
  // ---------------------------------------------------------

  routeSignal(toPeerId, signalData, route) {
    if (route === 'gas') {
      // Solo se usa al entrar a la sala por primera vez
      API.call('sendSignal', { fromPeerId: this.myId, toPeerId: toPeerId, signal: signalData });
    } else {
      // In-Band: Súper rápido, 0 peticiones al servidor. Pasa por el DataChannel
      if (this.dataChannels[toPeerId] && this.dataChannels[toPeerId].readyState === 'open') {
        this.dataChannels[toPeerId].send(JSON.stringify(signalData));
      } else {
        // Si el canal directo no está abierto, usamos al Host como router
        if (this.hostId !== this.myId && this.dataChannels[this.hostId]) {
           this.dataChannels[this.hostId].send(JSON.stringify({
             type: 'relay', targetId: toPeerId, signal: signalData
           }));
        }
      }
    }
  },

  async handleWebRTCSignal(fromPeerId, signal) {
    let pc = this.peers[fromPeerId];
    if (!pc) pc = await this.createPeerConnection(fromPeerId, false, 'in-band');

    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.routeSignal(fromPeerId, { type: 'answer', sdp: pc.localDescription }, 'in-band');
    } 
    else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } 
    else if (signal.type === 'ice') {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  },

  // ---------------------------------------------------------
  // 4. LÓGICA DEL HOST Y AUTO-REPARACIÓN (RESILIENCIA)
  // ---------------------------------------------------------

  startHostPolling() {
    this.isPolling = true;
    this.pollLoop();
  },

  async pollLoop() {
    if (!this.isPolling) return;
    
    const res = await API.call('getSignals', { myPeerId: this.myId });
    if (res && res.signals && res.signals.length > 0) {
      for (let item of res.signals) {
        // Alguien nuevo tocó la puerta mediante GAS
        await this.handleWebRTCSignal(item.fromPeerId, item.signal);
        
        // Una vez conectado con el nuevo, el Host le presenta a los demás
        this.onNewPeerJoined(item.fromPeerId);
      }
    }
    // El host vigila la puerta cada 5 segundos. Nadie más hace esto.
    this.pollTimer = setTimeout(() => this.pollLoop(), 5000);
  },

  onNewPeerJoined(newPeerId) {
    // Sincroniza la lista global para todos
    this.broadcastToSwarm({ type: 'swarm_state', peersList: this.connectedPeersList });

    // Aquí decides la topología:
    // Si es un hablante (MESH): Dile a todos los hablantes actuales que se conecten con él.
    // Si es un oyente (TREE): Búscale un padre con menos de 3 hijos.
    
    const isSpeaker = true; // Lógica que viene de la UI

    if (isSpeaker) {
      for (let existingPeer of this.connectedPeersList) {
        if (existingPeer !== newPeerId && existingPeer !== this.myId) {
          // Le ordena por DataChannel interno al nuevo que se conecte al existente
          this.dataChannels[newPeerId].send(JSON.stringify({
            type: 'connect_to', targetId: existingPeer
          }));
        }
      }
    } else {
      // TODO: Asignar un nodo padre para la topología de árbol
    }
  },

  broadcastToSwarm(messageObj) {
    const msgStr = JSON.stringify(messageObj);
    Object.values(this.dataChannels).forEach(dc => {
      if (dc.readyState === 'open') dc.send(msgStr);
    });
  },

  // --- HOST HANDOVER (LA CORONA CAYÓ) ---
  handlePeerDrop(deadPeerId) {
    console.warn(`☠️ Conexión perdida con ${deadPeerId}`);
    if (this.peers[deadPeerId]) {
      this.peers[deadPeerId].close();
      delete this.peers[deadPeerId];
      delete this.dataChannels[deadPeerId];
    }
    
    // Lo sacamos de la lista
    this.connectedPeersList = this.connectedPeersList.filter(id => id !== deadPeerId);

    // ¿Era el Host quien murió?
    if (deadPeerId === this.hostId) {
      console.error("🚨 EL HOST HA CAÍDO. INICIANDO PROTOCOLO DE HERENCIA.");
      this.electNewHost();
    }
  },

  electNewHost() {
    // Como todos tienen la misma lista ordenada (`connectedPeersList`), 
    // todos llegarán a la misma conclusión sin tener que hablar con un servidor.
    const newHostId = this.connectedPeersList[0]; 
    
    this.hostId = newHostId;
    console.log(`👑 El nuevo Host indiscutible es: ${newHostId}`);

    if (this.myId === newHostId) {
      this.myRole = 'host';
      console.log("¡Yo soy el nuevo Host! Tomando control de la puerta principal.");
      // Actualizamos GAS para que las nuevas personas nos busquen a nosotros
      API.call('updateHost', { roomId: this.roomId, newHostId: this.myId });
      this.startHostPolling();
    }
  },

  // ---------------------------------------------------------
  // 5. CASCADA DE AUDIO (TREE TOPOLOGY)
  // ---------------------------------------------------------
  forwardStreamToChildren(stream) {
    // Si somos un nodo intermedio, agarramos el stream del Host 
    // y lo inyectamos en la conexión de nuestros "hijos" oyentes.
    const myChildren = []; // Array de IDs asignados a mí por el Host
    
    myChildren.forEach(childId => {
      if (this.peers[childId]) {
        stream.getTracks().forEach(track => {
           this.peers[childId].addTrack(track, stream);
        });
      }
    });
  }
};
    
