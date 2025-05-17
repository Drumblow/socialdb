import { CoreAPI } from '../CoreAPI.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class AddonManager {
  constructor(coreEventBus, identityManager, networkManager, storageManager) {
    if (!coreEventBus) throw new Error("AddonManager: CoreEventBus é obrigatório.");
    if (!identityManager) throw new Error("AddonManager: IdentityManager é obrigatório.");
    // networkManager e storageManager podem ser passados como undefined se não estiverem prontos/necessários ainda

    this.coreEventBus = coreEventBus; 
    this.identityManager = identityManager; 
    this.networkManager = networkManager; 
    this.storageManager = storageManager; 
    
    this.loadedAddons = new Map(); // Para rastrear addons carregados (id -> { definition, instance, coreApi })
    console.log("ADDON_MAN: Instância criada.");
  }

  async init() {
    console.log("ADDON_MAN: Inicializando AddonManager...");
    // Não há mais uma CoreAPI global do AddonManager para inicializar aqui.
    // A CoreAPI de cada addon será inicializada quando o addon for carregado.
    console.log("ADDON_MAN: AddonManager inicializado com sucesso.");
    return Promise.resolve();
  }

  /**
   * Carrega e inicializa um addon a partir de um caminho de módulo.
   * @param {string} addonPath O caminho para o módulo do addon (ex: './addons/meu-addon/index.js').
   * @param {object} [options] Opções adicionais para o carregamento do addon.
   * @returns {Promise<object|null>} A instância do addon carregado ou null em caso de falha.
   */
  async loadAddon(addonPath, options = {}) {
    console.log(`ADDON_MAN: Tentando carregar addon de: ${addonPath}`);
    let finalAddonPathForImport = addonPath;
    try {
      // Validação básica do caminho do addon
      if (typeof addonPath !== 'string' || !addonPath.trim()) {
        console.error("ADDON_MAN: Caminho do addon inválido fornecido.");
        return null;
      }

      // Se o caminho do addon for relativo (ex: './addons/my-addon'), 
      // resolve-o a partir do diretório de trabalho atual (raiz do projeto).
      if (addonPath.startsWith('.')) {
        finalAddonPathForImport = path.resolve(process.cwd(), addonPath);
      } else if (!path.isAbsolute(addonPath)) {
        console.warn(`ADDON_MAN: O caminho do addon "${addonPath}" não é absoluto nem explicitamente relativo. Resolvendo-o a partir da raiz do projeto.`);
        finalAddonPathForImport = path.resolve(process.cwd(), addonPath);
      }
      
      const addonFileURL = pathToFileURL(finalAddonPathForImport).href;

      console.log(`ADDON_MAN: Tentando import() dinâmico de: ${addonFileURL}`);
      const addonModule = await import(addonFileURL);
      
      if (!addonModule || !addonModule.default) {
        console.error(`ADDON_MAN: Addon em ${addonFileURL} não possui uma exportação default válida.`);
        return null;
      }

      const addonDefinition = addonModule.default;

      if (typeof addonDefinition.initialize !== 'function') {
        console.error(`ADDON_MAN: Addon em ${addonFileURL} não exporta uma função initialize válida.`);
        return null;
      }
      if (!addonDefinition.manifest || !addonDefinition.manifest.id) {
        console.error(`ADDON_MAN: Addon em ${addonFileURL} não possui um manifest com ID válido.`);
        return null;
      }
      if (typeof addonDefinition.manifest.id !== 'string' || !addonDefinition.manifest.id.trim()) {
        console.error(`ADDON_MAN: ID do manifest do addon em ${addonFileURL} é inválido.`);
        return null;
      }

      const addonId = addonDefinition.manifest.id;
      const addonPermissions = addonDefinition.manifest.permissions || []; // Etapa futura

      if (this.loadedAddons.has(addonId)) {
        console.warn(`ADDON_MAN: Addon com ID "${addonId}" de ${addonPath} (resolvido para ${addonFileURL}) já está carregado. Descarregue-o primeiro se desejar recarregar.`);
        return this.loadedAddons.get(addonId).instance;
      }

      // Criar uma instância da CoreAPI específica para este addon
      // Passando o AddonManager (this) para que a CoreAPI possa, se necessário, chamar de volta o AddonManager
      // (por exemplo, para obter outros addons - getAddonInstance)
      const addonCoreApi = new CoreAPI(
        this.coreEventBus, 
        this.identityManager, 
        this.networkManager, 
        this.storageManager, 
        this, // Passa a instância do AddonManager
        addonId, // Passa o ID do addon
        addonPermissions // Passa as permissões (para uso futuro)
      );

      console.log(`ADDON_MAN: Inicializando CoreAPI para o addon ${addonId}...`);
      await addonCoreApi.init(); // Inicializa a CoreAPI específica do addon
      console.log(`ADDON_MAN: CoreAPI para o addon ${addonId} inicializada.`);

      const addonContext = { id: addonId };
      console.log(`ADDON_MAN: Chamando initialize() do addon ${addonId} (de ${addonFileURL}) com sua CoreAPI e context.`);
      const addonInstance = await addonDefinition.initialize(addonCoreApi, addonContext);
      
      if (addonInstance) {
        console.log(`ADDON_MAN: Addon ${addonId} inicializado com sucesso.`);
        this.loadedAddons.set(addonId, { 
          definition: addonDefinition, 
          instance: addonInstance, 
          path: addonPath,
          coreApi: addonCoreApi // Armazena a instância da CoreAPI do addon
        });
        return addonInstance;
      } else {
        console.warn(`ADDON_MAN: Initialize do addon ${addonId} não retornou uma instância. O addon não será considerado carregado.`);
        // Se addonCoreApi tiver um método de 'close' ou 'destroy', poderia ser chamado aqui.
        return null;
      }

    } catch (error) {
      console.error(`ADDON_MAN: Erro ao carregar ou inicializar addon de ${addonPath} (tentativa com ${finalAddonPathForImport}):`);
      if (error.message) console.error(`  Mensagem: ${error.message}`);
      if (error.stack) console.error(`  Stack: ${error.stack.split('\n').slice(1).join('\n')}`);
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        try {
            const cwd = path.resolve(process.cwd());
            console.error(`  CWD: ${cwd}`);
            console.error(`  Verifique se o caminho "${addonPath}" (resolvido para ${finalAddonPathForImport}) está correto em relação ao diretório de execução ou se é um módulo instalável.`);
        } catch(e_path) {/*ignore*/}
      }
      return null;
    }
  }

  getLoadedAddon(addonId) {
    const loadedInfo = this.loadedAddons.get(addonId);
    return loadedInfo ? loadedInfo : null; // Retorna o objeto todo, não apenas a instância
  }

  getAllLoadedAddons() {
    return Array.from(this.loadedAddons.values());
  }

  async unloadAddon(addonId) {
    const loaded = this.loadedAddons.get(addonId);
    if (loaded) {
      if (loaded.definition && typeof loaded.definition.terminate === 'function') {
        try {
          console.log(`ADDON_MAN: Chamando terminate() do addon ${addonId}`);
          // O terminate do addon pode precisar da sua instância da CoreAPI ou do context
          // Por enquanto, passamos undefined, mas isso pode ser revisto.
          await loaded.definition.terminate(loaded.coreApi, { id: addonId }); 
          console.log(`ADDON_MAN: Addon ${addonId} terminado.`);
        } catch (error) {
          console.error(`ADDON_MAN: Erro ao terminar o addon ${addonId}:`, error.message);
        }
      }
      // Se a CoreAPI específica do addon tiver um método close/destroy, chamar aqui.
      // Ex: if (loaded.coreApi && typeof loaded.coreApi.close === 'function') { await loaded.coreApi.close(); }
      this.loadedAddons.delete(addonId);
      console.log(`ADDON_MAN: Addon ${addonId} descarregado.`);
      return !this.loadedAddons.has(addonId);
    }
    console.warn(`ADDON_MAN: Tentativa de descarregar addon não carregado: ${addonId}`);
    return false;
  }

  async close() {
    console.log("ADDON_MAN: Fechando AddonManager e descarregando todos os addons...");
    const addonIds = Array.from(this.loadedAddons.keys());
    for (const addonId of addonIds) {
      await this.unloadAddon(addonId);
    }
    console.log("ADDON_MAN: AddonManager fechado.");
  }
} 