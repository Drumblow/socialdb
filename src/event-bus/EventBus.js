export class EventBus {
  constructor() {
    this.listeners = {};
    console.log("EVENT_BUS: Instância criada.");
  }

  /**
   * Registra um listener para um determinado evento.
   * @param {string} eventName O nome do evento.
   * @param {Function} callback A função a ser chamada quando o evento é emitido.
   */
  on(eventName, callback) {
    if (typeof callback !== 'function') {
      console.error(`EventBus: Tentativa de registrar um callback não-função para o evento "${eventName}".`);
      return;
    }
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
    // console.log(`EVENT_BUS_DEBUG: Listener adicionado para ${eventName}`);
  }

  /**
   * Remove um listener específico de um evento.
   * @param {string} eventName O nome do evento.
   * @param {Function} callback A função callback a ser removida.
   */
  off(eventName, callback) {
    if (!this.listeners[eventName]) {
      return;
    }
    this.listeners[eventName] = this.listeners[eventName].filter(
      listener => listener !== callback
    );
    // console.log(`EVENT_BUS_DEBUG: Listener removido para ${eventName}`);
  }

  /**
   * Emite um evento, chamando todos os listeners registrados para ele.
   * @param {string} eventName O nome do evento a ser emitido.
   * @param  {...any} data Os dados a serem passados para os listeners.
   */
  emit(eventName, ...data) {
    if (!this.listeners[eventName]) {
      // console.log(`EVENT_BUS_DEBUG: Evento ${eventName} emitido, mas sem listeners.`);
      return;
    }
    // console.log(`EVENT_BUS_DEBUG: Emitindo evento ${eventName} com dados:`, data);
    this.listeners[eventName].forEach(listener => {
      try {
        listener(...data);
      } catch (error) {
        console.error(`EventBus: Erro no listener para o evento "${eventName}":`, error.message);
        if (error.stack) console.error(error.stack);
      }
    });
  }

  /**
   * Remove todos os listeners para um evento específico, ou todos os listeners de todos os eventos se nenhum nome de evento for fornecido.
   * @param {string} [eventName] O nome do evento para o qual remover os listeners.
   */
  removeAllListeners(eventName) {
    if (eventName) {
      if (this.listeners[eventName]) {
        // console.log(`EVENT_BUS_DEBUG: Removendo todos os listeners para ${eventName}`);
        delete this.listeners[eventName];
      }
    } else {
      // console.log("EVENT_BUS_DEBUG: Removendo todos os listeners de todos os eventos.");
      this.listeners = {};
    }
  }

  /**
   * Retorna o número de listeners para um dado evento.
   * @param {string} eventName O nome do evento.
   * @returns {number} O número de listeners.
   */
  listenerCount(eventName) {
    return this.listeners[eventName] ? this.listeners[eventName].length : 0;
  }
} 