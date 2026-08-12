/**
 * P2P SWARM ENGINE + DATA CHANNELS CHAT
 */
const SwarmEngine = {
  myId: null,
  myRole: 'listener',
  hostId: null,
  roomId: null,
  peers: {},
  dataChannels: {},
  localStream: null,
  isPolling: false,
  pollTimer: null,
  connectedPeersList: [],
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },

  async init(myUserId, stream = null) {
    this.myId = myUserId;
    this.localStream = stream;
  },

  async joinRoom(roomId, initialHostId) {
    this.roomId = roomId;
    this.hostId = initialHostId;

    if (this.myId === this.hostId) {
      this.myRole = 'host';
      this.connectedPeersList = [this.myId];
      this.startHostPolling();
    } else {
      await this.createPeerConnection(this.hostId, true, 'gas');
    }
  },

  async createPeerConnection(peerId, isInitiator, signalingRoute = 'in-band') {
    const pc = new RTCPeerConnection(this.config);
    this.peers[peerId] = pc;
    
    if (!this.connectedPeersList.includes(peerId)) {
      this.connectedPeersList.push(peerId);
      this.connectedPeersList.sort();
    }

    if (isInitiator) {
      const dc = pc.createDataChannel("swarm-chat");
      this.setupDataChannel(peerId, dc);
    } else {
      pc.ondatachannel = (e) => this.setupDataChannel(peerId, e.channel);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.routeSignal(peerId, { type: 'ice', candidate: e.candidate }, signalingRoute);
    };

    pc.ontrack = (e) => App.playAudio(peerId, e.streams[0]);

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this.handlePeerDrop(peerId);
      }
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    }

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.routeSignal(peerId, { type: 'offer', sdp: pc.localDescription }, signalingRoute);
    }
    return pc;
  },

  setupDataChannel(peerId, dc) {
    this.dataChannels[peerId] = dc;
    dc.onopen = () => App.notify(`Conectado P2P con ${peerId}`);
    
    dc.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (['offer', 'answer', 'ice'].includes(msg.type)) {
        await this.handleWebRTCSignal(peerId, msg);
      } else if (msg.type === 'connect_to') {
        this.createPeerConnection(msg.targetId, true, 'in-band');
      } else if (msg.type === 'chat_text') {
        App.appendChatMessage(peerId, msg.text);
      } else if (msg.type === 'chat_file') {
        App.appendChatMessage(peerId, msg.fileName, msg.fileType, msg.fileData);
      }
    };
  },

  broadcastData(payload) {
    const str = JSON.stringify(payload);
    Object.values(this.dataChannels).forEach(dc => {
      if (dc && dc.readyState === 'open') dc.send(str);
    });
  },

  routeSignal(toPeerId, signalData, route) {
    if (route === 'gas') {
      API.call('sendSignal', { roomId: this.roomId, fromPeerId: this.myId, toPeerId: toPeerId, signal: signalData });
    } else if (this.dataChannels[toPeerId] && this.dataChannels[toPeerId].readyState === 'open') {
      this.dataChannels[toPeerId].send(JSON.stringify(signalData));
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
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'ice') {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  },

  startHostPolling() {
    this.isPolling = true;
    this.pollLoop();
  },

  async pollLoop() {
    if (!this.isPolling) return;
    const res = await API.call('getSignals', { roomId: this.roomId, myPeerId: this.myId });
    if (res && res.signals && res.signals.length > 0) {
      for (let item of res.signals) {
        await this.handleWebRTCSignal(item.fromPeerId, item.signal);
      }
    }
    this.pollTimer = setTimeout(() => this.pollLoop(), 4000);
  },

  handlePeerDrop(deadPeerId) {
    if (this.peers[deadPeerId]) {
      this.peers[deadPeerId].close();
      delete this.peers[deadPeerId];
      delete this.dataChannels[deadPeerId];
    }
    this.connectedPeersList = this.connectedPeersList.filter(id => id !== deadPeerId);
  },

  stop() {
    this.isPolling = false;
    clearTimeout(this.pollTimer);
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};
    this.dataChannels = {};
  }
};
