import { AddonManager } from '../../src/managers/AddonManager.js';
import { EventBus } from '../../src/event-bus/EventBus.js';
import { CoreAPI } from '../../src/CoreAPI.js'; // Necessário para mock de IdentityManager

// Mock simples para IdentityManager
const createMockIdentityManager = (peerId = 'mock-test-peer-id') => ({
  getPeerId: async () => {
    // console.log("MOCK_ID_MAN: getPeerId chamado, retornando:", peerId);
    return {
      toString: () => peerId
    };
  },
  init: async () => { /* console.log("MOCK_ID_MAN: init chamado."); */ return {}; }, // Mock init
  close: async () => { /* console.log("MOCK_ID_MAN: close chamado."); */ } // Mock close
});

// Mocks para NetworkManager e StorageManager (podem ser null se não usados pela CoreAPI nos testes)
const mockNetworkManager = null; 
const mockStorageManager = null;

const SAMPLE_ADDON_PATH = './addons/sample-addon/index.js'; // Caminho relativo à raiz do projeto

async function runTests() {
  console.log("--- Iniciando testes para AddonManager ---");
  let testsPassed = 0;
  let testsFailed = 0;
  let testsDefined = 0;
  let testsCompleted = 0;

  function test(description, asyncTestFn) {
    testsDefined++;
    console.log(`\n[TEST] ${description}`);
    asyncTestFn()
      .then(() => {
        console.log("  Status: PASSOU");
        testsPassed++;
      })
      .catch(error => {
        console.error("  Status: FALHOU");
        console.error("    Erro:", error.message);
        if (error.stack) console.error("    Stack:", error.stack.split('\n').slice(1).join('\n'));
        testsFailed++;
      })
      .finally(() => {
        testsCompleted++;
        if (testsCompleted === testsDefined) {
          finalizeTests();
        }
      });
  }

  const finalizeTests = () => {
    console.log(`\n--- Resultados dos Testes (AddonManager) ---`);
    console.log(`  Testes Passados: ${testsPassed}`);
    console.log(`  Testes Falhados: ${testsFailed}`);
    if (testsFailed === 0 && testsPassed > 0) {
      console.log("  TODOS OS TESTES DO ADDON_MANAGER PASSARAM! ✅");
      process.exitCode = 0;
    } else if (testsPassed === 0 && testsFailed === 0) {
      console.warn("  NENHUM TESTE DO ADDON_MANAGER FOI EXECUTADO OU ENCONTRADO.");
      process.exitCode = 0; // Ou 1 se isso for um erro
    } else {
      console.error("  ALGUNS TESTES DO ADDON_MANAGER FALHARAM! ❌");
      process.exitCode = 1;
    }
  };
  
  // --- Início dos Testes ---

  test("Deve instanciar e inicializar AddonManager", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    console.assert(addonManager, "AddonManager não foi instanciado.");
    console.assert(addonManager.coreApi instanceof CoreAPI, "AddonManager.coreApi não é uma instância de CoreAPI");
    await addonManager.init();
    // A inicialização do AddonManager agora chama coreApi.init(), que chama identityManager.getPeerId()
    // Se chegou aqui sem erro, a integração básica funcionou.
  });

  test("Deve carregar o sample-addon dinamicamente com sucesso", async () => {
    const mockEventBus = new EventBus();
    const mockPeerIdValue = 'test-dynamic-load-peer-id';
    const mockIdentityManager = createMockIdentityManager(mockPeerIdValue);
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();

    let eventReceived = null;
    mockEventBus.on('addon:sample-addon:initialized', (data) => {
      eventReceived = data;
    });

    const addonInstance = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addonInstance, "Instância do sample-addon não foi retornada.");
    console.assert(addonInstance.status === 'initialized', "Sample-addon não foi inicializado corretamente.");
    console.assert(addonInstance.manifestId === 'sample-addon', "ID do manifest do sample-addon incorreto.");
    console.assert(typeof addonInstance.callMe === 'function', "Função callMe do sample-addon não encontrada.");
    console.assert(addonInstance.callMe() === 'Hello from Sample Addon (sample-addon)!', "Retorno de callMe incorreto.");

    const loadedAddon = addonManager.getLoadedAddon('sample-addon');
    console.assert(loadedAddon, "Sample-addon não encontrado em loadedAddons após o carregamento.");
    console.assert(loadedAddon.instance.manifestId === 'sample-addon', "Instância do addon armazenada é diferente.");
    console.assert(loadedAddon.path === SAMPLE_ADDON_PATH, "Caminho do addon não armazenado corretamente.");
    
    console.assert(eventReceived !== null, "Evento 'addon:sample-addon:initialized' não foi emitido ou capturado.");
    console.assert(eventReceived.peerId === mockPeerIdValue, "PeerId no evento emitido pelo addon está incorreto.");

    // Limpar listener
    mockEventBus.removeAllListeners('addon:sample-addon:initialized');
  });

  test("Deve descarregar o sample-addon com sucesso", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();

    const addonInstance = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addonInstance, "Falha ao carregar sample-addon para teste de unload.");
    const addonId = addonInstance.manifestId;
    console.assert(addonId === 'sample-addon', "ID do addon para unload não é 'sample-addon'.");

    const unloadSuccess = await addonManager.unloadAddon(addonId);
    console.assert(unloadSuccess, "Método unloadAddon não retornou sucesso para sample-addon.");
    
    const loadedAddonAfterUnload = addonManager.getLoadedAddon(addonId);
    console.assert(loadedAddonAfterUnload === null, "Sample-addon ainda encontrado em loadedAddons após descarregar.");
  });

  test("Tentar carregar um addon já carregado deve retornar a instância existente", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();

    const instance1 = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(instance1, "Falha ao carregar sample-addon (1ª vez)");
    
    const instance2 = await addonManager.loadAddon(SAMPLE_ADDON_PATH); // Tenta carregar de novo
    console.assert(instance2, "Falha ao tentar carregar sample-addon (2ª vez)");
    console.assert(instance1 === instance2, "Segunda carga não retornou a mesma instância.");
    console.assert(addonManager.getAllLoadedAddons().length === 1, "Addon foi carregado duas vezes em vez de reutilizar.");

    await addonManager.unloadAddon('sample-addon'); // Limpeza
  });

  test("getAllLoadedAddons deve retornar os addons carregados (usando sample-addon)", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();

    const addon1 = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    // Para ter um segundo addon diferente, precisaríamos de outro arquivo ou modificar o sample-addon para ter ID dinâmico
    // Por agora, vamos focar em testar com um e a contagem correta.
    // Se tentarmos carregar o mesmo de novo, ele não adicionará à lista (pela lógica de não recarregar)

    const allAddons = addonManager.getAllLoadedAddons();
    console.assert(allAddons.length === 1, `Esperado 1 addon, mas obteve ${allAddons.length}`);
    console.assert(allAddons.some(a => a.instance.manifestId === addon1.manifestId), "Sample-addon não encontrado");

    await addonManager.unloadAddon('sample-addon'); // Limpeza
  });

  test("close deve descarregar todos os addons carregados (usando sample-addon)", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();

    await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    // Poderíamos carregar um segundo addon (diferente) aqui se tivéssemos outro para testar múltiplos no close.
    console.assert(addonManager.getAllLoadedAddons().length === 1, "Contagem de addons antes do close incorreta");

    await addonManager.close();
    console.assert(addonManager.getAllLoadedAddons().length === 0, "Addons não foram descarregados após close.");
  });

  test("Deve falhar ao carregar addon com caminho inválido", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon('./non-existent-path/addon.js');
    console.assert(addonInstance === null, "Carregamento de addon inexistente não retornou null.");
  });
  
  test("Deve falhar ao carregar addon que não exporta default", async () => {
    // Precisaria criar um arquivo de addon malformado para este teste.
    // Por enquanto, vamos pular ou simular via mocks internos do AddonManager se fosse o caso.
    // Dado que estamos usando import() real, precisaremos do arquivo.
    // Criando um arquivo temporário para o teste:
    const malformedAddonPath = './addons/malformed-no-default.js';
    const fs = await import('fs/promises');
    const path = await import('path');
    try {
      await fs.mkdir(path.dirname(malformedAddonPath), { recursive: true });
      await fs.writeFile(malformedAddonPath, "export const initialize = () => {};");
      
      const mockEventBus = new EventBus();
      const mockIdentityManager = createMockIdentityManager();
      const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
      await addonManager.init();
      const addonInstance = await addonManager.loadAddon(malformedAddonPath);
      console.assert(addonInstance === null, "Carregamento de addon sem export default não retornou null.");
    } finally {
      await fs.unlink(malformedAddonPath).catch(() => {}); // Limpa o arquivo
    }
  });

  // Adicione mais testes conforme necessário para cobrir outros cenários de erro
  // (sem initialize, sem manifest.id, etc.)

  if (testsDefined === 0) {
      finalizeTests();
  }
}

runTests(); 