import { NotInitializedError } from './utils/errors.js';

export class CoreAPI {
  constructor(eventBus, identityManager, networkManager, storageManager, addonManager, addonId, addonPermissions = []) {
    if (!eventBus) throw new Error("CoreAPI: EventBus é obrigatório.");
    if (!identityManager) throw new Error("CoreAPI: IdentityManager é obrigatório.");
    if (!addonId) throw new Error("CoreAPI: addonId é obrigatório para esta instância da CoreAPI.");
    // NetworkManager, StorageManager e AddonManager podem ser opcionais ou adicionados depois
    // dependendo das funcionalidades que a CoreAPI precisará expor.

    this.eventBus = eventBus;
    this.identityManager = identityManager;
    this.networkManager = networkManager; // Para futuras interações de rede via addons
    this.storageManager = storageManager; // Para futuras interações de armazenamento via addons
    this.addonManager = addonManager;     // Para addons interagirem com outros addons (com cautela)
    
    this.addonId = addonId; // ID do addon que esta instância da CoreAPI serve
    this.addonPermissions = Array.isArray(addonPermissions) ? addonPermissions : []; // Permissões do addon

    this._peerId = null;
    console.log(`CoreAPI: Instância criada para o addon '${this.addonId}'. Permissões: [${this.addonPermissions.join(', ')}]`);
  }

  async init() {
    console.log(`CoreAPI [${this.addonId}]: Inicializando...`);
    // É importante que o IdentityManager esteja inicializado para termos o PeerId.
    if (this.identityManager && typeof this.identityManager.getPeerId === 'function') {
      const peerIdResult = await this.identityManager.getPeerId(); // getPeerId é async
      if (!peerIdResult) {
        console.warn(`CoreAPI [${this.addonId}]: PeerId não pôde ser obtido na inicialização.`);
      } else {
        this._peerId = peerIdResult; // Armazena o objeto PeerId, não a string
      }
    } else {
        console.error(`CoreAPI [${this.addonId}]: IdentityManager não está configurado corretamente ou não foi inicializado antes da CoreAPI.`);
        throw new NotInitializedError(`CoreAPI [${this.addonId}]: IdentityManager inválido ou não inicializado.`);
    }
    console.log(`CoreAPI [${this.addonId}]: Inicializada. PeerID: ${this._peerId ? this._peerId.toString() : 'N/A'}`);
  }

  // Método para verificar permissões (será usado internamente por outros métodos da CoreAPI)
  hasPermission(permissionString) {
    if (!permissionString) return false; // Não faz sentido verificar uma permissão vazia
    // Por enquanto, uma checagem simples. Pode evoluir para wildcards, etc.
    const has = this.addonPermissions.includes(permissionString);
    if (!has) {
      // Logar apenas uma vez que a permissão foi negada, para não poluir os logs se for checada multiplas vezes.
      // Uma forma mais sofisticada poderia rastrear permissões já checadas.
      // Por agora, este log é informativo.
      console.warn(`CoreAPI [${this.addonId}]: Tentativa de ação que requer a permissão '${permissionString}', mas ela NÃO FOI CONCEDIDA.`);
    }
    return has;
  }

  log(message) {
    if (!this.hasPermission('core:log')) {
      // Não loga a mensagem do addon, o aviso já foi emitido por hasPermission.
      return; 
    }
    console.log(`CoreAPI [${this.addonId}]: ${message}`);
  }

  getPeerId() {
    // Exemplo de como poderíamos proteger o acesso ao PeerId
    // if (!this.hasPermission('core:identity:readPeerId')) { 
    //   throw new Error(`CoreAPI [${this.addonId}]: Permissão 'core:identity:readPeerId' necessária.`);
    // }
    if (!this._peerId) {
      console.warn(`CoreAPI [${this.addonId}]: PeerId não disponível no momento da chamada getPeerId(). A inicialização pode não ter completado ou falhou.`);
      // Não tentar buscar novamente aqui para evitar complexidade; a init() deve garantir isso.
      return null;
    }
    return this._peerId.toString(); // Retorna a representação string do PeerId
  }

  // Expor o EventBus para que addons possam emitir e ouvir eventos
  getEventBus() {
    // Exemplo: Poderíamos verificar uma permissão 'core:eventbus:access' aqui se necessário
    return this.eventBus;
  }

  // Exemplo de como um addon poderia acessar outro (de forma controlada)
  getAddonInstance(addonIdToGet) {
    // Exemplo: Poderíamos verificar uma permissão 'core:addons:read' ou 'core:addons:get:${addonIdToGet}'
    if (this.addonManager) {
      const loadedAddon = this.addonManager.getLoadedAddon(addonIdToGet);
      // No futuro, getLoadedAddon retornaria a info completa, incluindo a instância da API do outro addon.
      // Por agora, retorna a instância do addon em si.
      return loadedAddon ? loadedAddon.instance : null;
    }
    console.warn(`CoreAPI [${this.addonId}]: AddonManager não disponível para getAddonInstance.`);
    return null;
  }

  /**
   * Fornece acesso a um banco de dados OrbitDB escopado para o addon.
   * O addon deve ter a permissão 'core:storage:scoped'.
   * @param {string} dbName O nome desejado para o banco de dados (será prefixado com o ID do addon).
   * @param {string} [dbType='keyvalue'] O tipo de OrbitDB (ex: 'keyvalue', 'documents', 'events').
   * @param {object} [options={}] Opções adicionais para a abertura do banco de dados.
   * @returns {Promise<OrbitDBStore|null>} A instância do OrbitDB ou null se não houver permissão/erro.
   */
  async storageGetScopedDB(dbName, dbType = 'keyvalue', options = {}) {
    if (!this.hasPermission('core:storage:scoped')) {
      // O aviso já foi logado por hasPermission.
      // Poderia lançar um erro aqui para ser mais explícito sobre a falha.
      // Por enquanto, retornar null é consistente com outras falhas silenciosas.
      return null; 
    }
    if (!this.storageManager) {
      console.error(`CoreAPI [${this.addonId}]: StorageManager não está disponível para storageGetScopedDB.`);
      throw new Error(`CoreAPI [${this.addonId}]: StorageManager não está disponível.`);
    }
    if (!dbName || typeof dbName !== 'string' || !dbName.trim()) {
      console.error(`CoreAPI [${this.addonId}]: dbName inválido fornecido para storageGetScopedDB.`);
      throw new Error(`CoreAPI [${this.addonId}]: dbName é obrigatório e deve ser uma string não vazia.`);
    }

    try {
      return await this.storageManager.getScopedOrbitDB(this.addonId, dbName, dbType, options);
    } catch (error) {
      console.error(`CoreAPI [${this.addonId}]: Erro ao obter DB escopado '${dbName}':`, error);
      // Não relançar para o addon necessariamente, a menos que seja uma política.
      // Retornar null indica falha.
      return null;
    }
  }

  // Outras funções que os addons podem precisar:
  // - Acesso a storage específico do addon?
  // - Enviar mensagens P2P?
  // - Registrar handlers para certos tipos de mensagens P2P?
}

// Exportar a classe de erro se não estiver em um local compartilhado ainda
// (movido para ./utils/errors.js)
// export class NotInitializedError extends Error {
//   constructor(message) {
//     super(message);
//     this.name = "NotInitializedError";
//   }
// } 