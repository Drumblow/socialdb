import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Para obter o diretório atual do módulo ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const manifestPath = path.join(__dirname, 'manifest.json');
let stremioBridgeManifestData = {};
try {
  stremioBridgeManifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
} catch (err) {
  console.error(`StremioBridgeAddon: Falha crítica ao carregar seu próprio manifest.json em ${manifestPath}`, err);
  // Se o addon não consegue carregar seu próprio manifesto, é um erro grave.
  // Poderíamos lançar o erro aqui para impedir o carregamento do addon.
  // Por enquanto, o AddonManager detectaria um ID de manifesto inválido se stremioBridgeManifestData.id não existir.
  stremioBridgeManifestData = { id: 'stremio-bridge-addon-load-error', name: 'Error Loading Manifest' }; // Fallback
}

// loadedStremioAddons permanece global do módulo, pois armazena dados dos addons Stremio descobertos.
const loadedStremioAddons = new Map();

/**
 * Busca e analisa um manifesto de addon Stremio a partir de uma URL.
 * Esta função agora usa a coreApi passada como argumento.
 * @param {object} passedCoreApi A instância da CoreAPI a ser usada para logging e httpClientGet.
 * @param {string} manifestUrl A URL do manifesto do addon Stremio.
 * @returns {Promise<{manifest: object, baseUrl: string}|null>} O manifesto parseado e a URL base, ou null em caso de erro.
 */
async function fetchAndParseStremioManifest(passedCoreApi, manifestUrl) {
  if (!passedCoreApi || typeof passedCoreApi.httpClientGet !== 'function' || typeof passedCoreApi.log !== 'function') {
    console.error('StremioBridgeAddon: Instância CoreAPI inválida ou não fornecida para fetchAndParseStremioManifest.');
    return null;
  }
  try {
    const manifest = await passedCoreApi.httpClientGet(manifestUrl);
    passedCoreApi.log(`StremioBridgeAddon: Raw manifest object received by fetchAndParseStremioManifest from ${manifestUrl}: ${JSON.stringify(manifest)}`);

    if (manifest && manifest.id) {
      passedCoreApi.log(`StremioBridgeAddon: Manifesto Stremio (name: '${manifest.name}', id: '${manifest.id}') de ${manifestUrl} parece válido. BaseURL será: ${new URL(manifestUrl).origin}`);
      const baseUrl = new URL(manifestUrl).origin;
      return { manifest, baseUrl };
    } else {
      passedCoreApi.log(`StremioBridgeAddon: Manifest de ${manifestUrl} é inválido (sem id ou nulo). Manifesto recebido: ${JSON.stringify(manifest)}`);
      return null;
    }
  } catch (error) {
    const errorMessage = `StremioBridgeAddon: Erro DENTRO do try/catch de fetchAndParseStremioManifest para ${manifestUrl}. Error: ${error.message}, Stack: ${error.stack}`;
    // Tenta logar com a CoreAPI fornecida, se possível, senão usa console.error
    if (passedCoreApi && typeof passedCoreApi.log === 'function') {
        passedCoreApi.log(errorMessage);
    } else {
        console.error(`StremioBridgeAddon CRITICAL: CoreAPI indisponível no catch de fetchAndParseStremioManifest! Erro original: ${error.message}`);
    }
    console.error(errorMessage); // Logar sempre no console.error para garantir visibilidade
    return null;
  }
}

async function initialize(coreApi, addonContext) {
  coreApi.log(`StremioBridgeAddon (ID: ${stremioBridgeManifestData.id || addonContext.addonId}) inicializando com instância CoreAPI específica.`);

  const cinemetaManifestUrl = 'https://v3-cinemeta.strem.io/manifest.json';
  coreApi.log(`StremioBridgeAddon: Tentando carregar manifesto Stremio de ${cinemetaManifestUrl} usando CoreAPI específica.`);
  
  const cinemetaData = await fetchAndParseStremioManifest(coreApi, cinemetaManifestUrl); 
  
  coreApi.log(`StremioBridgeAddon: cinemetaData recebido na initialize: ${JSON.stringify(cinemetaData)}`);

  if (cinemetaData && cinemetaData.manifest && cinemetaData.manifest.id) {
    loadedStremioAddons.set(cinemetaData.manifest.id, { manifest: cinemetaData.manifest, baseUrl: cinemetaData.baseUrl });
    coreApi.log(`StremioBridgeAddon: Adicionado '${cinemetaData.manifest.name}' (ID: ${cinemetaData.manifest.id}, Base URL: ${cinemetaData.baseUrl}) à lista de addons Stremio disponíveis.`);
  } else {
    coreApi.log(`StremioBridgeAddon: Falha ao carregar ou parsear manifesto de ${cinemetaManifestUrl}. cinemetaData: ${JSON.stringify(cinemetaData)}`);
  }

  // Funções da API definidas aqui para capturar a 'coreApi' desta inicialização específica.
  const addonFunctionsForThisInstance = {
    getAvailableStremioAddons() {
      if (!coreApi) {
          console.error('StremioBridgeAddon: Instância CoreAPI (capturada) não disponível para getAvailableStremioAddons.');
          return [];
      }
      coreApi.log('StremioBridgeAddon: getAvailableStremioAddons chamado (usando CoreAPI específica).');
      const addonsList = [];
      for (const entry of loadedStremioAddons.values()) {
        addonsList.push({
          id: entry.manifest.id,
          name: entry.manifest.name,
          version: entry.manifest.version,
          description: entry.manifest.description,
        });
      }
      return addonsList;
    },
    async getStremioCatalog(stremioAddonId, catalogType, catalogId, options = {}) {
      if (!coreApi) {
        console.error('StremioBridgeAddon: Instância CoreAPI (capturada) não disponível para getStremioCatalog.');
        return null;
      }
      coreApi.log(`StremioBridgeAddon: getStremioCatalog chamado para ${stremioAddonId} (usando CoreAPI específica).`);
      const addonData = loadedStremioAddons.get(stremioAddonId);
      if (!addonData || !addonData.manifest || !addonData.baseUrl) {
        coreApi.log(`StremioBridgeAddon: Addon Stremio com ID '${stremioAddonId}' ou sua baseUrl não encontrado para getStremioCatalog.`);
        return null;
      }
      let catalogUrl = `${addonData.baseUrl}/catalog/${catalogType}/${catalogId}`;
      const extraProps = [];
      if (options.skip) extraProps.push(`skip=${options.skip}`);
      if (options.genre) extraProps.push(`genre=${options.genre}`);
      if (options.search) extraProps.push(`search=${encodeURIComponent(options.search)}`);
      if (extraProps.length > 0) catalogUrl += `/${extraProps.join('/')}`;
      catalogUrl += '.json';
      coreApi.log(`StremioBridgeAddon: Buscando catálogo de ${stremioAddonId}: ${catalogUrl}`);
      try {
        const catalogData = await coreApi.httpClientGet(catalogUrl);
        if (catalogData) {
          coreApi.log(`StremioBridgeAddon: Catálogo para ${stremioAddonId} - ${catalogType} - ${catalogId} recebido.`);
          return catalogData;
        } else {
          coreApi.log(`StremioBridgeAddon: httpClientGet não retornou dados de catálogo para ${catalogUrl}`);
          return null;
        }
      } catch (error) {
        coreApi.log(`StremioBridgeAddon: Erro ao buscar ou analisar catálogo Stremio de ${catalogUrl}: ${error.message}`);
        return null;
      }
    },
    async getStremioStreams(stremioAddonId, mediaType, mediaId) {
      if (!coreApi) {
        console.error('StremioBridgeAddon: Instância CoreAPI (capturada) não disponível para getStremioStreams.');
        return null;
      }
      coreApi.log(`StremioBridgeAddon: getStremioStreams chamado para ${stremioAddonId} - ${mediaType}:${mediaId} (usando CoreAPI específica).`);
      const addonData = loadedStremioAddons.get(stremioAddonId);
      if (!addonData || !addonData.manifest || !addonData.baseUrl) {
        coreApi.log(`StremioBridgeAddon: Addon Stremio com ID '${stremioAddonId}' ou sua baseUrl não encontrado para getStremioStreams.`);
        return null;
      }

      // Validação básica dos tipos de media suportados pelo Cinemeta (exemplo)
      // Addons Stremio podem definir seus próprios tipos em `manifest.types`
      if (addonData.manifest.id === 'com.linvo.cinemeta' && !['movie', 'series'].includes(mediaType)) {
        coreApi.log(`StremioBridgeAddon: Tipo de mídia '${mediaType}' não é diretamente suportado para streams do Cinemeta (esperado 'movie' ou 'series').`);
        // Algumas implementações de stream podem não necessitar disso ou lidar de forma diferente
        // return null; // Decide-se se retorna null ou tenta mesmo assim.
      }

      const streamsUrl = `${addonData.baseUrl}/stream/${mediaType}/${mediaId}.json`;
      coreApi.log(`StremioBridgeAddon: Buscando streams de ${stremioAddonId}: ${streamsUrl}`);

      try {
        const streamsData = await coreApi.httpClientGet(streamsUrl);
        if (streamsData && Array.isArray(streamsData.streams)) {
          coreApi.log(`StremioBridgeAddon: Streams para ${mediaType}:${mediaId} de ${stremioAddonId} recebidos. Quantidade: ${streamsData.streams.length}`);
          return streamsData; // Geralmente { streams: [...] }
        } else {
          coreApi.log(`StremioBridgeAddon: Resposta de streams inválida ou sem array 'streams' para ${streamsUrl}. Data: ${JSON.stringify(streamsData)}`);
          // Alguns addons podem retornar um array vazio diretamente, o que é válido. Outros, um objeto com streams: [].
          // Se streamsData for null ou não tiver .streams, consideramos falha na obtenção de uma lista de streams válida.
          return { streams: [] }; // Retornar um objeto de streams vazio em caso de falha leve ou nenhum stream
        }
      } catch (error) {
        coreApi.log(`StremioBridgeAddon: Erro ao buscar ou analisar streams de ${streamsUrl}: ${error.message}`);
        return null; // Erro crítico na busca
      }
    }
  };

  return {
    status: 'initialized',
    manifestId: stremioBridgeManifestData.id || addonContext.addonId,
    ...addonFunctionsForThisInstance
  };
}

export default {
  manifest: stremioBridgeManifestData,
  initialize, // Exporta a função initialize refatorada
  async terminate(coreApi, context) { // coreApi e context são passados pelo AddonManager
    const addonIdForLog = coreApi ? coreApi.addonId : (stremioBridgeManifestData.id || (context ? context.id : 'unknown'));
    const logPrefix = `StremioBridgeAddon (ID: ${addonIdForLog})`;

    if (coreApi && typeof coreApi.log === 'function') {
      coreApi.log(`${logPrefix}: Encerrando... (terminate chamado)`);
    } else {
      console.log(`${logPrefix}: Encerrando... (terminate chamado, CoreAPI não disponível para log via coreApi.log)`);
    }
    loadedStremioAddons.clear();
    // Não há mais coreApiInstance global para anular aqui referente às funções da API.
  }
}; 