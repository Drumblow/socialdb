export default {
  manifest: {
    id: 'no-log-permission-addon',
    name: 'No Log Permission Addon',
    version: '0.0.1',
    description: 'A simple addon to test denied log permission.',
    permissions: [] // Nenhuma permissão
  },
  async initialize(coreApi, addonContext) {
    const addonId = addonContext.id;
    // Tenta logar, mas não deve conseguir
    coreApi.log(`NoLogPermissionAddon [${addonId}]: Attempting to log (should be blocked).`);
    
    // Tenta chamar hasPermission diretamente para ver o resultado
    const canLog = coreApi.hasPermission('core:log');
    if (canLog) {
        // Este é um log de erro direto do addon, não via CoreAPI, para indicar falha no teste
        console.error(`ADDON_ERROR NoLogPermissionAddon [${addonId}]: hasPermission('core:log') returned true, but it should be false.`);
    } else {
        // Este console.log é do addon, não da CoreAPI, então não será bloqueado.
        console.log(`ADDON_LOG NoLogPermissionAddon [${addonId}]: hasPermission('core:log') correctly returned false.`);
    }

    return {
      status: 'initialized',
      manifestId: addonId,
      idFromContext: addonContext.id,
      checkLogPermission: () => coreApi.hasPermission('core:log')
    };
  },
  async terminate(coreApi, addonContext) {
    // console.log(`NoLogPermissionAddon [${addonContext.id}]: Terminating.`);
    return { status: 'terminated' };
  }
}; 