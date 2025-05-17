import { NotInitializedError } from './utils/errors.js';

export class CoreAPI {
  constructor(eventBus, identityManager, networkManager, storageManager, addonManager) {
    if (!eventBus) throw new Error("CoreAPI: EventBus é obrigatório.");
    if (!identityManager) throw new Error("CoreAPI: IdentityManager é obrigatório.");
    // NetworkManager, StorageManager e AddonManager podem ser opcionais ou adicionados depois
    // dependendo das funcionalidades que a CoreAPI precisará expor.

    this.eventBus = eventBus;
    this.identityManager = identityManager;
    this.networkManager = networkManager; // Para futuras interações de rede via addons
    this.storageManager = storageManager; // Para futuras interações de armazenamento via addons
    this.addonManager = addonManager;     // Para addons interagirem com outros addons (com cautela)
    
    this._peerId = null;
    console.log("CoreAPI: Instância criada.");
  }

  async init() {
    // É importante que o IdentityManager esteja inicializado para termos o PeerId.
    if (this.identityManager && typeof this.identityManager.getPeerId === 'function') {
      this._peerId = await this.identityManager.getPeerId();
      if (!this._peerId) {
        console.warn("CoreAPI: PeerId não pôde ser obtido na inicialização da CoreAPI. Algumas funcionalidades podem não operar corretamente até que o PeerId esteja disponível.");
      }
    } else {
        console.error("CoreAPI: IdentityManager não está configurado corretamente ou não foi inicializado antes da CoreAPI.");
        throw new NotInitializedError("CoreAPI: IdentityManager inválido ou não inicializado.");
    }
    console.log("CoreAPI: Inicializada.");
  }

  log(message) {
    // Adiciona um prefixo para identificar logs vindos de addons através da CoreAPI
    console.log(`CORE_API [ADDON]: ${message}`);
  }

  getPeerId() {
    if (!this._peerId) {
      // Tenta obter novamente caso tenha falhado na init ou se o IdentityManager o obtém tardiamente.
      // Essa lógica pode precisar de refinamento dependendo de como o PeerId é gerenciado.
      if (this.identityManager && typeof this.identityManager.getPeerId === 'function') {
          const currentPeerId = this.identityManager.getPeerId(); // Assumindo que getPeerId pode retornar o valor já resolvido
          if (currentPeerId instanceof Promise) {
            console.warn("CoreAPI: getPeerId chamado, mas o PeerId ainda é uma Promise. O addon deve aguardar a resolução do PeerId.");
            // Idealmente, o addon deve verificar se o core está pronto ou a CoreAPI emitir um evento.
            return null; 
          }
          this._peerId = currentPeerId;
      }
    }
    if (!this._peerId) {
        console.warn("CoreAPI: PeerId ainda não disponível.");
        return null;
    }
    return this._peerId.toString();
  }

  // Expor o EventBus para que addons possam emitir e ouvir eventos
  getEventBus() {
    return this.eventBus;
  }

  // Exemplo de como um addon poderia acessar outro (de forma controlada)
  getAddonInstance(addonId) {
    if (this.addonManager) {
      const loadedAddon = this.addonManager.getLoadedAddon(addonId);
      return loadedAddon ? loadedAddon.instance : null;
    }
    console.warn("CoreAPI: AddonManager não disponível para getAddonInstance.");
    return null;
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