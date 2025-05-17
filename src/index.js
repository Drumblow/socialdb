import path from 'path';
import fs from 'fs/promises'; // Para garantir a existência do diretório de logs
import { writeFileSync as fsWriteSync, existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from 'fs'; // Para log síncrono de erro

// Manipuladores globais de exceção e rejeição
process.on('uncaughtException', (error, origin) => {
  console.error('!!!! UNCAUGHT EXCEPTION !!!!');
  console.error('Origem:', origin);
  console.error('Erro:', error);
  process.exit(1); // Encerrar após exceção não pega
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('!!!! UNHANDLED REJECTION !!!!');
  console.error('Promessa:', promise);
  console.error('Razão:', reason);
  // Aplicações geralmente devem encerrar em unhandledRejection, 
  // mas para depuração, podemos apenas logar por enquanto ou decidir encerrar.
  process.exit(1); // Encerrar após rejeição não pega
});

import { ProfileService } from './services/ProfileService.js';
import { IdentityManager } from './managers/IdentityManager.js';
import { NetworkManager } from './managers/NetworkManager.js';
import { StorageManager } from './managers/StorageManager.js';
import { stringToUint8Array, uint8ArrayToString } from './utils/index.js';

const DB_DISCOVERY_TOPIC = '/social-app/db-discovery/1.0.0';

// Configuração via variáveis de ambiente
const dataDir = process.env.DATA_DIR || './.helia-orbitdb-data';
const wsPort = parseInt(process.env.WS_PORT) || 0;
const bootstrapPeerEnv = process.env.BOOTSTRAP_PEER;
const queryTargetPeerId = process.env.QUERY_TARGET_PEER_ID;

const baseBootstrapMultiaddrs = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
];

let identityManager;
let networkManager;
let storageManager;
let profileServiceInstance;

let appStopped = false;
let mainTimeoutId;
let pubSubAnnounceIntervalId = null;
let dbDiscoveryTimeoutId = null;

async function stopApp() {
  if (appStopped) {
    console.log("CORE_DEBUG: stopApp já foi chamada anteriormente.");
    return;
  }
  appStopped = true;
  console.log('\nCORE_DEBUG: Iniciando stopApp...');

  if (mainTimeoutId) clearTimeout(mainTimeoutId);
  if (pubSubAnnounceIntervalId) clearInterval(pubSubAnnounceIntervalId);
  if (dbDiscoveryTimeoutId) clearTimeout(dbDiscoveryTimeoutId);

  if (profileServiceInstance) {
    console.log("CORE_DEBUG: Fechando ProfileService...");
    try { 
      await profileServiceInstance.close(); 
      console.log("CORE_DEBUG: ProfileService fechado."); 
    } catch (e) { 
      console.error("CORE_DEBUG: Erro ao fechar ProfileService", e);
    }
  }

  if (networkManager) {
    console.log("CORE_DEBUG: Fechando NetworkManager...");
    try { 
        await networkManager.close(); 
        console.log("CORE_DEBUG: NetworkManager fechado.");
    } catch (e) { 
        console.error("CORE_DEBUG: Erro ao fechar NetworkManager", e);
    }
  }

  if (storageManager) {
    console.log("CORE_DEBUG: Fechando StorageManager (helia, orbitdb)...");
    try { 
      await storageManager.close(); 
      console.log("CORE_DEBUG: StorageManager fechado."); 
    } catch (e) { 
      console.error("CORE_DEBUG: Erro ao fechar StorageManager", e);
    }
  }
  
  if (identityManager) {
    console.log("CORE_DEBUG: Fechando IdentityManager...");
    try { 
        await identityManager.close(); 
        console.log("CORE_DEBUG: IdentityManager fechado.");
    } catch (e) { 
        console.error("CORE_DEBUG: Erro ao fechar IdentityManager", e);
    }
  }
  console.log('CORE_DEBUG: Limpeza em stopApp concluída. Processo NÃO será encerrado por stopApp agora.');
  // process.exit(0); // TEMPORARIAMENTE REMOVIDO PARA DEBUG
}

async function main() {
  const nodeType = queryTargetPeerId ? 'Nó Consultor' : 'Nó Publicador';
  const mainLoopDurationSeconds = queryTargetPeerId ? 120 : 90; // Consultor mais tempo para descoberta

  // Garantir que o diretório de logs exista
  try {
    await fs.mkdir('./logs', { recursive: true });
  } catch (e) { /* não faz nada se já existir */ }

  console.log(`CORE: Iniciando main() para ${nodeType}`);
  console.log(`CORE: Usando diretório de dados: ${path.resolve(dataDir)}`);
  console.log(`CORE: Usando porta WS: ${wsPort === 0 ? 'Aleatória' : wsPort}`);
  if (bootstrapPeerEnv) console.log(`CORE: Peer de bootstrap (env): ${bootstrapPeerEnv}`);
  if (queryTargetPeerId) console.log(`CORE: Peer alvo para consulta: ${queryTargetPeerId}`);

  // Configurar handlers de sinal
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach(signal => {
    process.once(signal, () => { 
      console.log(`\nCORE_DEBUG: Manipulador de SINAL ATIVADO para ${signal}. Chamando stopApp...`);
      stopApp(); 
    });
  });

  try {
    identityManager = new IdentityManager(dataDir);
    const datastore = await identityManager.init();

    networkManager = new NetworkManager(wsPort, baseBootstrapMultiaddrs, datastore);
    if (bootstrapPeerEnv) {
      networkManager.addBootstrapPeer(bootstrapPeerEnv);
    }

    const libp2pOptions = networkManager.getLibp2pOptions();
    
    storageManager = new StorageManager({ libp2p: libp2pOptions, datastore }, path.join(dataDir, 'orbitdb'));
    const { heliaNode, orbitDB: orbitDbInstance } = await storageManager.init();
    
    // Configurar o nó libp2p no NetworkManager após Helia tê-lo criado/configurado
    networkManager.setLibp2pNode(heliaNode.libp2p);
    const ownPeerIdStr = heliaNode.libp2p.peerId.toString();
    console.log(`CORE: Nó Helia (e Libp2p) iniciado com Peer ID: ${ownPeerIdStr}`);

    // Timeout principal da aplicação
    mainTimeoutId = setTimeout(async () => {
      console.log(`\nCORE_DEBUG: Timeout principal de ${mainLoopDurationSeconds}s atingido. Chamando stopApp...`);
      await stopApp();
      console.log("CORE_DEBUG: stopApp chamado pelo mainTimeoutId CONCLUÍDO. Se o processo não sair, algo o mantém vivo.");
      // Se o processo não sair sozinho aqui após stopApp (sem process.exit), é estranho.
    }, mainLoopDurationSeconds * 1000);

    if (!queryTargetPeerId) { // Lógica do Nó Publicador
      console.log("CORE: (Nó Publicador) Configurando ProfileService...");
      profileServiceInstance = new ProfileService(heliaNode.libp2p, orbitDbInstance);
      await profileServiceInstance.init();
      console.log(`CORE: (Nó Publicador) ProfileService inicializado. Endereço do DB de Perfis: ${profileServiceInstance.profileDB.address.toString()}`);

      const profileData = {
        name: `User-${ownPeerIdStr.slice(-6)}`,
        avatarUrl: `https://example.com/avatar/${ownPeerIdStr.slice(-6)}.png`,
        status: "Online and ready!",
        timestamp: new Date().toISOString(),
        nodePeerId: ownPeerIdStr
      };
      console.log("CORE_DEBUG: (Nó Publicador) PREPARANDO para publicar perfil inicial. Dados:", profileData);
      await profileServiceInstance.publishProfile(ownPeerIdStr, profileData);
      console.log("CORE_DEBUG: (Nó Publicador) Publicação inicial do perfil CONCLUÍDA (ou pelo menos a chamada retornou).");
      console.log("CORE: (Nó Publicador) Perfil inicial publicado.");

      // Lógica de atualização de perfil (1ª atualização)
      setTimeout(async () => {
        if (appStopped || !profileServiceInstance) return;
        console.log("\nCORE: (Nó publicador) === 1ª ATUALIZAÇÃO DE PERFIL APÓS DELAY ===");
        const updatedProfileData1 = {
          name: `User-${ownPeerIdStr.slice(-6)} (Updated)`,
          avatarUrl: `https://example.com/avatar/${ownPeerIdStr.slice(-6)}.png`,
          status: "Online and updated!",
          timestamp: new Date().toISOString(),
          nodePeerId: ownPeerIdStr
        };
        try {
          await profileServiceInstance.publishProfile(ownPeerIdStr, updatedProfileData1);
          console.log("CORE: (Nó publicador) Perfil 1ª ATUALIZAÇÃO publicado.");
        } catch (error) {
          console.error("CORE: (Nó publicador) Erro na 1ª atualização de perfil:", error);
        }
      }, 20000); // 20 segundos

      // Lógica de atualização de perfil (2ª atualização)
      setTimeout(async () => {
        if (appStopped || !profileServiceInstance) return;
        console.log("\nCORE: (Nó publicador) === 2ª ATUALIZAÇÃO DE PERFIL APÓS DELAY MAIOR ===");
        const updatedProfileData2 = {
          name: `User-${ownPeerIdStr.slice(-6)} (Super Updated)`,
          avatarUrl: `https://example.com/avatar/${ownPeerIdStr.slice(-6)}.png`,
          status: "Online and super updated! Check me out!",
          timestamp: new Date().toISOString(),
          nodePeerId: ownPeerIdStr
        };
        try {
          await profileServiceInstance.publishProfile(ownPeerIdStr, updatedProfileData2);
          console.log("CORE: (Nó publicador) Perfil 2ª ATUALIZAÇÃO publicado.");
        } catch (error) {
          console.error("CORE: (Nó publicador) Erro na 2ª atualização de perfil:", error);
        }
      }, 45000); // 45 segundos

      // Publicador espera por "consultorReadyForDbDiscovery"
      const consultorReadyHandler = async (event) => {
        if (event.detail.topic === DB_DISCOVERY_TOPIC) {
          try {
            const messageStr = uint8ArrayToString(event.detail.data);
            const message = JSON.parse(messageStr);
            console.log(`CORE: (Nó Publicador) Recebido 'consultorReadyForDbDiscovery' do Peer ${message.peerId.slice(-6)}.`);
            console.log("CORE: (Nó Publicador) Iniciando tentativas de anúncio de DB...");
            
            let attempts = 0;
            const maxAttempts = 5; 
            if (pubSubAnnounceIntervalId) clearInterval(pubSubAnnounceIntervalId);

            pubSubAnnounceIntervalId = setInterval(async () => {
              if (appStopped || attempts >= maxAttempts) {
                if (pubSubAnnounceIntervalId) clearInterval(pubSubAnnounceIntervalId);
                if (attempts >= maxAttempts) console.log("CORE: (Nó Publicador) Máximo de tentativas de anúncio atingido.");
                return;
              }
              attempts++;
              const announced = await networkManager.publishDbAnnounce(profileServiceInstance.profileDB.address.toString(), message.peerId);
              if (announced) {
                console.log("CORE: (Nó Publicador) Anúncio de DB provavelmente bem-sucedido.");
              }
            }, 7000); // Intervalo de anúncio: 7 segundos
          } catch (e) {
            console.error("CORE: (Nó Publicador) Erro ao processar mensagem de descoberta:", e);
          }
        }
      };
      await networkManager.listenForConsultorReady(consultorReadyHandler);

    } else { // Lógica do Nó Consultor
      console.log(`CORE: (Nó Consultor) Tentando conectar ao peer de bootstrap/alvo: ${queryTargetPeerId}`);
      // Dial explícito para o peer de bootstrap/alvo para acelerar a conexão
      // O NetworkManager já tem queryTargetPeerId em sua lista de bootstrap se bootstrapPeerEnv foi definido com ele
      // Mas um dial direto após o start pode ajudar.
      // Await para garantir que o dial foi tentado antes de prosseguir.
      if (bootstrapPeerEnv) {
         await networkManager.dial(bootstrapPeerEnv); // bootstrapPeerEnv deve ser o multiaddr completo do Nó 1
      }
      
      let targetDbAddress = null;
      let targetPublisherPeerId = null;

      const dbAnnounceHandler = async (event) => {
        if (appStopped) {
          return;
        }
        if (event.detail.topic === DB_DISCOVERY_TOPIC) {
          try {
            const messageStr = uint8ArrayToString(event.detail.data);
            const message = JSON.parse(messageStr);
            console.log(`CORE: (Nó consultor) Mensagem recebida no ${DB_DISCOVERY_TOPIC}:`, message);

            if (message.type === 'dbAnnounce' && message.dbAddress && message.peerId) {
              console.log(`CORE: (Nó consultor) Recebido anúncio de DB do Peer ${message.peerId.slice(-6)}: ${message.dbAddress}`);
              
              if (queryTargetPeerId && message.peerId !== queryTargetPeerId) {
                console.log(`CORE: (Nó consultor) Anúncio de DB de ${message.peerId.slice(-6)} ignorado, esperando por ${queryTargetPeerId.slice(-6)}.`);
                return; 
              }

              targetDbAddress = message.dbAddress; 
              targetPublisherPeerId = message.peerId; 
              console.log(`CORE: (Nó consultor) Endereço do DB do publicador (${targetPublisherPeerId.slice(-6)}) definido para: ${targetDbAddress}`);

              if (dbDiscoveryTimeoutId) {
                clearTimeout(dbDiscoveryTimeoutId);
                dbDiscoveryTimeoutId = null;
              }
              
              // Desinscrever do listener de anúncio de DB após encontrar o que precisa
              // Acessa o listener diretamente no networkManager para removê-lo.
              if (networkManager && networkManager.dbAnnounceListener && networkManager.getLibp2pNode()) {
                  networkManager.getLibp2pNode().services.pubsub.removeEventListener('message', networkManager.dbAnnounceListener);
                  console.log("CORE: (Nó consultor) Removido listener de dbAnnounce após sucesso.");
              }

              // Agora que temos o endereço do DB, instanciar ProfileService e tentar buscar
              try {
                console.log(`CORE: (Nó consultor) Instanciando ProfileService para o DB anunciado...`);
                
                const handleProfileUpdate = (updatedKey, updatedValue) => {
                  console.log(`\nCORE: (Nó consultor) === PERFIL ATUALIZADO RECEBIDO ===`);
                  console.log(`CORE: (Nó consultor) Chave do perfil atualizado: ${updatedKey}`);
                  if (queryTargetPeerId && updatedKey === queryTargetPeerId) {
                    console.log(`CORE_SUCCESS: (Nó consultor) O PERFIL DE ${queryTargetPeerId.slice(-6)} FOI ATUALIZADO! Dados:`, updatedValue);
                  } else if (!queryTargetPeerId) { // Se não estivermos focados em um peer, logar qualquer atualização
                    console.log(`CORE_SUCCESS: (Nó consultor) Perfil de ${updatedKey.slice(-6)} foi ATUALIZADO! Dados:`, updatedValue);
                  } else {
                    console.log(`CORE_INFO: (Nó consultor) Atualização de perfil recebida para ${updatedKey.slice(-6)}, mas esperava por ${queryTargetPeerId.slice(-6)}.`);
                  }
                };

                profileServiceInstance = new ProfileService(heliaNode.libp2p, orbitDbInstance, targetDbAddress, handleProfileUpdate);
                
                console.log(`CORE: (Nó consultor) Aguardando ProfileService.openProfileDB() para ${targetDbAddress}...`);
                await profileServiceInstance.openProfileDB(targetDbAddress); 
                console.log(`CORE: (Nó consultor) ProfileService.openProfileDB() concluído para ${targetDbAddress}.`);
                
                console.log(`CORE: (Nó consultor) Buscando perfil de ${targetPublisherPeerId.slice(-6)}...`);
                const profile = await profileServiceInstance.getProfile(targetPublisherPeerId);
                if (profile) {
                  console.log(`CORE_SUCCESS: (Nó consultor) PERFIL INICIAL de ${targetPublisherPeerId.slice(-6)} ENCONTRADO APÓS ABERTURA DO DB! Dados:`, profile);
                } else {
                  console.warn(`CORE_WARN: (Nó consultor) Perfil de ${targetPublisherPeerId.slice(-6)} NÃO encontrado após abrir DB e chamar getProfile.`);
                }
                // O nó consultor agora permanece ativo para escutar atualizações via handleProfileUpdate
                // O mainTimeoutId original ainda está ativo para eventualmente parar o nó consultor.

              } catch (e) {
                console.error("CORE: (Nó consultor) Erro ao instanciar/usar ProfileService após anúncio:", e);
              }
            }
          } catch (e) {
            console.error("CORE: (Nó consultor) Erro ao processar mensagem de descoberta:", e);
          }
        }
      };

      console.log("CORE: (Nó consultor) Inscrevendo-se no tópico de descoberta para receber anúncios de DB.");
      await networkManager.subscribeToDbDiscoveryTopic(dbAnnounceHandler);

      // Timeout para a descoberta do DB via anúncio (se o anúncio não chegar)
      const discoveryTimeoutSeconds = 60;
      dbDiscoveryTimeoutId = setTimeout(() => {
        if (!targetDbAddress) { // Se ainda não recebeu o anúncio
            console.warn(`CORE: (Nó consultor) Timeout de ${discoveryTimeoutSeconds}s para descoberta de DB. Nenhum anúncio recebido. Encerrando.`);
            stopApp(); 
        }
      }, discoveryTimeoutSeconds * 1000);

      console.log("CORE: (Nó consultor) Iniciando tentativas de publicar 'consultorReadyForDbDiscovery'...");
      let consultorReadyPublished = false;
      const maxPublishAttempts = 5;
      const publishAttemptDelay = 3000; // 3 segundos entre tentativas

      for (let attempt = 1; attempt <= maxPublishAttempts; attempt++) {
        if (appStopped) {
            break;
        }
        console.log(`CORE: (Nó consultor) Tentativa ${attempt}/${maxPublishAttempts} de publicar 'consultorReadyForDbDiscovery'.`);
        consultorReadyPublished = await networkManager.publishConsultorReady(queryTargetPeerId);
        if (consultorReadyPublished) {
          console.log("CORE_SUCCESS: (Nó consultor) 'consultorReadyForDbDiscovery' publicado com sucesso (recebido por pelo menos 1 peer).");
          break;
        } else {
          console.warn(`CORE_WARN: (Nó consultor) Falha na tentativa ${attempt} de publicar 'consultorReadyForDbDiscovery'.`);
          if (attempt < maxPublishAttempts) {
            await new Promise(resolve => setTimeout(resolve, publishAttemptDelay));
          } else {
            console.error("CORE_ERROR: (Nó consultor) Máximo de tentativas de publicar 'consultorReadyForDbDiscovery' atingido.");
          }
        }
      }

      if (!consultorReadyPublished) {
        console.error("CORE_ERROR: (Nó consultor) Não foi possível publicar 'consultorReadyForDbDiscovery' após múltiplas tentativas. Encerrando o nó consultor.");
        await stopApp(); // Garante que stopApp seja aguardado
        return; // Encerrar a função main para o consultor se a publicação falhar
      }
      // Se chegou aqui, consultorReadyPublished é true e a lógica de descoberta continua
    }

  } catch (error) {
    console.error('CORE_DEBUG: ERRO FATAL CAPTURADO NA FUNÇÃO MAIN!');
    
    // Log síncrono para arquivo em caso de falha catastrófica
    try {
      const logDir = './logs';
      if (!fsExistsSync(logDir)) {
        fsMkdirSync(logDir, { recursive: true });
      }
      const errorFilePath = path.join(logDir, 'error_dump_node1.log');
      const timestamp = new Date().toISOString();
      let errorDetails = `[${timestamp}] ERRO FATAL CAPTURADO NA FUNÇÃO MAIN!\\n`;
      if (error) {
        errorDetails += `Tipo: ${typeof error}\\n`;
        if (error.message) errorDetails += `Mensagem: ${error.message}\\n`;
        if (error.name) errorDetails += `Nome: ${error.name}\\n`;
        if (error.stack) errorDetails += `Stack: ${error.stack}\\n`;
        try {
          errorDetails += `Erro (String): ${String(error)}\\n`;
        } catch (e_tostring) {
          errorDetails += `Falha ao converter erro para String: ${e_tostring.message}\\n`;
        }
        try {
          errorDetails += `Erro (JSON): ${JSON.stringify(error, Object.getOwnPropertyNames(error))}\\n`;
        } catch (e_json) {
          errorDetails += `Falha ao converter erro para JSON: ${e_json.message}\\n`;
        }
      } else {
        errorDetails += "Erro capturado é undefined ou null.\\n";
      }
      fsWriteSync(errorFilePath, errorDetails, { flag: 'a' }); // 'a' para append
      console.log(`CORE_DEBUG: Detalhes do erro também foram tentados gravar em ${errorFilePath}`);
    } catch (e_fs) {
      console.error('CORE_DEBUG: Falha CRÍTICA ao tentar gravar o log de erro síncrono:', e_fs.message);
    }

    await stopApp(); 
    console.log("CORE_DEBUG: stopApp chamado pelo catch de erro fatal CONCLUÍDO.");
    setTimeout(() => {
        console.log("CORE_DEBUG: Encerrando manualmente via process.exit(1) após delay para flush de logs.");
        process.exit(1);
    }, 200); // Aumentar um pouco o delay
  }
}

// Iniciar a aplicação
main(); 