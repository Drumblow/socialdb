import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';

export class ProfileService {
  constructor(libp2pNode, orbitdbInstance, dbAddress = null, onProfileUpdateCallback = null) {
    this.node = libp2pNode;
    this.orbitdb = orbitdbInstance;
    this.profileDB = null;
    this.dbAddress = dbAddress;
    this.onProfileUpdateCallback = onProfileUpdateCallback;
  }

  async init() {
    if (!this.orbitdb) {
      throw new Error("SERVICE: Instância do OrbitDB não fornecida ao ProfileService.");
    }
    try {
      let dbNameOrAddress;
      if (this.dbAddress) {
        dbNameOrAddress = this.dbAddress;
        console.log(`SERVICE: Tentando abrir banco de dados OrbitDB pelo endereço fornecido: ${dbNameOrAddress}`);
      } else {
        dbNameOrAddress = 'user-profiles';
        console.log(`SERVICE: Inicializando banco de dados de perfis (keyvalue) pelo nome: ${dbNameOrAddress}`);
      }
      
      const openOptions = { 
        type: 'keyvalue', 
        create: !this.dbAddress
      };
      this.profileDB = await this.orbitdb.open(dbNameOrAddress, openOptions);
      console.log(`SERVICE: Banco de dados de perfis aberto. Endereço resultante: ${this.profileDB.address.toString()}`);
      if (this.dbAddress && this.profileDB.address.toString() !== this.dbAddress) {
        console.warn(`SERVICE: AVISO - O endereço do DB aberto (${this.profileDB.address.toString()}) é diferente do endereço solicitado (${this.dbAddress}). Isso pode indicar que o DB solicitado não foi encontrado e um novo foi criado com o endereço como nome.`);
      }

      // Adicionar listeners para depuração da sincronização do OrbitDB
      this.profileDB.events.on('ready', () => {
        console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Banco de dados '${this.profileDB.address.toString()}' está PRONTO localmente.`);
      });

      this.profileDB.events.on('update', (entry) => {
        // O evento 'update' em keyvalue store pode não ser tão direto quanto em outros tipos.
        // O evento mais importante para keyvalue é quando o valor é efetivamente atualizado.
        // Vamos logar a entrada inteira para ver sua estrutura.
        console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Recebido 'update' no banco '${this.profileDB.address.toString()}'. Entrada:`, entry);
        // Para keyvalue, entry.key e entry.value (ou entry.payload.value) podem ser relevantes.
        // O simples fato de receber 'update' após o outro nó publicar é um bom sinal.

        // Chamar o callback de atualização se existir e a entrada for válida
        if (this.onProfileUpdateCallback && entry && entry.payload && entry.payload.key && typeof entry.payload.value !== 'undefined') {
          try {
            // A estrutura exata pode precisar de ajuste com base nos logs do OrbitDB
            // No nosso caso, o valor é o objeto do perfil diretamente.
            this.onProfileUpdateCallback(entry.payload.key, entry.payload.value);
          } catch (cbError) {
            console.error("SERVICE: Erro ao executar onProfileUpdateCallback em init():", cbError);
          }
        }
      });

      this.profileDB.events.on('join', (peerId, heads) => {
        console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Peer ${peerId.toString().slice(-4)} JUNTផ្នែក-SE ao swarm do DB '${this.profileDB.address.toString()}'. Heads:`, heads);
      });

      this.profileDB.events.on('peer.exchanged', (peerId, address, heads) => {
        console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): 'peer.exchanged' com Peer ${peerId.toString().slice(-4)} (addr: ${address}) para DB '${this.profileDB.address.toString()}'. Heads:`, heads);
      });

      // É útil também saber quando o DB está totalmente carregado/sincronizado após a conexão inicial
      this.profileDB.events.on('load.progress', (address, hash, entry, progress, total) => {
        // Este evento pode ser muito verboso, mas útil para ver se algo está acontecendo
        // console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): DB '${address}' load.progress: ${progress}/${total}`);
      });
      
      this.profileDB.events.on('replicated', (address) => {
          console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Banco de dados '${address}' foi REPLICADO (ou pelo menos uma entrada).`);
      });

      this.profileDB.events.on('close', () => console.log("SERVICE: profileDB foi fechado."));
      this.profileDB.events.on('drop', () => console.log("SERVICE: profileDB foi descartado."));
      this.profileDB.events.on('load', () => console.log("SERVICE: profileDB evento 'load' (iniciando carregamento)."));
      this.profileDB.events.on('ready', () => console.log("SERVICE: profileDB evento 'ready' (carregado e pronto)."));

    } catch (error) {
      console.error("SERVICE: Falha ao inicializar o banco de dados de perfis:", error);
      throw error;
    }
  }

  async openProfileDB(dbAddressToOpen) {
    if (!this.orbitdb) {
      throw new Error("SERVICE: Instância do OrbitDB não fornecida ao ProfileService.");
    }
    if (!dbAddressToOpen) {
      throw new Error("SERVICE: Endereço do banco de dados (dbAddressToOpen) não fornecido para openProfileDB.");
    }
    try {
      console.log(`SERVICE: Tentando abrir banco de dados OrbitDB pelo endereço fornecido: ${dbAddressToOpen}`);
      this.profileDB = await this.orbitdb.open(dbAddressToOpen, { type: 'keyvalue' });
      console.log(`SERVICE: Banco de dados de perfis aberto. Endereço resultante: ${this.profileDB.address.toString()}`);

      if (this.profileDB.address.toString() !== dbAddressToOpen) {
        console.warn(`SERVICE: AVISO - O endereço do DB aberto (${this.profileDB.address.toString()}) é diferente do endereço solicitado (${dbAddressToOpen}). Isso pode indicar um problema ao carregar o DB remoto.`);
      }

      // Retornar uma Promise que resolve após a primeira replicação ou timeout
      return new Promise((resolve, reject) => {
        const replicationTimeoutMs = 30000; // 30 segundos
        let timeoutId = null;
        let isResolved = false;

        const done = (error) => {
          if (isResolved) return;
          isResolved = true;
          if (timeoutId) clearTimeout(timeoutId);
          // Manter os listeners de 'replicated' e 'update' para o onProfileUpdateCallback,
          // mas remover os que são especificamente para a Promise de 'openProfileDB'
          // Se onReplicatedOrUpdateForPromise foi definido, podemos removê-lo.
          // No entanto, o onProfileUpdateCallback precisará de um listener 'update' persistente.
          // Para simplificar, deixaremos o listener de 'update' global que adicionaremos abaixo.
          if (typeof onReplicatedOrUpdateForPromise !== 'undefined') {
            this.profileDB.events.off('replicated', onReplicatedOrUpdateForPromise);
            this.profileDB.events.off('update', onReplicatedOrUpdateForPromise);
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        // Listener específico para a Promise de openProfileDB
        const onReplicatedOrUpdateForPromise = (addressOrEntry) => {
          let targetAddress = this.profileDB.address.toString();
          let eventAddress = "";
          let isUpdateEvent = false;

          if (typeof addressOrEntry === 'string') {
            eventAddress = addressOrEntry;
          } else if (typeof addressOrEntry === 'object' && addressOrEntry !== null && addressOrEntry.payload && addressOrEntry.payload.value) {
            // Usando a mesma lógica de 'init' para identificar o evento de update
            eventAddress = this.profileDB.address.toString(); // Assume que o update é para este DB
            isUpdateEvent = true;
          }


          if (eventAddress === targetAddress) {
            if (isUpdateEvent) {
                console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): 'update' (para Promise) detectado para ${targetAddress}. DB provavelmente sincronizando.`);
            } else {
                console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): 'replicated' (para Promise) detectado para ${targetAddress}. DB pronto para leitura.`);
            }
            done();
          }
        };

        this.profileDB.events.on('replicated', onReplicatedOrUpdateForPromise);
        this.profileDB.events.on('update', onReplicatedOrUpdateForPromise);


        timeoutId = setTimeout(() => {
          console.warn(`SERVICE: Timeout de ${replicationTimeoutMs / 1000}s atingido esperando pela replicação/update do DB ${this.profileDB.address.toString()} (para Promise). Tentando prosseguir.`);
          done();
        }, replicationTimeoutMs);

        // Listener de 'update' PERMANENTE para o onProfileUpdateCallback
        // Este será adicionado APÓS a lógica da Promise de 'openProfileDB'
        // para não interferir com ela, e para garantir que o ProfileService continue
        // a notificar sobre atualizações mesmo após o 'openProfileDB' ter resolvido.
        this.profileDB.events.on('update', (entry) => {
          if (this.onProfileUpdateCallback && entry && entry.payload && entry.payload.key && typeof entry.payload.value !== 'undefined') {
            try {
              console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Chamando onProfileUpdateCallback de openProfileDB para key: ${entry.payload.key}`);
              this.onProfileUpdateCallback(entry.payload.key, entry.payload.value);
            } catch (cbError) {
              console.error("SERVICE: Erro ao executar onProfileUpdateCallback em openProfileDB():", cbError);
            }
          }
        });
        
        // Adicionar os outros listeners DEPOIS de configurar a Promise de replicação
        this.profileDB.events.on('ready', () => {
          console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Banco de dados '${this.profileDB.address.toString()}' está PRONTO localmente.`);
          // Se já estiver replicado e pronto, podemos resolver. Mas o evento 'replicated' ou 'update' deve cuidar disso.
        });
  
        this.profileDB.events.on('join', (peerId, heads) => {
          console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): Peer ${peerId.toString().slice(-4)} JUNTផ្នែក-SE ao swarm do DB '${this.profileDB.address.toString()}'. Heads:`, heads);
        });
  
        this.profileDB.events.on('peer.exchanged', (peerId, pAddress, heads) => {
          console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): 'peer.exchanged' com Peer ${peerId.toString().slice(-4)} (addr: ${pAddress}) para DB '${this.profileDB.address.toString()}'. Heads:`, heads);
        });
        
        this.profileDB.events.on('load.progress', (pAddress, hash, entry, progress, total) => {
          // console.log(`SERVICE_DB_EVENT (${this.node.peerId.toString().slice(-4)}): DB '${pAddress}' load.progress: ${progress}/${total}`);
        });
        
        this.profileDB.events.on('close', () => console.log("SERVICE: profileDB foi fechado."));
        this.profileDB.events.on('drop', () => console.log("SERVICE: profileDB foi descartado."));
        this.profileDB.events.on('load', () => console.log("SERVICE: profileDB evento 'load' (iniciando carregamento)."));
      }); // Fim da Promise retornada

    } catch (error) {
      console.error(`SERVICE: Falha crítica ao abrir ou configurar espera para o banco de dados de perfis em ${dbAddressToOpen}:`, error);
      // Se o erro ocorrer antes da Promise ser criada (ex: orbitdb.open falha), precisamos rejeitar explicitamente.
      return Promise.reject(error);
    }
  }

  async publishProfile(peerIdStr, profileData) {
    if (!this.profileDB) {
      throw new Error("SERVICE: Banco de dados de perfis não inicializado antes de publicar.");
    }
    console.log(`SERVICE: Tentando publicar perfil no OrbitDB. Chave (PeerId): ${peerIdStr}, Dados:`, profileData);
    try {
      await this.profileDB.put(peerIdStr, profileData);
      console.log(`SERVICE: Perfil publicado no OrbitDB com a chave: ${peerIdStr}`);
      return true;
    } catch (error) {
      console.error(`SERVICE: Falha ao publicar perfil ${peerIdStr} no OrbitDB:`, error);
      // Verifica se o erro é relacionado a "NoPeersSubscribedToTopic"
      if (error.message && error.message.includes("NoPeersSubscribedToTopic")) {
        console.warn(`SERVICE: AVISO - O perfil para ${peerIdStr} foi salvo localmente, mas a publicação inicial na rede pode não ter encontrado peers. Os dados devem sincronizar quando outros peers se conectarem.`);
        return true; // Considera sucesso local, pois os dados estão no DB.
      }
      throw error; // Re-lança outros erros
    }
  }

  async getProfile(peerIdToQueryString) {
    if (!this.profileDB) {
      console.error("SERVICE: Banco de dados de perfis não inicializado. Chame init() primeiro.");
      throw new Error("SERVICE_NOT_INITIALIZED");
    }
    try {
      console.log(`SERVICE: Buscando perfil no OrbitDB com a chave: ${peerIdToQueryString}`);
      const profile = await this.profileDB.get(peerIdToQueryString);

      if (profile !== undefined && profile !== null) {
        console.log('SERVICE: Perfil encontrado no OrbitDB:', profile);
        return profile;
      } else {
        console.log(`SERVICE: Nenhum perfil encontrado para ${peerIdToQueryString} no OrbitDB.`);
        return null;
      }
    } catch (error) {
      console.error(`SERVICE: Falha ao buscar perfil ${peerIdToQueryString} do OrbitDB:`, error);
      return null;
    }
  }

  async close() {
    if (this.profileDB) {
      await this.profileDB.close();
      console.log("SERVICE: Banco de dados de perfis fechado.");
    }
  }
} 