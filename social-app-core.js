import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from '@libp2p/bootstrap'
import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { ping } from '@libp2p/ping'
import { ProfileService } from './profile-service.js'
import { createHelia } from 'helia'
import { createOrbitDB } from '@orbitdb/core'
import path from 'path'
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id'
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import fs from 'fs/promises'
import { FsDatastore } from 'datastore-fs'

const DB_DISCOVERY_TOPIC = '/social-app/db-discovery/1.0.0'; // Tópico para anunciar endereços de DB

// Configuração via variáveis de ambiente
const dataDir = process.env.DATA_DIR || './.helia-orbitdb-data'; // Diretório de dados para Helia e OrbitDB
const wsPort = parseInt(process.env.WS_PORT) || 0; // Porta para WebSocket, 0 para aleatória
const bootstrapPeer = process.env.BOOTSTRAP_PEER; // Multiaddr de um peer para bootstrap inicial
const queryTargetPeerId = process.env.QUERY_TARGET_PEER_ID; // Peer ID para buscar o perfil, se definido

// Endereços de bootstrap conhecidos
const baseBootstrapMultiaddrs = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
];

if (bootstrapPeer) {
  baseBootstrapMultiaddrs.push(bootstrapPeer);
  console.log(`CORE: Adicionando peer de bootstrap customizado: ${bootstrapPeer}`);
}

let heliaNode;
let orbitDB;
let profileService;
let libp2p;
let appStopped = false;
let pubSubIntervalId;
let waitingIntervalId = null; // ADICIONADO para o novo interval

// Função para GARANTIR QUE O DIRETÓRIO DE DADOS EXISTA (PeerId será gerenciado pelo libp2p via datastore)
async function ensureDataDirExists(dataDirForKeys) {
  // Esta função agora apenas garante que o diretório principal exista.
  // A persistência do PeerId será tratada pelo libp2p ao fornecer um datastore persistente.
  try {
    await fs.mkdir(dataDirForKeys, { recursive: true });
    // console.log(`CORE: Diretório de dados verificado/criado: ${dataDirForKeys}`);
  } catch (error) {
    console.error(`CORE: Falha ao criar diretório de dados ${dataDirForKeys}:`, error);
    throw error;
  }
  // A lógica de carregar/salvar peer.key foi removida.
}

// Definição da função stopApp no escopo do módulo
async function stopApp() {
  if (!appStopped) {
    appStopped = true;
    console.log('\nCORE: Parando a aplicação...');
    if (pubSubIntervalId) {
        clearInterval(pubSubIntervalId);
        pubSubIntervalId = null;
    }
    if (waitingIntervalId) { // Limpar o interval de espera
        clearInterval(waitingIntervalId);
        waitingIntervalId = null;
    }

    if (profileService) {
      console.log("CORE: Fechando ProfileService...");
      try { 
        await profileService.close(); 
        console.log("CORE: ProfileService fechado."); 
      } catch (e) { 
        console.error("CORE: Erro ao fechar ProfileService", e);
      }
    }
    if (orbitDB) {
      console.log("CORE: Parando OrbitDB...");
      try { 
        await orbitDB.stop(); 
        console.log("CORE: OrbitDB parado."); 
      } catch (e) { 
        console.error("CORE: Erro ao parar OrbitDB", e);
      }
    }
    if (heliaNode) {
      console.log("CORE: Parando Helia...");
      try { 
        await heliaNode.stop(); 
        console.log("CORE: Helia (e Libp2p) parado."); 
      } catch (e) { 
        console.error("CORE: Erro ao parar Helia", e);
      }
    }
    console.log('CORE: Aplicação efetivamente parada.');
  } else {
    console.log("CORE: stopApp já foi chamada anteriormente.");
  }
}

async function main() {
  let mainTimeoutId;
  const mainTimeoutInSeconds = queryTargetPeerId ? 120 : 90; // Publicador para 90s, Consultor continua com 120s para seu timeout de descoberta de DB

  // Manipulador para Ctrl+C e outros sinais de término
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach(signal => {
    process.on(signal, async () => {
      console.log(`\nCORE: Recebido ${signal}.`);
      await stopApp();
      if (mainTimeoutId) clearTimeout(mainTimeoutId);
      // Adicionar um log antes de sair em caso de sinal, para ter certeza que é o manipulador de sinal.
      console.log(`CORE: Encerrando processo devido ao sinal ${signal}.`);
      process.exit(0);
    });
  });

  try {
    console.log(`CORE: Iniciando main() para ${queryTargetPeerId ? 'Nó Consultor' : 'Nó Publicador'}`); // Log Adicionado
    console.log(`CORE: Usando diretório de dados: ${path.resolve(dataDir)}`);
    console.log(`CORE: Usando porta WS: ${wsPort === 0 ? 'Aleatória' : wsPort}`);

    // Garantir que o diretório de dados principal exista
    await ensureDataDirExists(dataDir); 

    // Configurar o datastore persistente para o libp2p
    const datastorePath = path.join(dataDir, 'datastore');
    await fs.mkdir(datastorePath, { recursive: true }); // Garantir que o subdiretório do datastore exista
    const libp2pDatastore = new FsDatastore(datastorePath);
    // await libp2pDatastore.open(); // FsDatastore abre automaticamente no primeiro uso ou pode ser aberto explicitamente se necessário antes

    // REMOVIDA a chamada a getOrCreatePeerId para obter o peerId explicitamente
    // const peerId = await getOrCreatePeerId(dataDir); 

    if (bootstrapPeer) {
      console.log(`CORE: Adicionando peer de bootstrap customizado: ${bootstrapPeer}`);
      // A lógica para adicionar ao array baseBootstrapMultiaddrs já está no topo do arquivo.
    }
    console.log("CORE: Preparando opções Libp2p..."); // Log Adicionado
    const libp2pOptions = {
      // REMOVIDO: peerId: peerId, // Libp2p irá gerar/carregar a partir do datastore
      datastore: libp2pDatastore, // ADICIONADO: Datastore para persistência do PeerId e outras informações do libp2p
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${wsPort}/ws`
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
          list: baseBootstrapMultiaddrs, // Usa a lista que pode ter sido modificada
          timeout: 1000, // opcional, em milissegundos, quanto tempo esperar por um peer de bootstrap
        })
      ],
      services: {
        identify: identify(),
        kadDHT: kadDHT({
          protocolPrefix: '/social-app/kad/1.0.0',
          clientMode: false, // Importante para permitir que outros o descubram e para persistir dados
        }),
        pubsub: gossipsub({ allowPublishToZeroPeers: true, canRelayMessage: true }),
        ping: ping({ protocolPrefix: 'social-app-ping' })
      }
    };

    console.log("CORE: Opções Libp2p preparadas. Tentando criar nó Helia..."); // Log Adicionado
    heliaNode = await createHelia({
      libp2p: libp2pOptions,
      datastore: libp2pDatastore // Passar também para o Helia, caso ele use para algo mais ou para consistência
    });
    console.log("CORE: Nó Helia criado com sucesso."); // Log Adicionado
    libp2p = heliaNode.libp2p;

    console.log(`CORE: Nó Helia (e Libp2p) iniciado com Peer ID: ${libp2p.peerId.toString()}`);
    console.log("CORE: Escutando em:");
    libp2p.getMultiaddrs().forEach((addr) => console.log(addr.toString()));

    console.log("CORE: Criando instância OrbitDB...");
    orbitDB = await createOrbitDB({ 
      ipfs: heliaNode, 
      directory: path.join(dataDir, 'orbitdb') 
    });
    console.log(`CORE: Instância OrbitDB criada. Diretório: ${orbitDB.directory}`);

    if (!queryTargetPeerId) {
      // Lógica do Nó Publicador (incluindo anúncio de DB)
      console.log("CORE: Instanciando ProfileService para o Nó Publicador...");
      profileService = new ProfileService(libp2p, orbitDB);
      await profileService.init();
      console.log("CORE: ProfileService (Publicador) inicializado.");

      console.log("CORE: (Nó publicador) Publicando perfil inicial...");
      const ownPeerIdStr = libp2p.peerId.toString();
      const profileData = {
        name: `User-${ownPeerIdStr.slice(-6)}`,
        avatarUrl: `https://example.com/avatar/${ownPeerIdStr.slice(-6)}.png`,
        timestamp: new Date().toISOString(),
        nodePeerId: ownPeerIdStr
      };
      await profileService.publishProfile(ownPeerIdStr, profileData);
      console.log("CORE: (Nó publicador) Perfil inicial publicado.");

      // PRIMEIRA ATUALIZAÇÃO DE PERFIL
      setTimeout(async () => {
        if (appStopped || !profileService) return; 
        console.log("\nCORE: (Nó publicador) === 1ª ATUALIZAÇÃO DE PERFIL APÓS DELAY ===");
        const updatedProfileData1 = {
          name: `User-${ownPeerIdStr.slice(-6)} (Updated)`, 
          avatarUrl: `https://example.com/avatar/${ownPeerIdStr.slice(-6)}.png`, 
          status: "Online and updated!", 
          timestamp: new Date().toISOString(), 
          nodePeerId: ownPeerIdStr
        };
        try {
          await profileService.publishProfile(ownPeerIdStr, updatedProfileData1);
          console.log("CORE: (Nó publicador) Perfil 1ª ATUALIZAÇÃO publicado.");
        } catch (error) {
          console.error("CORE: (Nó publicador) Erro na 1ª ATUALIZAÇÃO de perfil:", error);
        }
        console.log("CORE: (Nó publicador) === FIM DA 1ª ATUALIZAÇÃO DE PERFIL ===\n");
      }, 20000); // Atualiza após 20 segundos

      // SEGUNDA ATUALIZAÇÃO DE PERFIL
      setTimeout(async () => {
        if (appStopped || !profileService) return;
        console.log("\nCORE: (Nó publicador) === 2ª ATUALIZAÇÃO DE PERFIL APÓS DELAY ===");
        const updatedProfileData2 = {
          name: `User-${ownPeerIdStr.slice(-6)} (Updated Twice)`, // Nome diferente
          avatarUrl: `https://example.com/avatar/${ownPeerIdStr.slice(-6)}.png`,
          status: "Online and SUPER updated!", // Status diferente
          timestamp: new Date().toISOString(),
          nodePeerId: ownPeerIdStr
        };
        try {
          await profileService.publishProfile(ownPeerIdStr, updatedProfileData2);
          console.log("CORE: (Nó publicador) Perfil 2ª ATUALIZAÇÃO publicado.");
        } catch (error) {
          console.error("CORE: (Nó publicador) Erro na 2ª ATUALIZAÇÃO de perfil:", error);
        }
        console.log("CORE: (Nó publicador) === FIM DA 2ª ATUALIZAÇÃO DE PERFIL ===\n");
      }, 45000); // Atualiza após 45 segundos

      // Lógica de anúncio do DB movida para ser acionada por 'consultorReadyForDbDiscovery'
      if (profileService.profileDB && profileService.profileDB.address) {
        await libp2p.services.pubsub.subscribe(DB_DISCOVERY_TOPIC);
        console.log(`CORE: (Nó publicador) Inscrito no ${DB_DISCOVERY_TOPIC}. Aguardando mensagem 'consultorReadyForDbDiscovery'...`);

        const dbAnnounceMessageStr = JSON.stringify({
          type: 'dbAnnounce',
          peerId: ownPeerIdStr,
          dbName: 'user-profiles',
          dbAddress: profileService.profileDB.address.toString()
        });

        let anuncieiMeuDb = false; // Flag para garantir que anunciamos apenas uma vez por consultor interessado (ou de forma geral)

        const listenerConsultorReady = async (event) => {
          if (event.detail.topic === DB_DISCOVERY_TOPIC && !anuncieiMeuDb) {
            try {
              const messageStr = uint8ArrayToString(event.detail.data);
              const message = JSON.parse(messageStr);
              console.log(`CORE: (Nó publicador) Mensagem recebida no ${DB_DISCOVERY_TOPIC}:`, message);

              if (message.type === 'consultorReadyForDbDiscovery') {
                // Opcional: verificar se message.peerId é um peer conectado ou esperado
                console.log(`CORE: (Nó publicador) Recebido 'consultorReadyForDbDiscovery' de ${message.peerId}. Preparando para anunciar DB.`);
                
                // Lógica de múltiplas tentativas para anunciar o DB
                const MAX_ANNOUNCE_ATTEMPTS = 3;
                let announceAttempts = 0;
                const ANNOUNCE_RETRY_DELAY_MS = 3000; // 3 segundos entre tentativas
                const INITIAL_ANNOUNCE_DELAY_MS = 1000; // 1 segundo de delay inicial para o primeiro anúncio
                let announcedSuccessfully = false;

                const attemptAnnounce = async () => {
                  if (announcedSuccessfully || announceAttempts >= MAX_ANNOUNCE_ATTEMPTS) return;
                  announceAttempts++;
                  console.log(`CORE: (Nó publicador) Tentativa ${announceAttempts}/${MAX_ANNOUNCE_ATTEMPTS} de anunciar endereço do DB para ${message.peerId}...`);
                  try {
                    await libp2p.services.pubsub.publish(DB_DISCOVERY_TOPIC, uint8ArrayFromString(dbAnnounceMessageStr));
                    console.log(`CORE: (Nó publicador) Endereço do DB anunciado no tópico ${DB_DISCOVERY_TOPIC} (em resposta a ${message.peerId}): ${profileService.profileDB.address.toString()}`);
                    announcedSuccessfully = true;
                    anuncieiMeuDb = true; // Marcar que anunciamos
                    //  libp2p.services.pubsub.removeEventListener('message', listenerConsultorReady); // Opcional: parar de escutar após sucesso
                  } catch (err) {
                    console.warn(`CORE: (Nó publicador) Falha na tentativa ${announceAttempts} de anunciar endereço do DB:`, err.message);
                    if (announceAttempts < MAX_ANNOUNCE_ATTEMPTS) {
                      setTimeout(attemptAnnounce, ANNOUNCE_RETRY_DELAY_MS);
                    } else {
                      console.error(`CORE: (Nó publicador) Todas as ${MAX_ANNOUNCE_ATTEMPTS} tentativas de anunciar o DB falharam.`);
                    }
                  }
                };
                setTimeout(attemptAnnounce, INITIAL_ANNOUNCE_DELAY_MS); // Pequeno delay antes da primeira tentativa de resposta
              }
            } catch (err) {
              console.error(`CORE: (Nó publicador) Erro ao processar mensagem no ${DB_DISCOVERY_TOPIC}:`, err);
            }
          }
        };
        libp2p.services.pubsub.addEventListener('message', listenerConsultorReady);

      } else {
        console.warn("CORE: (Nó publicador) Não foi possível configurar o anúncio do endereço do DB pois profileService.profileDB.address não está disponível.");
      }
      
      // Lógica do timeout para o publicador buscar seu próprio perfil e parar
      mainTimeoutId = setTimeout(async () => {
        const ownPeerId = libp2p.peerId.toString();
        console.log(`\n--- CORE: (Publicador) Iniciando Teste de Busca de Perfil (próprio perfil após ${mainTimeoutInSeconds}s) ---`);
        try {
          const profile = await profileService.getProfile(ownPeerId);
          if (profile) {
            console.log(`CORE: (Publicador) Perfil (próprio) encontrado:`, profile);
          } else {
            console.log(`CORE: (Publicador) Perfil (próprio) NÃO encontrado para ${ownPeerId}.`);
          }
        } catch (err) {
          console.error(`CORE: (Publicador) Erro ao buscar próprio perfil ${ownPeerId}:`, err);
        }
        console.log("--- CORE: (Publicador) Teste de Busca Concluído ---");
        await stopApp();
      }, mainTimeoutInSeconds * 1000);

    } else {
      // Lógica do Nó Consultor
      console.log(`CORE: (Nó consultor) Configurado para buscar perfil de: ${queryTargetPeerId}`);
      let discoveryTimeoutId = null;

      try {
        const targetPeerIdObj = peerIdFromString(queryTargetPeerId);
        console.log(`CORE: (Nó consultor) Tentando encontrar peer ${queryTargetPeerId} via DHT...`);
        
        // Tentar encontrar o peer via DHT
        // Aumentar o timeout para findPeer, pois pode demorar em redes maiores ou com peers distantes
        const findPeerAbortController = new AbortController();
        const findPeerTimeout = setTimeout(() => findPeerAbortController.abort(), 30000); // 30 segundos de timeout

        let peerInfo;
        try {
          peerInfo = await libp2p.peerRouting.findPeer(targetPeerIdObj, { signal: findPeerAbortController.signal });
        } finally {
          clearTimeout(findPeerTimeout);
        }

        if (peerInfo && peerInfo.multiaddrs.length > 0) {
          console.log(`CORE: (Nó consultor) Peer ${queryTargetPeerId} encontrado via DHT. Endereços:`, peerInfo.multiaddrs.map(m => m.toString()));
          // Tentar discar para os endereços encontrados
          // O dial pode ser demorado, adicionar um timeout razoável
          const dialAbortController = new AbortController();
          const dialTimeout = setTimeout(() => dialAbortController.abort(), 20000); // 20 segundos de timeout para o dial

          try {
            await libp2p.dial(peerInfo.multiaddrs, { signal: dialAbortController.signal });
            console.log(`CORE: (Nó consultor) Tentativa de dial para ${queryTargetPeerId} (encontrado via DHT) concluída.`);
          } catch (dialError) {
            console.warn(`CORE: (Nó consultor) Falha ao discar para ${queryTargetPeerId} (encontrado via DHT):`, dialError.message);
          } finally {
            clearTimeout(dialTimeout);
          }
        } else {
          console.log(`CORE: (Nó consultor) Peer ${queryTargetPeerId} não encontrado via DHT nos endereços conhecidos inicialmente. Tentará bootstrap.`);
        }
      } catch (err) {
        console.warn(`CORE: (Nó consultor) Erro ao tentar encontrar/conectar ao peer ${queryTargetPeerId} via DHT: ${err.message}. Prosseguindo...`);
      }

      // Tentar dial explícito para o bootstrap peer (se fornecido), como fallback ou para garantir conexão à rede
      if (bootstrapPeer) {
        console.log(`CORE: (Nó consultor) Tentando dial explícito para bootstrap peer: ${bootstrapPeer}`);
        try {
          const bootstrapMultiaddr = multiaddr(bootstrapPeer);
          await libp2p.dial(bootstrapMultiaddr);
          console.log(`CORE: Dial explícito para ${bootstrapPeer} bem-sucedido ou já conectado.`);
        } catch (e) {
          console.warn(`CORE: Falha ao conectar ao bootstrap peer ${bootstrapPeer}:`, e.message);
        }
      }
      
      await libp2p.services.pubsub.subscribe(DB_DISCOVERY_TOPIC);
      console.log(`CORE: (Nó consultor) Inscrito no tópico de descoberta: ${DB_DISCOVERY_TOPIC}`);

      // Adicionar listener para mensagens de anúncio de DB ANTES de publicar que está pronto
      let dbAnnounceListenerAdded = false; // Flag para evitar adicionar múltiplos listeners
      let targetDbAddress = null; // Variável para armazenar o endereço do DB do publicador
      let targetPublisherPeerId = null; // Variável para armazenar o PeerId do publicador
      let dbDiscoveryTimeoutId = null; // Timeout para a descoberta do DB via anúncio

      // Define o listener para o anúncio de DB
      const dbAnnounceListener = async (event) => {
        if (event.detail.topic === DB_DISCOVERY_TOPIC) {
          try {
            const messageStr = uint8ArrayToString(event.detail.data);
            const message = JSON.parse(messageStr);
            console.log(`CORE: (Nó consultor) Mensagem recebida no ${DB_DISCOVERY_TOPIC}:`, message);

            if (message.type === 'dbAnnounce' && message.dbAddress && message.peerId) {
              console.log(`CORE: (Nó consultor) Recebido anúncio de DB do Peer ${message.peerId.slice(-6)}: ${message.dbAddress}`);
              
              // Se já tivermos um targetDbAddress, significa que já processamos um anúncio.
              if (targetDbAddress) {
                  console.log(`CORE: (Nó consultor) Anúncio de DB de ${message.peerId.slice(-6)} ignorado, pois um DB já foi processado (${targetDbAddress}).`);
                  return;
              }

              // Verificar se o anúncio é do peer que estamos procurando (se queryTargetPeerId foi especificado)
              if (queryTargetPeerId && message.peerId !== queryTargetPeerId) {
                console.log(`CORE: (Nó consultor) Anúncio de DB de ${message.peerId.slice(-6)} ignorado, esperando por ${queryTargetPeerId.slice(-6)}.`);
                return; // Ignorar se não for do peer alvo
              }

              targetDbAddress = message.dbAddress; // Salvar o endereço do DB anunciado
              targetPublisherPeerId = message.peerId; // Salvar o PeerID do publicador
              console.log(`CORE: (Nó consultor) Endereço do DB do publicador (${targetPublisherPeerId.slice(-6)}) definido para: ${targetDbAddress}`);

              // Limpar o timeout de descoberta de DB, já que encontramos um anúncio
              if (dbDiscoveryTimeoutId) {
                clearTimeout(dbDiscoveryTimeoutId);
                dbDiscoveryTimeoutId = null;
                console.log("CORE: (Nó consultor) Timeout de descoberta de DB cancelado pois o DB foi anunciado.");
              }

              // Agora que temos o endereço do DB, instanciar ProfileService e tentar buscar
              try {
                console.log("CORE: (Nó consultor) Instanciando ProfileService para o DB anunciado...");
                
                // Definir o callback para atualizações de perfil
                const handleProfileUpdate = (updatedKey, updatedValue) => {
                  console.log(`\nCORE: (Nó consultor) === PERFIL ATUALIZADO RECEBIDO ===`);
                  console.log(`CORE: (Nó consultor) Chave do perfil atualizado: ${updatedKey}`);
                  // Usar targetPublisherPeerId para verificar se a atualização é do peer que anunciou o DB
                  if (targetPublisherPeerId && updatedKey === targetPublisherPeerId) {
                    console.log(`CORE: (Nó consultor) O perfil de ${targetPublisherPeerId.slice(-6)} foi ATUALIZADO:`, updatedValue);
                  } else {
                    // Logar mesmo se não for o queryTargetPeerId inicial, mas veio do DB anunciado
                    console.log(`CORE: (Nó consultor) Atualização de perfil para ${updatedKey.slice(-6)} (do DB de ${targetPublisherPeerId.slice(-6)}) recebida:`, updatedValue);
                  }
                };

                profileService = new ProfileService(libp2p, orbitDB, null, handleProfileUpdate); // Passa o callback

                console.log(`CORE: (Nó consultor) Tentando abrir DB: ${targetDbAddress}`);
                await profileService.openProfileDB(targetDbAddress); // Usar targetDbAddress
                console.log(`CORE: (Nó consultor) DB ${targetDbAddress} aberto (ou tentativa).`);

                // Tentar buscar o perfil do targetPublisherPeerId (que é o peer que anunciou o DB)
                const profile = await profileService.getProfile(targetPublisherPeerId);
                if (profile) {
                  console.log(`CORE: (Nó consultor) Perfil de ${targetPublisherPeerId.slice(-6)} encontrado APÓS anúncio:`, profile);
                } else {
                  console.log(`CORE: (Nó consultor) Perfil de ${targetPublisherPeerId.slice(-6)} NÃO encontrado após anúncio.`);
                }

                // REMOVIDO: O setTimeout que parava a aplicação após 5 segundos.
                // O Nó Consultor agora permanecerá ativo para escutar atualizações.
                // O mainTimeoutId (120s) ou o script test-p2p.ps1 (75s) eventualmente o encerrarão.
                // console.log("CORE: (Nó consultor) Encerrando em 5 segundos após a busca inicial...");
                // setTimeout(async () => {
                //   if (!appStopped) {
                //     console.log("CORE: (Nó consultor) Timeout de 5s atingido, encerrando.");
                //     await stopApp();
                //   }
                // }, 5000);

              } catch (e) {
                console.error("CORE: (Nó consultor) Erro ao instanciar ProfileService ou buscar perfil após anúncio:", e);
                // Considerar se deve parar ou tentar novamente. Se falhar aqui, pode ser fatal.
                // Resetar targetDbAddress para permitir que outra tentativa de anúncio (se houver) seja processada.
                targetDbAddress = null; 
                targetPublisherPeerId = null;
              }
              
              // Desinscrever do tópico de descoberta e remover o listener de mensagens
              // para não processar múltiplos anúncios acidentalmente
              // (Embora a lógica de targetDbAddress já definido deva prevenir a maioria dos problemas)
              if (dbAnnounceListenerAdded) {
                libp2p.services.pubsub.removeEventListener('message', dbAnnounceListener);
                console.log("CORE: (Nó consultor) Listener de mensagens de anúncio de DB removido.");
                dbAnnounceListenerAdded = false; // Resetar flag
              }
              // Verificar se ainda está inscrito antes de tentar desinscrever
              if (libp2p.services.pubsub.getSubscriptions().includes(DB_DISCOVERY_TOPIC)) {
                  try {
                      await libp2p.services.pubsub.unsubscribe(DB_DISCOVERY_TOPIC);
                      console.log(`CORE: (Nó consultor) Desinscrito do tópico ${DB_DISCOVERY_TOPIC} após receber e processar anúncio.`);
                  } catch (unsubError) {
                      console.error(`CORE: (Nó consultor) Erro ao tentar desinscrever do tópico ${DB_DISCOVERY_TOPIC}:`, unsubError);
                  }
              }
            }
          } catch (parseError) {
            console.error(`CORE: (Nó consultor) Erro ao processar mensagem no ${DB_DISCOVERY_TOPIC} (parse ou similar):`, parseError, "Dados recebidos:", event.detail.data);
          }
        }
      }; // Fim de dbAnnounceListener

      if (!dbAnnounceListenerAdded) {
        libp2p.services.pubsub.addEventListener('message', dbAnnounceListener);
        dbAnnounceListenerAdded = true;
      }

      const consultorReadyMessage = JSON.stringify({
        type: 'consultorReadyForDbDiscovery',
        peerId: libp2p.peerId.toString()
      });
      // Pequeno delay para garantir que a inscrição foi processada antes de publicar
      await new Promise(resolve => setTimeout(resolve, 2000)); // Aumentado para 2 segundos
      await libp2p.services.pubsub.publish(DB_DISCOVERY_TOPIC, uint8ArrayFromString(consultorReadyMessage));
      console.log(`CORE: (Nó consultor) Mensagem 'consultorReadyForDbDiscovery' publicada no ${DB_DISCOVERY_TOPIC}`);

      const DISCOVERY_TIMEOUT_SECONDS = mainTimeoutInSeconds; // Se queryTargetPeerId é true, mainTimeoutInSeconds é 120.
      discoveryTimeoutId = setTimeout(async () => {
        if (profileService) {
          // Se o profileService foi inicializado por algum motivo (não deveria acontecer se o timeout disparar)
          // mas é uma checagem de segurança.
          console.log("CORE: (Nó consultor) Timeout de descoberta atingido, mas ProfileService existe (DB provavelmente foi carregado). Não parando por este timeout.");
          return;
        }
        console.log(`CORE: (Nó consultor) Timeout de descoberta de DB (${DISCOVERY_TIMEOUT_SECONDS}s) atingido. Nenhum anúncio relevante recebido de ${queryTargetPeerId}.`);
        await stopApp();
      }, DISCOVERY_TIMEOUT_SECONDS * 1000);

    }

    // Lógica de PubSub para testar a comunicação
    const pubSubTopic = '/social-app/status/1.0.0';
    await libp2p.services.pubsub.subscribe(pubSubTopic);
    console.log(`Inscrito no tópico PubSub: ${pubSubTopic}`);
    libp2p.services.pubsub.addEventListener('message', (event) => {
      const topic = event.detail.topic;
      const message = uint8ArrayToString(event.detail.data);
      if (topic === pubSubTopic) {
        console.log(`PubSub - Mensagem recebida no tópico '${topic}': ${message}`);
      }
    });

    // Não precisamos mais do pubSubIntervalId no escopo do módulo se stopApp for chamado apenas uma vez.
    // O clearInterval será feito dentro de stopApp.
    pubSubIntervalId = setInterval(() => {
      const message = `Meu status atual às ${new Date().toLocaleTimeString()}`;
      libp2p.services.pubsub.publish(pubSubTopic, uint8ArrayFromString(message)).catch(err => {
        // console.error("Falha ao publicar no PubSub:", err); // Comentado para reduzir verbosidade
        if (err.message && err.message.includes("NoPeersSubscribedToTopic")) {
          // console.warn(`PubSub AVISO: Não há peers inscritos em ${pubSubTopic} para a mensagem de status.`);
        } else {
          console.error("Falha ao publicar no PubSub (erro inesperado):", err);
        }
      });
    }, 30000); // Publica a cada 30 segundos

    // Event listeners for libp2p
    libp2p.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      console.log(`Peer descoberto: ${peerId}`);
      // Automaticamente tentar conectar a peers descobertos pode ser útil, mas pode ser ruidoso.
      // Por agora, vamos confiar no bootstrap e no dial explícito.
      // libp2p.dial(evt.detail.multiaddrs).catch(err => console.warn(`Falha ao discar para peer descoberto ${peerId}:`, err.message));
    });

    libp2p.addEventListener('peer:connect', (evt) => {
      // Correto para peer:connect é evt.detail.toString() ou evt.detail.remotePeer.toString()
      const peerId = evt.detail.toString();
      console.log(`Conectado ao peer: ${peerId}`);
    });

    libp2p.addEventListener('connection:close', (evt) => {
      const peerId = evt.detail.remotePeer.toString();
      console.log(`Desconectado do peer: ${peerId}`);
    });

    // Se for um nó consultor e tiver um bootstrap peer específico, tentar dial explícito
    // apenas se ainda não estiver conectado a ele.
    if (queryTargetPeerId && bootstrapPeer) {
      let isConnectedToBootstrap = false;
      const bootstrapPeerIdStr = multiaddr(bootstrapPeer).getPeerId();
      if (bootstrapPeerIdStr) {
        for (const connection of libp2p.getConnections()) {
          if (connection.remotePeer.toString() === bootstrapPeerIdStr) {
            isConnectedToBootstrap = true;
            break;
          }
        }
      }

      if (!isConnectedToBootstrap) {
        console.log(`CORE: (Nó consultor) Tentando dial explícito (final) para bootstrap peer: ${bootstrapPeer}`);
        try {
          await libp2p.dial(multiaddr(bootstrapPeer));
          console.log(`CORE: Dial explícito (final) para ${bootstrapPeer} bem-sucedido.`);
        } catch (error) {
          // Não logar erro se for "dial to self has been aborted" ou se já estiver conectado
          if (!error.message.includes('dial to self') && !error.message.includes('already connected')) {
            console.error(`CORE: Falha no dial explícito (final) para ${bootstrapPeer}:`, error.message);
          }
        }
      } else {
        console.log(`CORE: (Nó consultor) Já conectado ao bootstrap peer ${bootstrapPeer}. Dial explícito (final) não necessário.`);
      }
    }

  } catch (error) {
    console.error("CORE: ERRO FATAL CAPTURADO NO BLOCO CATCH DE MAIN:", error); // Log Adicionado
    console.error("CORE: Stacktrace do erro:", error.stack);
    await stopApp();
    if (mainTimeoutId) clearTimeout(mainTimeoutId);
    console.log("CORE: Encerrando processo devido a erro fatal em main().");
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error("CORE: ERRO FATAL CAPTURADO PELO .catch() FINAL DE MAIN:", error);
  console.error("CORE: Stacktrace do erro (catch final):", error.stack);
  if (pubSubIntervalId) clearInterval(pubSubIntervalId);
  if (heliaNode || orbitDB) { 
    console.log('Tentando parar a aplicação devido a erro fatal...');
    await stopApp(); 
  }
  process.exit(1);
}); 