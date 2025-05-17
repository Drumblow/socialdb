import { CoreAPI } from '../CoreAPI.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class AddonManager {
  constructor(coreEventBus, identityManager, networkManager, storageManager) {
    if (!coreEventBus) throw new Error("AddonManager: CoreEventBus é obrigatório.");
    if (!identityManager) throw new Error("AddonManager: IdentityManager é obrigatório.");
    // networkManager e storageManager podem ser passados como undefined se não estiverem prontos/necessários ainda

    this.coreEventBus = coreEventBus; // Para comunicação com o core e para a CoreAPI
    this.identityManager = identityManager; // Para a CoreAPI
    this.networkManager = networkManager; // Para a CoreAPI
    this.storageManager = storageManager; // Para a CoreAPI
    
    // O AddonManager passa a si mesmo para a CoreAPI, para que ela possa, por exemplo,
    // fornecer uma maneira de addons obterem instâncias de outros addons.
    this.coreApi = new CoreAPI(coreEventBus, identityManager, networkManager, storageManager, this);
    
    this.loadedAddons = new Map(); // Para rastrear addons carregados (id -> instance)
    console.log("ADDON_MAN: Instância criada e CoreAPI interna instanciada.");
  }

  async init() {
    console.log("ADDON_MAN: Inicializando AddonManager...");
    try {
      await this.coreApi.init();
      console.log("ADDON_MAN: CoreAPI interna inicializada.");
    } catch (error) {
      console.error("ADDON_MAN: Falha ao inicializar a CoreAPI interna.", error);
      // Decide se o AddonManager deve prosseguir ou falhar aqui.
      // Por enquanto, vamos logar e continuar, mas isso pode ser um erro fatal.
      throw error; // Re-throw para que o chamador saiba que a init falhou
    }
    console.log("ADDON_MAN: AddonManager inicializado com sucesso.");
    // No futuro, pode carregar addons persistidos ou padrão aqui
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
      // import() dinâmico com caminhos relativos é relativo ao arquivo atual,
      // então precisamos de um caminho absoluto ou uma URL file:// para consistência.
      if (addonPath.startsWith('.')) {
        finalAddonPathForImport = path.resolve(process.cwd(), addonPath);
      } else if (!path.isAbsolute(addonPath)) {
        // Se não for relativo (não começa com .) nem absoluto, 
        // pode ser um nome de pacote ou um caminho que o usuário espera ser resolvido da raiz.
        // Por agora, vamos tentar resolver da raiz também, mas isso pode precisar de mais lógica
        // para distinguir de nomes de pacotes reais.
        console.warn(`ADDON_MAN: O caminho do addon "${addonPath}" não é absoluto nem explicitamente relativo. Resolvendo-o a partir da raiz do projeto.`);
        finalAddonPathForImport = path.resolve(process.cwd(), addonPath);
      }
      // else: já é um caminho absoluto, não precisa de process.cwd()

      // Converte para File URL para garantir que o import() dinâmico o trate corretamente, especialmente no Windows.
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
      if (this.loadedAddons.has(addonId)) {
        console.warn(`ADDON_MAN: Addon com ID "${addonId}" de ${addonPath} (resolvido para ${addonFileURL}) já está carregado. Descarregue-o primeiro se desejar recarregar.`);
        return this.loadedAddons.get(addonId).instance;
      }

      console.log(`ADDON_MAN: Chamando initialize() do addon ${addonId} (de ${addonFileURL}) com CoreAPI.`);
      const addonInstance = await addonDefinition.initialize(this.coreApi);
      
      if (addonInstance) {
        console.log(`ADDON_MAN: Addon ${addonId} inicializado com sucesso.`);
        this.loadedAddons.set(addonId, { definition: addonDefinition, instance: addonInstance, path: addonPath }); // Armazena o caminho original
        return addonInstance;
      } else {
        console.warn(`ADDON_MAN: Initialize do addon ${addonId} não retornou uma instância.`);
        return null;
      }

    } catch (error) {
      console.error(`ADDON_MAN: Erro ao carregar ou inicializar addon de ${addonPath} (tentativa com ${finalAddonPathForImport}):`);
      if (error.message) console.error(`  Mensagem: ${error.message}`);
      if (error.stack) console.error(`  Stack: ${error.stack.split('\n').slice(1).join('\n')}`);
      // Se o erro for de módulo não encontrado, pode ser útil logar o CWD.
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        try {
            const cwd = path.resolve(process.cwd()); // Usar o 'path' já importado
            console.error(`  CWD: ${cwd}`);
            console.error(`  Verifique se o caminho "${addonPath}" (resolvido para ${finalAddonPathForImport}) está correto em relação ao diretório de execução ou se é um módulo instalável.`);
        } catch(e_path) {/*ignore*/}
      }
      return null;
    }
  }

  getLoadedAddon(addonId) {
    return this.loadedAddons.get(addonId) || null;
  }

  getAllLoadedAddons() {
    return Array.from(this.loadedAddons.values());
  }

  async unloadAddon(addonId) {
    const loaded = this.loadedAddons.get(addonId);
    if (loaded && loaded.definition && typeof loaded.definition.terminate === 'function') {
      try {
        console.log(`ADDON_MAN: Chamando terminate() do addon ${addonId}`);
        await loaded.definition.terminate();
        console.log(`ADDON_MAN: Addon ${addonId} terminado.`);
      } catch (error) {
        console.error(`ADDON_MAN: Erro ao terminar o addon ${addonId}:`, error.message);
      }
    }
    this.loadedAddons.delete(addonId);
    console.log(`ADDON_MAN: Addon ${addonId} descarregado.`);
    return !this.loadedAddons.has(addonId);
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