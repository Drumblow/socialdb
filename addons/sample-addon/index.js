export default {
  manifest: {
    id: 'sample-addon',
    name: 'Sample Addon',
    version: '0.0.1',
    description: 'A simple addon for testing dynamic loading.',
    permissions: [] // ex: ['storage:read', 'network:send']
  },
  async initialize(coreApi) {
    coreApi.log(`Sample Addon (ID: ${this.manifest.id}): Initializing...`);
    const peerId = await coreApi.getPeerId();
    coreApi.log(`Sample Addon (ID: ${this.manifest.id}): Got PeerId: ${peerId}`);
    
    // Exemplo de uso do eventBus da CoreAPI
    const eventBus = coreApi.getEventBus();
    eventBus.emit('addon:sample-addon:initialized', { peerId });
    coreApi.log(`Sample Addon (ID: ${this.manifest.id}): 'addon:sample-addon:initialized' event emitted.`);

    return { 
      status: 'initialized', 
      message: 'Sample Addon initialized successfully!',
      manifestId: this.manifest.id,
      callMe: () => `Hello from Sample Addon (${this.manifest.id})!`
    };
  },
  async terminate() {
    console.log(`Sample Addon (ID: ${this.manifest.id}): Terminating...`);
    // Lógica de limpeza do addon, se necessário
    return { status: 'terminated', message: 'Sample Addon terminated.' };
  }
}; 