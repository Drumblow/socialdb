export class EventBus {
  constructor() {
    console.log("EVENT_BUS: EventBus instanciado (placeholder).");
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
    console.log(`EVENT_BUS: Listener adicionado para o evento: ${event}`);
  }

  emit(event, data) {
    console.log(`EVENT_BUS: Emitindo evento: ${event} com dados:`, data);
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (e) {
          console.error(`EVENT_BUS: Erro ao executar callback para o evento ${event}:`, e);
        }
      });
    }
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
      console.log(`EVENT_BUS: Listener removido para o evento: ${event}`);
    }
  }
} 