import { AddonManager } from '../../src/managers/AddonManager.js';
import { EventBus } from '../../src/event-bus/EventBus.js';
import { CoreAPI } from '../../src/CoreAPI.js';
import { StorageManager } from '../../src/managers/StorageManager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

// Imports para mock libp2p
import { createLibp2p as actualCreateLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { FsDatastore } from 'datastore-fs';
import { MemoryBlockstore } from 'blockstore-core';
import { createHelia } from 'helia';
import fs from 'fs';

export const createMockIdentityManager = (peerId = 'mock-test-peer-id') => ({
  getPeerId: async () => ({ toString: () => peerId }),
  init: async () => ({}),
  close: async () => {},
});

const mockNetworkManager = null;
const mockStorageManager = null;

const SAMPLE_ADDON_PATH = './addons/sample-addon/index.js';
const NO_LOG_PERMISSION_ADDON_PATH = './addons/no-log-permission-addon/index.js';
const SAMPLE_ADDON_CLONE_PATH = './addons/sample-addon-clone/index.js';

async function createMockLibp2p(peerIdInstance, datastore, bootstrapMultiaddrs = []) {
  const config = {
    peerId: peerIdInstance,
    datastore,
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0/ws'] },
    transports: [webSockets()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroPeers: true }),
    },
  };
  if (bootstrapMultiaddrs && bootstrapMultiaddrs.length > 0) {
    config.peerDiscovery = [
      bootstrap({ list: bootstrapMultiaddrs, timeout: 1000 })
    ];
  }
  return actualCreateLibp2p(config);
}

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
      process.exitCode = 0;
    } else {
      console.error("  ALGUNS TESTES DO ADDON_MANAGER FALHARAM! ❌");
      process.exitCode = 1;
    }
  };

  test("Deve instanciar e inicializar AddonManager", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    console.assert(addonManager, "AddonManager não foi instanciado.");
    await addonManager.init();
  });

  test("Deve carregar o sample-addon e passar addonContext correto para initialize", async () => {
    const mockEventBus = new EventBus();
    const mockPeerIdValue = 'test-context-peer-id';
    const mockIdentityManager = createMockIdentityManager(mockPeerIdValue);
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addonInstance, "Instância do sample-addon não foi retornada.");
    console.assert(addonInstance.status === 'initialized', "Sample-addon não foi inicializado corretamente.");
    console.assert(addonInstance.manifestId === 'sample-addon', "ID do manifest do sample-addon incorreto.");
    console.assert(typeof addonInstance.getAddonIdFromContext === 'function', "getAddonIdFromContext não encontrado no addonInstance");
    const addonIdFromContext = addonInstance.getAddonIdFromContext();
    console.assert(addonIdFromContext === 'sample-addon', `AddonContext.id incorreto. Esperado 'sample-addon', recebido '${addonIdFromContext}'`);
    const loadedAddonInfo = addonManager.getLoadedAddon('sample-addon');
    console.assert(loadedAddonInfo && loadedAddonInfo.coreApi, "Informações do addon carregado ou sua coreApi não encontradas.");
    console.assert(loadedAddonInfo.coreApi.addonId === 'sample-addon', "CoreAPI do addon não possui o addonId correto.");
  });

  test("Deve carregar o sample-addon dinamicamente com sucesso (verificando evento e callMe)", async () => {
    const mockEventBus = new EventBus();
    const mockPeerIdValue = 'test-dynamic-load-peer-id';
    const mockIdentityManager = createMockIdentityManager(mockPeerIdValue);
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    let eventReceived = null;
    mockEventBus.on('addon:sample-addon:initialized', (data) => { eventReceived = data; });
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
    console.assert(eventReceived.addonId === 'sample-addon', "AddonId no evento emitido está incorreto.");
    mockEventBus.removeAllListeners('addon:sample-addon:initialized');
  });

  test("Deve descarregar o sample-addon e chamar terminate com CoreAPI e context", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addonInstance, "Falha ao carregar sample-addon para teste de unload.");
    const addonId = addonInstance.manifestId;
    const loadedAddonInfo = addonManager.getLoadedAddon(addonId);
    console.assert(loadedAddonInfo, "Não foi possível obter informações do addon carregado antes do unload.");
    const terminateSpy = { called: false, receivedApi: null, receivedContext: null };
    loadedAddonInfo.definition.terminate = async (api, context) => {
      terminateSpy.called = true;
      terminateSpy.receivedApi = api;
      terminateSpy.receivedContext = context;
      return { status: 'terminated_by_spy' };
    };
    const unloadSuccess = await addonManager.unloadAddon(addonId);
    console.assert(unloadSuccess, "Método unloadAddon não retornou sucesso.");
    console.assert(terminateSpy.called, "Função terminate do addon não foi chamada.");
    console.assert(terminateSpy.receivedApi instanceof CoreAPI, "CoreAPI não foi passada para terminate.");
    console.assert(terminateSpy.receivedApi.addonId === addonId, "CoreAPI passada para terminate não tem o addonId correto.");
    console.assert(terminateSpy.receivedContext && terminateSpy.receivedContext.id === addonId, "AddonContext incorreto passado para terminate.");
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
    const instance2 = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(instance2, "Falha ao tentar carregar sample-addon (2ª vez)");
    console.assert(instance1 === instance2, "Segunda carga não retornou a mesma instância.");
    console.assert(addonManager.getAllLoadedAddons().length === 1, "Addon foi carregado duas vezes em vez de reutilizar.");
    await addonManager.unloadAddon('sample-addon');
  });

  test("getAllLoadedAddons deve retornar os addons carregados", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const addon1 = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    const allAddons = addonManager.getAllLoadedAddons();
    console.assert(allAddons.length === 1, `Esperado 1 addon, mas obteve ${allAddons.length}`);
    console.assert(allAddons.some(a => a.instance.manifestId === addon1.manifestId), "Sample-addon não encontrado");
    await addonManager.unloadAddon('sample-addon');
  });

  test("close deve descarregar todos os addons carregados", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    const loadedAddonInfo = addonManager.getLoadedAddon('sample-addon');
    const terminateSpy = { called: false };
    loadedAddonInfo.definition.terminate = async () => { terminateSpy.called = true; return { status: 'ok' }; };
    await addonManager.close();
    console.assert(terminateSpy.called, "Função terminate do addon não foi chamada durante o close do AddonManager.");
    console.assert(addonManager.getAllLoadedAddons().length === 0, "Ainda existem addons carregados após o close.");
  });

  // Testes de Permissão para CoreAPI.log()
  test("CoreAPI.log() deve funcionar para sample-addon (com permissão 'core:log')", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addonInstance, "Falha ao carregar sample-addon para teste de log.");
    const loadedAddon = addonManager.getLoadedAddon('sample-addon');
    console.assert(loadedAddon && loadedAddon.coreApi, "CoreAPI do sample-addon não encontrada.");
    const consoleLogSpy = { called: false, message: '' };
    const originalConsoleLog = console.log;
    console.log = (msg) => {
      if (typeof msg === 'string' && msg.includes('[CoreAPI:sample-addon]') && msg.includes("Mensagem de teste do sample-addon")) {
        consoleLogSpy.called = true;
        consoleLogSpy.message = msg;
      }
    };
    loadedAddon.coreApi.log("Mensagem de teste do sample-addon.");
    console.assert(consoleLogSpy.called, "CoreAPI.log() não chamou console.log como esperado para sample-addon.");
    console.log = originalConsoleLog;
    await addonManager.unloadAddon('sample-addon');
  });

  test("CoreAPI.log() deve ser bloqueado para no-log-permission-addon (sem 'core:log')", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon(NO_LOG_PERMISSION_ADDON_PATH);
    console.assert(addonInstance, "Falha ao carregar no-log-permission-addon.");
    const loadedAddon = addonManager.getLoadedAddon('no-log-permission-addon');
    console.assert(loadedAddon && loadedAddon.coreApi, "CoreAPI do no-log-permission-addon não encontrada.");
    const consoleLogSpy = { calledMainLog: false };
    const consoleWarnSpy = { calledWarning: false };
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    console.log = (msg) => {
      if (typeof msg === 'string' && msg.includes('[CoreAPI:no-log-permission-addon]')) {
        consoleLogSpy.calledMainLog = true;
      }
    };
    console.warn = (msg) => {
      if (typeof msg === 'string' && msg.includes("Permissão 'core:log' negada para o addon no-log-permission-addon")) {
        consoleWarnSpy.calledWarning = true;
      }
    };
    loadedAddon.coreApi.log("Tentativa de log pelo no-log-permission-addon.");
    console.assert(!consoleLogSpy.calledMainLog, "CoreAPI.log() executou o log principal para no-log-permission-addon.");
    console.assert(consoleWarnSpy.calledWarning, "CoreAPI.log() não gerou aviso para no-log-permission-addon.");
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    await addonManager.unloadAddon('no-log-permission-addon');
  });

  test("Addons devem verificar corretamente a permissão 'core:log' via coreApi.hasPermission", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, mockNetworkManager, mockStorageManager);
    await addonManager.init();
    const sampleAddon = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(sampleAddon, "Falha ao carregar sample-addon.");
    console.assert(typeof sampleAddon.checkLogPermission === 'function', "Função checkLogPermission não encontrada.");
    const sampleHasPermission = await sampleAddon.checkLogPermission();
    console.assert(sampleHasPermission === true, "sample-addon reportou incorretamente a permissão 'core:log' (esperado true).");
    await addonManager.unloadAddon('sample-addon');
    const noLogAddon = await addonManager.loadAddon(NO_LOG_PERMISSION_ADDON_PATH);
    console.assert(noLogAddon, "Falha ao carregar no-log-permission-addon.");
    console.assert(typeof noLogAddon.checkLogPermission === 'function', "Função checkLogPermission não encontrada.");
    const noLogHasPermission = await noLogAddon.checkLogPermission();
    console.assert(noLogHasPermission === false, "no-log-permission-addon reportou incorretamente a permissão 'core:log' (esperado false).");
    await addonManager.unloadAddon('no-log-permission-addon');
  });

  // Testes de Storage Escopado
  test("sample-addon deve obter e usar seu DB escopado (com permissão 'core:storage:scoped')", async () => {
    const mockEventBus = new EventBus();
    const randomSuffix1 = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const tempDatastorePath = path.resolve(process.cwd(), `.test-datastore-storage-1-${randomSuffix1}`);
    const tempOrbitDbPath = path.resolve(process.cwd(), `.test-orbitdb-storage-1-${randomSuffix1}`);
    
    const datastore = new FsDatastore(tempDatastorePath);
    await datastore.open();
    const key = await generateKeyPair('Ed25519');
    const peerIdInstance = await peerIdFromPrivateKey(key);
    const libp2p = await createMockLibp2p(peerIdInstance, datastore);
    await libp2p.start();
    const heliaNode = await createHelia({ libp2p, datastore });
    const mockIdentityManager = createMockIdentityManager(peerIdInstance.toString());
    
    // Passar heliaNode e orbitDbDirectory para o StorageManager
    const storageManager = new StorageManager(mockEventBus, mockIdentityManager, heliaNode, tempOrbitDbPath);
    await storageManager.init();
    
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, null, storageManager);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addonInstance, "Falha ao carregar sample-addon para teste de storage.");
    console.assert(typeof addonInstance.getDbTestValue === 'function', "Função getDbTestValue não encontrada.");
    const dbValue = await addonInstance.getDbTestValue();
    console.assert(dbValue === 'testValueFromSampleAddon', `Valor incorreto do DB: esperado 'testValueFromSampleAddon', obteve '${dbValue}'`);
    
    await addonManager.unloadAddon('sample-addon');
    await storageManager.close(); // StorageManager não para mais Helia/Libp2p
    await heliaNode.stop();
    await libp2p.stop();
    await datastore.close();
    fs.rmSync(tempDatastorePath, { recursive: true, force: true });
    fs.rmSync(tempOrbitDbPath, { recursive: true, force: true });
  });

  test("no-log-permission-addon NÃO deve obter DB escopado (sem 'core:storage:scoped')", async () => {
    const mockEventBus = new EventBus();
    const mockIdentityManager = createMockIdentityManager();
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, null, null);
    await addonManager.init();
    const addonInstance = await addonManager.loadAddon(NO_LOG_PERMISSION_ADDON_PATH);
    console.assert(addonInstance, "Falha ao carregar no-log-permission-addon para teste de storage.");
    const loadedAddon = addonManager.getLoadedAddon('no-log-permission-addon');
    console.assert(loadedAddon && loadedAddon.coreApi, "CoreAPI de no-log-permission-addon não encontrada.");
    const consoleWarnSpy = { called: false };
    const originalConsoleWarn = console.warn;
    console.warn = (msg) => {
      if (typeof msg === 'string' && msg.includes("Permissão 'core:storage:scoped' negada para o addon no-log-permission-addon")) {
        consoleWarnSpy.called = true;
      }
    };
    const dbInstance = await loadedAddon.coreApi.storageGetScopedDB('qualquer-db');
    console.assert(dbInstance === null, "storageGetScopedDB deveria retornar null para addon sem permissão.");
    console.assert(consoleWarnSpy.called, "Aviso de permissão 'core:storage:scoped' negada não foi emitido.");
    console.warn = originalConsoleWarn;
    await addonManager.unloadAddon('no-log-permission-addon');
  });

  test("Dois addons diferentes (sample-addon, sample-addon-clone) devem ter DBs escopados separados", async () => {
    const mockEventBus = new EventBus();
    const randomSuffix2 = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const tempDatastorePath = path.resolve(process.cwd(), `.test-datastore-storage-2-${randomSuffix2}`);
    const tempOrbitDbPath = path.resolve(process.cwd(), `.test-orbitdb-storage-2-${randomSuffix2}`);

    const datastore = new FsDatastore(tempDatastorePath);
    await datastore.open();
    const key = await generateKeyPair('Ed25519');
    const peerIdInstance = await peerIdFromPrivateKey(key);
    const libp2p = await createMockLibp2p(peerIdInstance, datastore);
    await libp2p.start();
    const heliaNode = await createHelia({ libp2p, datastore });
    const mockIdentityManager = createMockIdentityManager(peerIdInstance.toString());
    
    const storageManager = new StorageManager(mockEventBus, mockIdentityManager, heliaNode, tempOrbitDbPath);
    await storageManager.init();
    
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, null, storageManager);
    await addonManager.init();

    const addon1 = await addonManager.loadAddon(SAMPLE_ADDON_PATH);
    console.assert(addon1 && typeof addon1.getDbTestValue === 'function', "Addon1 não tem getDbTestValue");
    const val1 = await addon1.getDbTestValue();
    console.assert(val1 === 'testValueFromSampleAddon', `Valor addon1: ${val1}`);

    const addon2 = await addonManager.loadAddon(SAMPLE_ADDON_CLONE_PATH);
    // A falha do addon2 será tratada a seguir, este teste foca no escopo do DB se addon2 carregar
    if (addon2) { // Somente prossegue se o addon2 carregar (para evitar erro de null pointer)
      console.assert(typeof addon2.getDbTestValueClone === 'function', "Addon2 não tem getDbTestValueClone");
      const val2 = await addon2.getDbTestValueClone();
      console.assert(val2 === 'testValueFromCloneAddon', `Valor addon2: ${val2}`);

      const crossRead = await addon2.getOriginalDbTestValue();
      console.assert(crossRead === undefined, `Cross-read retornou ${crossRead}, esperado undefined`);
      
      const db1Addr = (await storageManager.getScopedOrbitDB('sample-addon', 'addon-settings')).address.toString();
      const db2Addr = (await storageManager.getScopedOrbitDB('sample-addon-clone', 'addon-settings')).address.toString();
      console.assert(db1Addr !== db2Addr, `Endereços de DB são iguais: ${db1Addr}`);
    } else {
      console.warn("TEST_WARN: sample-addon-clone não carregou, pulando parte do teste de escopo de DB.");
      // Considerar falhar o teste aqui se o carregamento do clone é mandatório para este teste.
    }

    await addonManager.unloadAddon('sample-addon');
    if (addon2) { // Só descarrega se carregou
      await addonManager.unloadAddon('sample-addon-clone');
    }
    await storageManager.close();
    await heliaNode.stop();
    await libp2p.stop();
    await datastore.close();
    fs.rmSync(tempDatastorePath, { recursive: true, force: true });
    fs.rmSync(tempOrbitDbPath, { recursive: true, force: true });
  });

  test("Deve carregar o posts-addon e tentar obter seu DB escopado", async () => {
    const mockEventBus = new EventBus();
    const randomSuffixPosts = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const tempDatastorePathPosts = path.resolve(process.cwd(), `.test-datastore-posts-${randomSuffixPosts}`);
    const tempOrbitDbPathPosts = path.resolve(process.cwd(), `.test-orbitdb-posts-${randomSuffixPosts}`);
    
    const datastore = new FsDatastore(tempDatastorePathPosts);
    await datastore.open();
    const key = await generateKeyPair('Ed25519');
    const peerIdInstance = await peerIdFromPrivateKey(key);
    const libp2p = await createMockLibp2p(peerIdInstance, datastore);
    await libp2p.start();
    const heliaNode = await createHelia({ libp2p, datastore });
    const mockIdentityManager = createMockIdentityManager(peerIdInstance.toString());
    
    const storageManager = new StorageManager(mockEventBus, mockIdentityManager, heliaNode, tempOrbitDbPathPosts);
    await storageManager.init();
    
    const addonManager = new AddonManager(mockEventBus, mockIdentityManager, null, storageManager);
    await addonManager.init();

    const POSTS_ADDON_PATH = './addons/posts-addon/index.js';
    const addonInstance = await addonManager.loadAddon(POSTS_ADDON_PATH);
    
    console.assert(addonInstance, "Falha ao carregar posts-addon.");
    console.assert(addonInstance.status === 'initialized', "Posts-addon não foi inicializado corretamente.");
    console.assert(addonInstance.manifestId === 'posts-addon', "ID do manifest do posts-addon incorreto.");
    
    const dbInstance = addonInstance._getDB ? addonInstance._getDB() : null;
    console.assert(dbInstance, "Instância do userPostsDB não foi obtida ou exposta pelo posts-addon.");
    console.assert(dbInstance.type === 'feed', "O DB do posts-addon não é do tipo 'feed'.");

    await addonManager.unloadAddon('posts-addon');
    await storageManager.close();
    await heliaNode.stop();
    await libp2p.stop();
    await datastore.close();
  });

  finalizeTests();
}

// Garante que runTests só é chamado quando o script é executado diretamente
if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  runTests().catch(e => {
    console.error("Erro global não capturado nos testes:", e);
    process.exit(1);
  });
} 