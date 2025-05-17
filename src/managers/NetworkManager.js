import { identify } from '@libp2p/identify';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { stringToUint8Array, uint8ArrayToString } from '../utils/index.js'; // Ajuste o caminho conforme necessário

const DB_DISCOVERY_TOPIC = '/social-app/db-discovery/1.0.0';

async function publishWithTimeout(publishCall, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`NET_MAN_TIMEOUT: Publicação excedeu o tempo limite de ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = await publishCall();
      clearTimeout(timeoutId);
      resolve(result);
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

export class NetworkManager {
  constructor(wsPort, initialBootstrapMultiaddrs, datastore) {
    this.wsPort = wsPort;
    this.bootstrapMultiaddrs = [...initialBootstrapMultiaddrs]; // Clonar para evitar modificação externa
    this.datastore = datastore; // Datastore do IdentityManager
    this.libp2pNode = null; // Será a instância libp2p do Helia
    this.dbAnnounceListener = null; // Para o handler de descoberta de DB
    this.consultorReadyListener = null; // Para o handler de "consultor pronto"
  }

  addBootstrapPeer(peerAddress) {
    if (peerAddress && !this.bootstrapMultiaddrs.includes(peerAddress)) {
      this.bootstrapMultiaddrs.push(peerAddress);
      console.log(`NET_MAN: Peer de bootstrap customizado adicionado: ${peerAddress}`);
    }
  }

  getLibp2pOptions() {
    console.log("NET_MAN: Preparando opções Libp2p...");
    return {
      datastore: this.datastore,
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${this.wsPort}/ws`
        ]
      },
      transports: [
        webSockets()
      ],
      connectionEncryption: [
        noise()
      ],
      streamMuxers: [
        yamux()
      ],
      peerDiscovery: [
        bootstrap({
          list: this.bootstrapMultiaddrs,
          timeout: 2000, // Aumentado um pouco
        })
      ],
      services: {
        identify: identify(),
        kadDHT: kadDHT({
          protocolPrefix: '/social-app/kad/1.0.0',
          clientMode: false, 
        }),
        pubsub: gossipsub({ allowPublishToZeroPeers: true, canRelayMessage: true }),
        ping: ping({ protocolPrefix: 'social-app-ping' })
      }
    };
  }

  setLibp2pNode(libp2pInstance) {
    this.libp2pNode = libp2pInstance;
    console.log(`NET_MAN: Nó Libp2p configurado no NetworkManager. Peer ID: ${this.libp2pNode.peerId.toString()}`);
    this.libp2pNode.getMultiaddrs().forEach((addr) => console.log(`NET_MAN: Escutando em: ${addr.toString()}`));
  }

  getLibp2pNode() {
    if (!this.libp2pNode) {
      throw new Error("NET_MAN: Nó Libp2p não configurado. Chame setLibp2pNode() primeiro.");
    }
    return this.libp2pNode;
  }

  async dial(peerAddress) {
    if (!this.libp2pNode) throw new Error("NET_MAN: Libp2p não inicializado para dial.");
    try {
      const targetMultiaddr = multiaddr(peerAddress);
      console.log(`NET_MAN: Tentando conectar (dial) com ${targetMultiaddr.toString()}`);
      await this.libp2pNode.dial(targetMultiaddr);
      console.log(`NET_MAN: Conectado com sucesso a ${targetMultiaddr.toString()}`);
    } catch (error) {
      console.error(`NET_MAN: Falha ao conectar (dial) com ${peerAddress}:`, error.message); // Log menos verboso
    }
  }

  async subscribeToDbDiscoveryTopic(handlerFunction) {
    if (!this.libp2pNode) throw new Error("NET_MAN: Libp2p não inicializado para inscrever em tópico.");
    await this.libp2pNode.services.pubsub.subscribe(DB_DISCOVERY_TOPIC);
    console.log(`NET_MAN: Inscrito no tópico de descoberta: ${DB_DISCOVERY_TOPIC}`);
    if (this.dbAnnounceListener) {
        this.libp2pNode.services.pubsub.removeEventListener('message', this.dbAnnounceListener);
    }
    this.dbAnnounceListener = handlerFunction; 
    this.libp2pNode.services.pubsub.addEventListener('message', this.dbAnnounceListener);
  }

  async publishConsultorReady(targetPeerId) {
    if (!this.libp2pNode) {
      console.error("NET_MAN_ERROR: (Consultor) Libp2p não inicializado para publicar consultorReady.");
      return false; 
    }
    const message = { type: 'consultorReadyForDbDiscovery', peerId: this.libp2pNode.peerId.toString() };
    let rawMessage;
    try {
      rawMessage = stringToUint8Array(JSON.stringify(message));
    } catch(e) {
      console.error("NET_MAN_FATAL_SERIALIZATION: Falha ao serializar mensagem para publishConsultorReady", e);
      return false; 
    }

    try {
      const result = await this.libp2pNode.services.pubsub.publish(DB_DISCOVERY_TOPIC, rawMessage);
      
      if (result && typeof result.recipients !== 'undefined') {
        console.log(`NET_MAN: (Consultor) Publicado 'consultorReadyForDbDiscovery' para ${DB_DISCOVERY_TOPIC}. Destinatários: ${result.recipients.length}`);
        if (result.recipients.length === 0) {
            console.warn("NET_MAN: (Consultor) Ninguém recebeu a mensagem consultorReadyForDbDiscovery.");
            return false; // Modificado para retornar false
        }
        return true; // Sucesso se houver destinatários
      } else {
        console.warn("NET_MAN_WARN: Resultado da publicação de consultorReadyForDbDiscovery é inválido ou não possui recipients. Result:", result);
        return false;
      }
    } catch (error) {
        console.error("NET_MAN_ERROR: (Consultor) ERRO no CATCH de publishConsultorReady:", error.message);
        if (error.stack) console.error("NET_MAN_ERROR: (Consultor) Stack:", error.stack);
        try {
            console.error("NET_MAN_ERROR: (Consultor) Erro Obj (JSON):", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        } catch (e_json) {
            console.error("NET_MAN_ERROR: (Consultor) Falha ao serializar erro para JSON:", e_json.message);
            console.error("NET_MAN_ERROR: (Consultor) Erro (toString):", error.toString());
        }
        return false;
    }
  }

  async listenForConsultorReady(handlerFunction) {
    if (!this.libp2pNode) throw new Error("NET_MAN: Libp2p não inicializado para escutar.");
    await this.libp2pNode.services.pubsub.subscribe(DB_DISCOVERY_TOPIC);
    console.log(`NET_MAN: (Publicador) Escutando por 'consultorReadyForDbDiscovery' em ${DB_DISCOVERY_TOPIC}`);
    if (this.consultorReadyListener) {
        this.libp2pNode.services.pubsub.removeEventListener('message', this.consultorReadyListener);
    }
    this.consultorReadyListener = handlerFunction; 
    this.libp2pNode.services.pubsub.addEventListener('message', this.consultorReadyListener);
  }

  async publishDbAnnounce(dbAddress, targetPeerIdString) {
    if (!this.libp2pNode) throw new Error("NET_MAN: Libp2p não inicializado para anunciar DB.");
    const message = {
      type: 'dbAnnounce',
      dbAddress: dbAddress,
      peerId: this.libp2pNode.peerId.toString()
    };
    console.log(`NET_MAN: (Publicador) Tentando anunciar DB ${dbAddress} para o peer ${targetPeerIdString ? targetPeerIdString.slice(-6): 'todos os inscritos'}`);
    try {
        const result = await this.libp2pNode.services.pubsub.publish(DB_DISCOVERY_TOPIC, stringToUint8Array(JSON.stringify(message)));
        console.log(`NET_MAN: (Publicador) Anúncio de DB publicado. Destinatários: ${result.recipients.length}`);
        if (result.recipients.length === 0) {
            console.warn("NET_MAN: (Publicador) Ninguém recebeu o anúncio de DB. O consultor pode não estar escutando, conectado ou ter se desconectado.");
            return false;
        }
        return true;
    } catch (error) {
        console.error("NET_MAN: (Publicador) Erro ao publicar anúncio de DB:", error);
        return false;
    }
  }

  async close() {
    console.log("NET_MAN: Limpando NetworkManager...");
    if (this.libp2pNode && this.dbAnnounceListener) {
        this.libp2pNode.services.pubsub.removeEventListener('message', this.dbAnnounceListener);
        this.dbAnnounceListener = null;
    }
    if (this.libp2pNode && this.consultorReadyListener) {
        this.libp2pNode.services.pubsub.removeEventListener('message', this.consultorReadyListener);
        this.consultorReadyListener = null;
    }
    if (this.libp2pNode) {
        try {
            await this.libp2pNode.services.pubsub.unsubscribe(DB_DISCOVERY_TOPIC);
            console.log("NET_MAN: Desinscrito do tópico de descoberta.");
        } catch (error) {
            console.error("NET_MAN: Erro ao desinscrever do tópico de descoberta:", error);
        }
    }
    // A parada do libp2pNode em si será gerenciada pelo StorageManager (via Helia) ou pelo src/index.js
    console.log("NET_MAN: NetworkManager limpo.");
  }
} 