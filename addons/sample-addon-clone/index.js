export default {
  manifest: {
    id: 'sample-addon-clone', // ID Diferente
    name: 'Sample Addon Clone',
    version: '0.0.1',
    description: 'A clone addon for testing storage scoping.',
    permissions: ['core:log', 'core:storage:scoped'] // Mesmas permissões
  },
  async initialize(coreApi, addonContext) {
    const currentAddonId = addonContext.id;
    coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Initializing...`);

    let dbValueClone = null;
    let originalDbValueAttempt = undefined; // Para testar leitura de chave do outro addon

    try {
      const settingsDB = await coreApi.storageGetScopedDB('addon-settings'); // Mesmo nome interno de DB
      if (settingsDB) {
        coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): DB 'addon-settings' obtido. Address: ${settingsDB.address}`);
        
        // Escreve um valor diferente
        await settingsDB.put('cloneTestKey', 'testValueFromCloneAddon');
        coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Valor 'testValueFromCloneAddon' salvo em 'cloneTestKey'.`);
        dbValueClone = await settingsDB.get('cloneTestKey');
        coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Valor lido de 'cloneTestKey': ${dbValueClone}`);

        // Tenta ler a chave que o sample-addon original escreveu
        originalDbValueAttempt = await settingsDB.get('testKey'); // 'testKey' é do sample-addon original
        if (originalDbValueAttempt !== undefined) {
            coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): ATENÇÃO! Leu valor '${originalDbValueAttempt}' da chave 'testKey' do sample-addon original! DBs podem não estar escopados.`);
        } else {
            coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Corretamente não encontrou valor para 'testKey' do sample-addon original.`);
        }

      } else {
        coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Falha ao obter DB escopado 'addon-settings'.`);
      }
    } catch (e) {
      coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Erro ao usar storageGetScopedDB: ${e.message}`);
    }

    return {
      status: 'initialized',
      manifestId: this.manifest.id,
      getDbTestValueClone: () => dbValueClone,
      getOriginalDbTestValue: () => originalDbValueAttempt, // Para o teste verificar se a leitura cruzada falhou (retornou undefined)
      callMe: () => `Hello from Sample Addon Clone (${currentAddonId})!`,
      checkLogPermission: () => coreApi.hasPermission('core:log')
    };
  },
  async terminate(coreApi, addonContext) {
    const currentAddonId = addonContext.id;
    if (coreApi && typeof coreApi.log === 'function') {
      coreApi.log(`Sample Addon Clone (ID: ${currentAddonId}): Terminating...`);
    }
    return { status: 'terminated' };
  }
}; 