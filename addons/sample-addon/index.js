export default {
  manifest: {
    id: 'sample-addon',
    name: 'Sample Addon',
    version: '0.0.1',
    description: 'A simple addon for testing dynamic loading.',
    permissions: ['core:log', 'core:storage:scoped'] // Adicionada permissão de storage
  },
  async initialize(coreApi, addonContext) {
    const currentAddonId = addonContext.id; // addonContext sempre será passado

    coreApi.log(`Sample Addon (ID: ${currentAddonId}): Initializing with context...`);
    coreApi.log(`Sample Addon (ID: ${currentAddonId}): CoreAPI Addon ID: ${coreApi.addonId}`);

    const peerId = coreApi.getPeerId(); 
    coreApi.log(`Sample Addon (ID: ${currentAddonId}): Got PeerId from CoreAPI: ${peerId}`);
    
    const eventBus = coreApi.getEventBus();
    eventBus.emit(`addon:${currentAddonId}:initialized`, { peerId, addonId: currentAddonId });
    coreApi.log(`Sample Addon (ID: ${currentAddonId}): 'addon:${currentAddonId}:initialized' event emitted.`);

    // Testar storage escopado
    let dbValue = null;
    try {
      coreApi.log(`Sample Addon (ID: ${currentAddonId}): Tentando obter DB escopado 'addon-settings'...`);
      const settingsDB = await coreApi.storageGetScopedDB('addon-settings');
      if (settingsDB) {
        coreApi.log(`Sample Addon (ID: ${currentAddonId}): DB 'addon-settings' obtido. Endereço: ${settingsDB.address}`);
        await settingsDB.put('testKey', 'testValueFromSampleAddon');
        coreApi.log(`Sample Addon (ID: ${currentAddonId}): Valor 'testValueFromSampleAddon' salvo em 'testKey'.`);
        dbValue = await settingsDB.get('testKey');
        coreApi.log(`Sample Addon (ID: ${currentAddonId}): Valor lido de 'testKey': ${dbValue}`);
        // Não fechar o DB aqui, pois o StorageManager pode gerenciá-lo.
      } else {
        coreApi.log(`Sample Addon (ID: ${currentAddonId}): Falha ao obter DB escopado 'addon-settings'. Provavelmente permissão negada ou erro.`);
      }
    } catch (e) {
      coreApi.log(`Sample Addon (ID: ${currentAddonId}): Erro ao usar storageGetScopedDB: ${e.message}`);
    }

    return { 
      status: 'initialized', 
      message: 'Sample Addon initialized successfully!',
      manifestId: this.manifest.id,
      getAddonIdFromContext: () => addonContext.id,
      callMe: () => `Hello from Sample Addon (${currentAddonId})!`,
      getDbTestValue: () => dbValue,
      checkLogPermission: () => coreApi.hasPermission('core:log')
    };
  },
  async terminate(coreApi, addonContext) { 
    const currentAddonId = addonContext.id;
    if (coreApi && typeof coreApi.log === 'function') {
      coreApi.log(`Sample Addon (ID: ${currentAddonId}): Terminating with context...`);
    }
    return { status: 'terminated', message: `Sample Addon ${currentAddonId} terminated.` };
  }
}; 